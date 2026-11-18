// The coarse-to-fine sketch of a package, in the shape of next-concept
// modeling (Kumbong et al., arXiv:2610.14162): a few levels from the whole
// package down to lines, each listing only what the coarser levels leave
// open, so an agent reads it coarse to fine and stops where its question is
// settled. Level 0 settles a package outright when nothing that can run
// starts a process. Like the scan, it reads the package's text and runs,
// imports or installs nothing from it.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { REGISTRATION, linesOf, loadsOf, runningFiles, scan } from "./scan.mjs";
import { REA_FULL_FILE_BYTES, reaFacts } from "./rea-facts.mjs";

// Node's extension and index probing, broadened to the extensionless
// specifiers bundlers and compilers leave behind. Reaching more files than
// Node would only keeps more of the package open.
const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".json", ".node"];
const INDEXES = ["index.js", "index.mjs", "index.cjs", "index.json"];
const NATIVE = /\.node$/;
const SCRIPT = /\.[cm]?js$/;
const WORKER = /\bnew\s+Worker\s*\(/;

const isFile = (file) => existsSync(file) && statSync(file).isFile();
const isDirectory = (file) => existsSync(file) && statSync(file).isDirectory();
const posix = (file) => file.split(path.sep).join("/");
const leaves = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(leaves)
      : [];

const readManifest = (directory) => {
  try {
    return JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    );
  } catch {
    return {};
  }
};

// The package-relative file a relative specifier names, or null when it
// names none or leaves the package.
const resolve = (root, fromDirectory, specifier) => {
  const target = path.resolve(root, fromDirectory, specifier);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  const file = EXTENSIONS.map((extension) => target + extension).find(isFile);
  if (file) return posix(path.relative(root, file));
  if (!isDirectory(target)) return null;
  const main = readManifest(target).main;
  if (typeof main === "string") {
    const hit = resolve(root, path.relative(root, target), `./${main}`);
    if (hit) return hit;
  }
  const index = INDEXES.map((name) => path.join(target, name)).find(isFile);
  return index ? posix(path.relative(root, index)) : null;
};

// Every target an exports or imports map names. A subpath pattern ("*")
// stands for each shipped file it matches.
const mapTargets = (root, value, files) =>
  leaves(value)
    .filter((target) => target.startsWith("./"))
    .flatMap((target) => {
      if (!target.includes("*")) return [resolve(root, ".", target)];
      const pattern = new RegExp(
        `^${target
          .slice(2)
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".+")}$`,
      );
      return [...files].filter((file) => pattern.test(file));
    });

/**
 * The files a package's entry points name: bin, main and module (with or
 * without "./"), every exports target, and index.js when neither main nor
 * exports is declared, as Node defaults. Declarations and data never run.
 */
const entryPoints = (root, files) => {
  const manifest = readManifest(root);
  const relative = (target) =>
    resolve(root, ".", target.startsWith(".") ? target : `./${target}`);
  const named = [
    ...leaves(manifest.bin).map(relative),
    ...leaves(manifest.main).map(relative),
    ...leaves(manifest.module).map(relative),
    ...mapTargets(root, manifest.exports, files),
    ...(manifest.main === undefined && manifest.exports === undefined
      ? [resolve(root, ".", "./index.js")]
      : []),
  ];
  return [...new Set(named.filter(Boolean))].filter(
    (file) => files.has(file) || NATIVE.test(file),
  );
};

// A bare specifier names another package or a built-in, which this
// package does not ship, except one that names the package itself: that
// resolves through the package's own exports, or main for the bare name.
const isOwnName = (specifier, name) =>
  typeof name === "string" &&
  (specifier === name || specifier.startsWith(`${name}/`));

const ownTargets = (root, manifest, specifier, files) => {
  const subpath =
    specifier === manifest.name
      ? "."
      : `./${specifier.slice(manifest.name.length + 1)}`;
  const map = manifest.exports;
  const conditions =
    typeof map === "string" ||
    Array.isArray(map) ||
    (map && Object.keys(map).every((key) => !key.startsWith(".")));
  const value =
    map === undefined
      ? subpath === "."
        ? `./${String(manifest.main ?? "index.js").replace(/^\.\//, "")}`
        : undefined
      : conditions
        ? subpath === "."
          ? map
          : undefined
        : map[subpath];
  return value === undefined ? [] : mapTargets(root, value, files);
};

const importsOf = (root, file, manifest, files) =>
  loadsOf(root, file).specifiers.flatMap((specifiers, index) =>
    specifiers.map((specifier) => {
      const line = index + 1;
      if (specifier.startsWith("#")) {
        const targets = mapTargets(root, manifest.imports?.[specifier], files);
        return targets.length > 0 && targets.every(Boolean)
          ? { targets }
          : { escape: { file, line, kind: "unresolved subpath import" } };
      }
      if (isOwnName(specifier, manifest.name)) {
        const targets = ownTargets(root, manifest, specifier, files);
        return targets.length > 0 && targets.every(Boolean)
          ? { targets }
          : {
              escape: {
                file,
                line,
                kind: "unresolved import of the package itself",
              },
            };
      }
      if (!specifier.startsWith(".")) return { targets: [] };
      const target = resolve(root, path.dirname(file), specifier);
      return target
        ? { targets: [target] }
        : { escape: { file, line, kind: "unresolved import" } };
    }),
  );

// Why a reached file needs a closer look, or null: native code, and scripts
// the scan leaves out (named as tests), run all the same.
const unscanned = (file, files) =>
  NATIVE.test(file)
    ? "native addon"
    : SCRIPT.test(file) && !files.has(file)
      ? "loads a script the scan leaves out"
      : null;

/**
 * What the entry points can load through literal imports: `reached`, the
 * files, `running`, how many of them are scripts the scan reads, and
 * `escapes`, the lines through which code outside it could still run:
 * imports the sketch cannot resolve, native addons, scripts the scan leaves
 * out, code loaded or evaluated at runtime and workers started from a path.
 */
const closure = (root, entries, files, runtimeCode) => {
  const manifest = readManifest(root);
  const reached = new Set();
  const escapes = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (reached.has(file)) continue;
    reached.add(file);
    const why = unscanned(file, files);
    if (why) {
      escapes.push({ file, line: null, kind: why });
      continue;
    }
    if (!files.has(file)) continue;
    for (const found of importsOf(root, file, manifest, files)) {
      if (found.escape) escapes.push(found.escape);
      else
        queue.push(...found.targets.filter((target) => !reached.has(target)));
    }
  }
  for (const site of runtimeCode)
    if (reached.has(site.file))
      escapes.push({ ...site, kind: "code loaded or evaluated at runtime" });
  for (const file of [...reached].filter((item) => files.has(item)))
    linesOf(root, file).forEach((text, index) => {
      if (WORKER.test(text))
        escapes.push({
          file,
          line: index + 1,
          kind: "worker started from a path",
        });
    });
  const running = [...reached].filter((file) => files.has(file)).length;
  return { reached, running, escapes };
};

const text = (root, site) =>
  site.line === null
    ? null
    : linesOf(root, site.file)[site.line - 1].trim().slice(0, 160);

/**
 * What a package's text says: the scan, the running files, the entry
 * points, what they reach through literal imports (every running file when
 * there is no entry point, since any of them may then run) and where tools
 * are registered.
 */
const read = (root) => {
  const found = scan(root);
  const list = runningFiles(root);
  const files = new Set(list);
  const entries = entryPoints(root, files);
  const reach = closure(
    root,
    entries.length > 0 ? entries : list,
    files,
    found.runtimeCode,
  );
  const tools = list.flatMap((file) =>
    linesOf(root, file).flatMap((line, index) =>
      REGISTRATION.test(line) ? [{ file, line: index + 1 }] : [],
    ),
  );
  return { root, found, files, entries, reach, tools };
};

// Level 0: the whole package, and its answer when nothing that can run
// starts a process: no process-capable file and no candidate call is
// reached, and nothing reached loads code another way. `open` holds the
// escapes and candidate calls still open, after any REA discharged.
const packageLevel = ({ found, entries, reach, tools }, open) => {
  const head = {
    files: found.files,
    entry_points: entries.length,
    reached: reach.running,
    process_capable_files: found.capable.length,
    candidate_calls: found.candidates.length,
    runtime_code: found.runtimeCode.length,
    escapes: open.escapes.length,
    tool_registrations: tools.length,
    basis: open.rea ? "scan and REA" : "scan",
    ...(open.rea ? { rea: open.rea } : {}),
  };
  const reached = ({ file }) => reach.reached.has(file);
  if (
    found.capable.some(reached) ||
    open.candidates.some(reached) ||
    open.escapes.length > 0
  )
    return { ...head, verdict: "open" };
  return {
    ...head,
    verdict: "no",
    why:
      found.capable.length + open.candidates.length === 0
        ? "nothing in the shipped files can start a process: no file loads a process module or library, no line calls a process function, and nothing that runs loads code another way"
        : "every process-capable file and candidate process call is outside what the entry points load through literal imports, and nothing they load can load code another way",
  };
};

// Level 2: the files a question about process reach turns on.
const fileLevel = ({ found, reach, tools }, open) => {
  const files = new Map();
  const at = (file) => {
    if (!files.has(file))
      files.set(file, {
        file,
        reached: reach.reached.has(file),
        loads: [],
        candidate_calls: 0,
        tool_registrations: 0,
      });
    return files.get(file);
  };
  for (const { file, imports } of found.capable)
    at(file).loads.push(...new Set(imports.map((item) => item.specifier)));
  for (const { file } of open.candidates) at(file).candidate_calls += 1;
  for (const { file } of tools) at(file).tool_registrations += 1;
  return [...files.values()].sort(
    (a, b) =>
      Number(b.reached) - Number(a.reached) || a.file.localeCompare(b.file),
  );
};

const levelsOf = (state, open) => {
  const { root, entries, reach, tools } = state;
  const head = packageLevel(state, open);
  const unsettled = head.verdict === "open";
  const reached = ({ file }) => reach.reached.has(file);
  const lines = [
    ...open.escapes.map((site) => ({ ...site, text: text(root, site) })),
    ...open.candidates.filter(reached).map((site) => ({
      ...site,
      kind: "candidate call",
      text: text(root, site),
    })),
    ...tools.filter(reached).map((site) => ({
      ...site,
      kind: "tool registration",
      text: text(root, site),
    })),
  ];
  return {
    levels: [
      { level: 0, name: "package", positions: [head] },
      { level: 1, name: "entry points", positions: unsettled ? entries : [] },
      {
        level: 2,
        name: "files",
        positions: unsettled ? fileLevel(state, open) : [],
      },
      { level: 3, name: "lines", positions: unsettled ? lines : [] },
    ],
  };
};

/**
 * The sketch of the package at `root`: `{ levels }`, levels 0 to 3, each a
 * `{ level, name, positions }`. Level 0 is the package with its verdict
 * ("no" or "open") and its basis; level 1 its entry points; level 2 the
 * files that load a process module or library, call a process function or
 * register a tool, each marked reached or not; level 3 the lines left
 * open: every escape, and the candidate calls and tool registrations in
 * reached files. When level 0 settles the package, levels 1 to 3 are
 * empty.
 */
export const sketch = (root) => {
  const state = read(root);
  return levelsOf(state, {
    escapes: state.reach.escapes,
    candidates: state.found.candidates,
    rea: null,
  });
};

// The forms REA can rule out: a bare eval, require or import(), and a bare
// call of a process function, which REA reports where the match starts.
const positionsOf = (item) =>
  item.kind === "code loaded or evaluated at runtime"
    ? item.forms
    : (item.calls ?? null);

const rulable = (item) => {
  const positions = positionsOf(item);
  return (
    Array.isArray(positions) &&
    positions.length > 0 &&
    positions.every(({ bare }) => bare)
  );
};

/**
 * The sketch with REA's facts. Only when REA's parse could settle the
 * package, because no process-capable file is reached, every escape and
 * reached candidate call is a bare form and every file that holds one is
 * small enough for REA to examine in full (REA_FULL_FILE_BYTES), REA
 * analyzes those files, and an item is discharged when REA examined its
 * file in full and finds no call, load or evaluation starting where the
 * text matched: the match is in a string, a regex, a comment or a
 * definition. Level 0 then records `rea`: the Evidence id, the files REA
 * analyzed and each item it discharged; REA's error; or, for a file too
 * large, why REA was not run.
 */
export const sketchWithRea = async (root) => {
  const state = read(root);
  const { found, reach } = state;
  const reachedCandidates = found.candidates.filter(({ file }) =>
    reach.reached.has(file),
  );
  const items = [...reach.escapes, ...reachedCandidates];
  const plain = {
    escapes: reach.escapes,
    candidates: found.candidates,
    rea: null,
  };
  if (
    items.length === 0 ||
    found.capable.some(({ file }) => reach.reached.has(file)) ||
    !items.every(rulable)
  )
    return levelsOf(state, plain);
  const files = [...new Set(items.map(({ file }) => file))].sort();
  const large = files.filter(
    (file) => statSync(path.join(root, file)).size > REA_FULL_FILE_BYTES,
  );
  if (large.length > 0)
    return levelsOf(state, {
      ...plain,
      rea: {
        files,
        not_run: `REA's semantic graph of a file above ${REA_FULL_FILE_BYTES / 1024} KB exceeds its result budget at standard depth, so it could rule nothing out in ${large.join(", ")}`,
      },
    });
  const facts = await reaFacts(root, files);
  if (!facts.ok)
    return levelsOf(state, { ...plain, rea: { files, error: facts.error } });
  const ruledOut = (item) =>
    facts.examined(item.file) &&
    positionsOf(item).every(
      ({ column }) => !facts.startsAt(item.file, item.line, column),
    );
  const kept = (item) => !ruledOut(item);
  return levelsOf(state, {
    escapes: reach.escapes.filter(kept),
    candidates: found.candidates.filter(
      (item) => !reach.reached.has(item.file) || kept(item),
    ),
    rea: {
      evidence_id: facts.evidence_id,
      files,
      discharged: [
        ...new Map(
          items
            .filter(ruledOut)
            .map(({ file, line }) => [
              `${file}:${line}`,
              { file, line, text: text(root, { file, line }) },
            ]),
        ).values(),
      ],
    },
  });
};
