// The deterministic check of one claim about one package: can code an MCP
// tool runs start a process, and through a shell? An agent writes the
// claim; the check accepts it only when everything it cites is in the
// package's shipped text. It checks text, not meaning: each cited line is
// in a running file and holds the quoted text; a "yes" path starts at a
// tool registration, links every call to a definition of the name it calls
// and ends at a process call; a "no" cites every file and line the scan
// finds. Whether the path is really taken is an adversarial reviewer's
// question (README.md).
import path from "node:path";

import {
  CHILD_PROCESS_RECEIVER,
  PROCESS_CALL,
  REGISTRATION,
  linesOf,
  runningFiles,
  scan,
} from "./scan.mjs";

const VERDICTS = ["yes", "no", "undetermined"];
const MIN_QUOTE = 6;
const MAX_QUOTE = 400;
const MIN_REASON = 10;
const MAX_LISTED = 40;
const SHELL_WINDOW = 5;

// exec and execSync always run their command in a shell; spawn and execFile
// only with a shell option that is not false (Node.js documentation). An
// option set from a variable counts: it can be true. exec counts bare, on a
// child_process receiver or through an import wrapper, as PROCESS_CALL
// reads it; execSync on any receiver.
const SHELL = new RegExp(
  [
    String.raw`(?:^|[^.\w$])exec(?:Sync)?\s*\(`,
    String.raw`\.execSync\s*\(`,
    String.raw`(?:${CHILD_PROCESS_RECEIVER}|\bcp)\.exec\s*\(`,
    String.raw`\.exec(?:Sync)?\s*\)\s*\(`,
    String.raw`shell\s*:\s*(?!false\b|!1\b)(?:true|!0|[\w$.]+)`,
  ].join("|"),
);

const normalize = (text) => text.replace(/\s+/g, " ").trim();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasReason = (text) =>
  typeof text === "string" && text.trim().length >= MIN_REASON;
const relative = (file) =>
  path.posix.normalize(String(file ?? "").replace(/^\.\//, ""));

const definesName = (content, name) => {
  const id = escapeRegExp(name);
  return new RegExp(
    [
      `function\\s*\\*?\\s*${id}\\s*\\(`,
      `(?:^|[^\\w$.])${id}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|[\\w$]+\\s*=>)`,
      `(?:^|[^\\w$.])(?:async\\s+)?${id}\\s*\\([^)]*\\)\\s*\\{`,
      `class\\s+${id}\\b`,
    ].join("|"),
  ).test(content);
};

const callsName = (content, name) =>
  new RegExp(
    `(?:^|[^\\w$])${escapeRegExp(name)}\\s*(?:\\(|\`|\\.(?:call|apply|bind)\\s*\\()`,
  ).test(content);

// Why a cited place does not hold, or null when it does.
const placeProblem = (context, cited) => {
  if (
    typeof cited?.file !== "string" ||
    !Number.isInteger(cited?.line) ||
    typeof cited?.text !== "string"
  )
    return "needs file, an integer line and text";
  const file = relative(cited.file);
  if (path.posix.isAbsolute(file) || file.startsWith(".."))
    return `${cited.file} is not a path inside the package`;
  if (!context.running.has(file))
    return `${file} is not a running file of the package (missing, a test or a declaration)`;
  const lines = linesOf(context.root, file);
  if (cited.line < 1 || cited.line > lines.length)
    return `${file} has ${lines.length} lines, not ${cited.line}`;
  const quoted = normalize(cited.text);
  if (quoted.length < MIN_QUOTE || quoted.length > MAX_QUOTE)
    return `quote ${MIN_QUOTE} to ${MAX_QUOTE} characters of the line`;
  if (!normalize(lines[cited.line - 1]).includes(quoted))
    return `${file}:${cited.line} does not contain "${quoted.slice(0, 80)}"`;
  return null;
};

/** One cited place, checked: `{ file, content }`, or null with the error recorded. */
const place = (context, cited, where) => {
  const problem = placeProblem(context, cited);
  if (problem !== null) {
    context.errors.push(`${where}: ${problem}`);
    return null;
  }
  const file = relative(cited.file);
  return {
    file,
    content: normalize(linesOf(context.root, file)[cited.line - 1]),
  };
};

const checkEnds = (context, label, first, last) => {
  const { errors } = context;
  if (first.hop.role !== "registration")
    errors.push(`${label}: the first hop must be the tool registration`);
  else if (first.cited && !REGISTRATION.test(first.cited.content))
    errors.push(
      `${label}: ${first.cited.file}:${first.hop.line} registers no MCP tool the check recognizes`,
    );
  if (last.hop.role !== "process")
    errors.push(`${label}: the last hop must be the process call`);
  else if (
    last.cited &&
    !PROCESS_CALL.test(last.cited.content) &&
    !context.capable.has(last.cited.file)
  )
    errors.push(
      `${label}: ${last.cited.file}:${last.hop.line} holds no process call, and its file loads no process module`,
    );
};

// Every call hop calls its name, and a later hop defines it; every
// definition hop is reached by an earlier call.
const checkLinks = (context, label, checked) => {
  const { errors } = context;
  for (const { hop, at, cited } of checked) {
    if (!cited || typeof hop.calls !== "string") continue;
    if (!callsName(cited.content, hop.calls))
      errors.push(
        `${label} hop ${at + 1}: ${cited.file}:${hop.line} does not call ${hop.calls}`,
      );
    const definition = checked
      .slice(at + 1)
      .find((next) => next.hop.defines === hop.calls);
    if (!definition)
      errors.push(`${label} hop ${at + 1}: no later hop defines ${hop.calls}`);
    else if (
      definition.cited &&
      !definesName(definition.cited.content, hop.calls)
    )
      errors.push(
        `${label} hop ${definition.at + 1}: ${definition.cited.file}:${definition.hop.line} does not define ${hop.calls}`,
      );
  }
  for (const { hop, at } of checked)
    if (
      hop.role === "definition" &&
      !checked.slice(0, at).some((prior) => prior.hop.calls === hop.defines)
    )
      errors.push(
        `${label} hop ${at + 1}: nothing earlier on the path calls ${hop.defines ?? "(no name)"}`,
      );
};

const checkPath = (context, route, index) => {
  const label = `path ${index + 1}`;
  const hops = Array.isArray(route?.hops) ? route.hops : [];
  if (hops.length < 2) {
    context.errors.push(
      `${label}: needs at least a registration and a process call`,
    );
    return;
  }
  const checked = hops.map((hop, at) => ({
    hop,
    at,
    cited: place(context, hop, `${label} hop ${at + 1}`),
  }));
  checkEnds(context, label, checked[0], checked.at(-1));
  checkLinks(context, label, checked);
};

// A shell yes: some path's process call runs exec or execSync, or passes a
// shell option within the next lines of its call.
const checkShell = (context, paths) => {
  const shelled = paths
    .map((route) => route?.hops?.at(-1))
    .filter(Boolean)
    .some((hop) => {
      const file = relative(hop.file);
      return (
        context.running.has(file) &&
        linesOf(context.root, file)
          .slice(Math.max(0, hop.line - 1), hop.line + SHELL_WINDOW)
          .some((line) => SHELL.test(line))
      );
    });
  if (!shelled)
    context.errors.push(
      "shell yes: no cited process call runs exec or execSync or passes a shell option",
    );
};

const checkYes = (context) => {
  const paths = Array.isArray(context.claim.paths) ? context.claim.paths : [];
  if (paths.length === 0)
    context.errors.push(
      "a yes needs at least one path from a tool registration to a process call",
    );
  paths.forEach((route, index) => checkPath(context, route, index));
  if (context.claim.shell === "yes") checkShell(context, paths);
};

// A no cites every candidate line and every process-capable file the scan
// finds, each with a reason no tool reaches it, and says why code loaded
// at runtime cannot either.
const checkNo = (context) => {
  const { claim, errors, found } = context;
  const sites = Array.isArray(claim.process_sites) ? claim.process_sites : [];
  const placed = sites.map((site, index) => ({
    site,
    cited: place(context, site, `process site ${index + 1}`),
  }));
  for (const { site } of placed)
    if (!hasReason(site.why))
      errors.push(
        `process site ${site.file}:${site.line}: a no needs a reason no tool starts a process there`,
      );
  const cited = new Set(
    placed
      .filter((entry) => entry.cited)
      .map(({ cited: at, site }) => `${at.file}:${site.line}`),
  );
  const missing = found.candidates.filter(
    ({ file, line }) => !cited.has(`${file}:${line}`),
  );
  for (const { file, line } of missing.slice(0, MAX_LISTED))
    errors.push(`unaccounted candidate process call at ${file}:${line}`);
  if (missing.length > MAX_LISTED)
    errors.push(
      `and ${missing.length - MAX_LISTED} more unaccounted candidate process calls`,
    );
  for (const [file, entry] of context.capable)
    if (!placed.some((item) => item.cited?.file === file))
      errors.push(
        `unaccounted process-capable file ${file} (it loads ${entry.imports.map((item) => item.specifier).join(", ")})`,
      );
  if (found.runtimeCode.length === 0) return;
  context.warnings.push(
    `${found.runtimeCode.length} lines load or evaluate code at runtime, such as ${found.runtimeCode
      .slice(0, 3)
      .map(({ file, line }) => `${file}:${line}`)
      .join(", ")}`,
  );
  if (!hasReason(claim.residual))
    errors.push(
      "a no in code that loads or evaluates code at runtime must say in residual why that cannot start a process from a tool",
    );
};

const checkShape = (context) => {
  const { claim, errors } = context;
  if (!VERDICTS.includes(claim?.verdict))
    errors.push("verdict must be yes, no or undetermined");
  if (!VERDICTS.includes(claim?.shell))
    errors.push("shell must be yes, no or undetermined");
  if (!Array.isArray(claim?.hint_sequence) || claim.hint_sequence.length === 0)
    errors.push(
      "hint_sequence: list the insights that settled the question, in order",
    );
};

/**
 * Check one claim against the package at `root`: `{ status, errors,
 * warnings, scan }`, status "pass" when nothing is wrong. `scan` summarizes
 * what the claim had to account for.
 */
export const checkClaim = (root, claim) => {
  const found = scan(root);
  const context = {
    root,
    claim: claim ?? {},
    errors: [],
    warnings: [],
    found,
    running: new Set(runningFiles(root)),
    capable: new Map(found.capable.map((entry) => [entry.file, entry])),
  };
  checkShape(context);
  if (context.claim.verdict === "yes") checkYes(context);
  if (context.claim.verdict === "no") checkNo(context);
  if (
    context.claim.verdict === "undetermined" &&
    !hasReason(context.claim.residual)
  )
    context.errors.push(
      "an undetermined verdict must say in residual what blocks a decision",
    );
  return {
    status: context.errors.length === 0 ? "pass" : "fail",
    errors: context.errors,
    warnings: context.warnings,
    scan: {
      files: found.files,
      process_capable_files: found.capable.length,
      candidate_calls: found.candidates.length,
      runtime_code: found.runtimeCode.length,
    },
  };
};
