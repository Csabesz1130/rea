// REA's facts for a few files of a package: where its parse finds a call, a
// load or an evaluation, so the sketch can tell a text match in a string, a
// regex, a comment or a definition from code that runs. REA reports each
// call, load and evaluation where it starts: a bare eval, require or import()
// at its first word, and a process function called bare at its name.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applicationFacts } from "../../release-watch/src/facts/application.mjs";
import { partlyExamined } from "../../release-watch/src/facts/coverage.mjs";
import {
  analysisSettings,
  reaAnalysisArguments,
} from "../../release-watch/src/limits.mjs";
import { createRea, resolveReaCommand } from "../../release-watch/src/rea.mjs";

const SITE_KINDS = ["localSites", "externalSites", "unresolvedSites"];

/**
 * The largest file the sketch has REA analyze, as measured at standard
 * depth: of real package files analyzed alone, REA examined every one up
 * to 602 KB in full, and for every one from 719 KB to 2.6 MB its semantic
 * graph exceeded REA's result budget after 17 to 48 s, so REA recorded a
 * failure and could rule nothing out there.
 */
export const REA_FULL_FILE_BYTES = 640 * 1024;

// Where each line of a text starts, as an offset in UTF-16 code units, the
// unit of both REA's columns and the scan's. The scan's lines end at "\n";
// REA's, as ECMAScript's, at "\r\n", "\r", "\n", U+2028 and U+2029, so a
// file with a lone "\r" or either separator numbers its lines differently.
const SCAN_LINE_END = /\n/g;
const ECMASCRIPT_LINE_END = /\r\n|[\r\n\u2028\u2029]/g;
const lineStarts = (text, ends) => [
  0,
  ...[...text.matchAll(ends)].map((match) => match.index + match[0].length),
];

// Every load site of the import index, whatever it resolved to.
const loadSites = (app) =>
  [...app.modules.values()].flatMap((entry) =>
    SITE_KINDS.flatMap((kind) =>
      entry[kind] instanceof Map
        ? [...entry[kind].values()].flat()
        : (entry[kind] ?? []),
    ),
  );

// Where REA's parse finds a call, a load or an evaluation start, as `{ file,
// line, column }` in REA's numbering.
const starts = (app) => [
  ...app.callSites.map(({ module, range }) => ({
    file: module,
    ...range.start,
  })),
  ...[...app.dynamicEvaluation, ...app.dynamicCalls, ...loadSites(app)]
    .map((fact) => fact.location)
    .filter((location) => location?.line !== undefined),
];

/**
 * Run REA's application analysis on `files` of the package at `root`,
 * copied with their paths (and the package's package.json, for its module
 * type) into a fresh directory, at standard depth. Resolves to `{ ok: true,
 * evidence_id, examined(file), startsAt(file, line, column) }`: whether REA
 * analyzed a file in full (Release Watch's coverage: a complete parse, no
 * node limit and no failure there), and whether its parse finds a call, a
 * load or an evaluation starting at a line and column of the scan's (lines
 * 1-based, ending at "\n"; columns 0-based); or `{ ok: false, error }`.
 * Imports between the copied files and the rest of the package go
 * unresolved, which only adds facts; it never removes one.
 */
export const reaFacts = async (root, files) => {
  const copy = mkdtempSync(path.join(tmpdir(), "proof-swarm-rea-"));
  try {
    for (const file of ["package.json", ...files]) {
      if (!existsSync(path.join(root, file))) continue;
      mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      cpSync(path.join(root, file), path.join(copy, file));
    }
    const result = await createRea(resolveReaCommand()).run(
      "analyze-javascript-application",
      [copy, ...reaAnalysisArguments(analysisSettings({ depth: "standard" }))],
    );
    if (!result.ok) return { ok: false, error: result.error };
    const app = applicationFacts(result.evidence);
    const partly = partlyExamined(app);
    const analyzed = new Set(app.assets.map((asset) => asset.key));
    // Both numberings map to offsets in the same text: the bytes REA read.
    const texts = new Map(
      files.map((file) => [file, readFileSync(path.join(copy, file), "utf8")]),
    );
    const offsets = (ends) =>
      new Map([...texts].map(([file, text]) => [file, lineStarts(text, ends)]));
    const scanLines = offsets(SCAN_LINE_END);
    const reaLines = offsets(ECMASCRIPT_LINE_END);
    const found = new Set(
      starts(app)
        .filter(({ file, line }) => reaLines.get(file)?.[line - 1] >= 0)
        .map(
          ({ file, line, column }) =>
            `${file}:${reaLines.get(file)[line - 1] + column}`,
        ),
    );
    return {
      ok: true,
      evidence_id: result.evidence.evidence_id ?? null,
      examined: (file) => analyzed.has(file) && !partly(file),
      startsAt: (file, line, column) => {
        const start = scanLines.get(file)?.[line - 1];
        return start !== undefined && found.has(`${file}:${start + column}`);
      },
    };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};
