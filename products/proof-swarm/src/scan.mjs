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
  isProcessLibrary,
  isProcessModule,
  packageNameOf,
} from "../../release-watch/src/catalog.mjs";

const SCRIPT = /\.[cm]?js$/;
const SPECIFIER =
  /(?:\brequire\s*\(\s*|\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'`])([^"'`\n]+)\1/g;

/**
 * A line that may call a process function: child_process's functions
 * called bare or on any receiver, execa's, and exec on a receiver named
 * like child_process or shelljs. exec on other receivers is usually
 * RegExp.prototype.exec and is left out.
 */
export const PROCESS_CALL =
  /(?:^|[^.\w$])(?:spawn|spawnSync|execFile|execFileSync|execSync|fork|execa|execaSync|execaCommand|execaCommandSync|execaNode|crossSpawn)\s*\(|\.(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(|(?:^|[^.\w$])exec\s*\(|\b(?:child_?process|childProcess|cp|proc|shell|shelljs|sh)\.exec\s*\(/;

// A process function handed on as a value (startServer(spawn, …), { exec }),
// so a file that never loads child_process can still call it.
const HANDED_ON =
  /[(,=:{]\s*(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*[,)}]/;

const RUNTIME_CODE =
  /\brequire\s*\(\s*[^"'`\s)]|\bimport\s*\(\s*[^"'`\s)]|\bnew\s+Function\s*\(|(?:^|[^.\w$])eval\s*\(/;

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
          isProcessModule(specifier) ||
          isProcessLibrary(packageNameOf(specifier)),
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
