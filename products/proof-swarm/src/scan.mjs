// What a claim about a package's process reach must account for, read from
// the package's shipped text: the files that load a process module or
// library, every line that may call a process function, and every line that
// loads or evaluates code at runtime. This is a deliberately broad textual
// scan, not REA's reading: it exists to bound what an agent must explain
// where REA's facts could not tell, so it over-reports (RegExp exec on a
// child_process receiver, a local function named spawn) rather than miss.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isTestPath } from "../../landscape/src/catalog.mjs";
import {
  isProcessModule,
  processLibraryOf,
} from "../../release-watch/src/catalog.mjs";

const SCRIPT = /\.[cm]?js$/;

/**
 * A literal module specifier on a line: require("…"), import("…"), import …
 * from "…", export … from "…", import "…", and getBuiltinModule("…"), which
 * loads a built-in such as child_process without an import.
 */
export const SPECIFIER =
  /(?:\brequire\s*\(\s*|\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bgetBuiltinModule\s*\(\s*)(["'`])([^"'`\n]+)\1/g;

/** A line that registers an MCP tool, in the SDKs' and common frameworks' forms. */
export const REGISTRATION =
  /registerTools?\s*\(|\.tool\s*\(|setRequestHandler\s*\(|addTools?\s*\(|CallToolRequestSchema|extends\s+MCPTool/;

// What compilers and bundlers name a child_process binding: child_process_1
// (TypeScript), import_child_process (esbuild),
// child_process__WEBPACK_IMPORTED_MODULE_0__ (webpack).
export const CHILD_PROCESS_RECEIVER = String.raw`[\w$]*(?:child_?process|childProcess)[\w$]*`;

const PROCESS_FUNCTIONS = "spawn|spawnSync|execFile|execFileSync|execSync|fork";
const EXECA_FUNCTIONS =
  "execa|execaSync|execaCommand|execaCommandSync|execaNode";

/**
 * A line that may call a process function: child_process's functions
 * called bare or on any receiver; execa's; exec on a receiver named like
 * child_process or shelljs (exec on other receivers is usually
 * RegExp.prototype.exec and is left out); any of them called through the
 * wrapper TypeScript and bundlers emit for an imported function,
 * (0, child_process_1.spawnSync)(…); and Node's internal spawn bindings,
 * which start processes without child_process.
 */
export const PROCESS_CALL = new RegExp(
  [
    String.raw`(?:^|[^.\w$])(?:${PROCESS_FUNCTIONS}|${EXECA_FUNCTIONS}|crossSpawn)\s*\(`,
    String.raw`\.(?:${PROCESS_FUNCTIONS})\s*\(`,
    String.raw`(?:^|[^.\w$])exec\s*\(`,
    String.raw`(?:${CHILD_PROCESS_RECEIVER}|\b(?:cp|proc|shell|shelljs|sh))\.exec\s*\(`,
    String.raw`\.(?:${PROCESS_FUNCTIONS}|exec|${EXECA_FUNCTIONS})\s*\)\s*\(`,
    String.raw`\b(?:process\.binding|internalBinding)\s*\(\s*["'\`](?:spawn_sync|process_wrap)["'\`]`,
  ].join("|"),
);

// A process function handed on as a value (startServer(spawn, …), { exec }),
// so a file that never loads child_process can still call it.
const HANDED_ON =
  /[(,=:{]\s*(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*[,)}]/;

// A line that loads or evaluates code the specifiers do not name: require or
// import() of an expression, require made by createRequire and called at
// once, new Function and eval.
const RUNTIME_CODE =
  /\brequire\s*\(\s*[^"'`\s)]|\bimport\s*\(\s*[^"'`\s)]|\bcreateRequire\s*\([^)]*\)\s*\(|\bnew\s+Function\s*\(|(?:^|[^.\w$])eval\s*\(/;

/** The lines of one file of a package, read once per process. */
export const linesOf = (() => {
  const cache = new Map();
  return (root, file) => {
    const key = path.join(root, file);
    if (!cache.has(key)) cache.set(key, readFileSync(key, "utf8").split("\n"));
    return cache.get(key);
  };
})();

const isNodeScript = (root, file) =>
  /^#!.*\bnode\b/.test(
    readFileSync(path.join(root, file), "utf8").slice(0, 64),
  );

/**
 * The files that run with a package, as posix paths relative to `root`:
 * scripts outside node_modules that are not tests or declarations
 * (Landscape's catalog), and extensionless files with a node shebang.
 */
export const runningFiles = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath ?? entry.path, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .filter(
      (file) =>
        !file.split("/").includes("node_modules") &&
        !isTestPath(file) &&
        !file.endsWith(".d.ts") &&
        (SCRIPT.test(file) ||
          (path.extname(file) === "" && isNodeScript(root, file))),
    )
    .sort();

const processImports = (lines) =>
  lines.flatMap((line, index) =>
    [...line.matchAll(SPECIFIER)]
      .map((match) => match[2])
      .filter(
        (specifier) =>
          isProcessModule(specifier) || processLibraryOf(specifier) !== null,
      )
      .map((specifier) => ({ line: index + 1, specifier })),
  );

/**
 * `{ files, capable, candidates, runtimeCode }`: how many files run, the
 * files that load a process module or library (`{ file, imports }`), the
 * candidate process calls (`{ file, line }`) and the lines that load or
 * evaluate code at runtime.
 */
export const scan = (root) => {
  const files = runningFiles(root);
  const capable = [];
  const candidates = [];
  const runtimeCode = [];
  for (const file of files) {
    const lines = linesOf(root, file);
    const imports = processImports(lines);
    if (imports.length > 0) capable.push({ file, imports });
    // The import itself is accounted for with the file; a value handed on
    // is a candidate anywhere else in it.
    const importing = new Set(imports.map((entry) => entry.line));
    lines.forEach((line, index) => {
      if (
        PROCESS_CALL.test(line) ||
        (imports.length > 0 &&
          !importing.has(index + 1) &&
          HANDED_ON.test(line))
      )
        candidates.push({ file, line: index + 1 });
      if (RUNTIME_CODE.test(line)) runtimeCode.push({ file, line: index + 1 });
    });
  }
  return { files: files.length, capable, candidates, runtimeCode };
};
