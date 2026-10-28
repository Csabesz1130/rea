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

// A call's opening parenthesis, also of an optional call: f?.(…).
const OPEN_CALL = String.raw`\s*(?:\?\.\s*)?\(`;

// The names that load a module by its name in any file: require, what
// bundlers rename it to (esbuild's __require, require2) and Module._load.
const LOADERS = String.raw`_*require\d*|_load`;

const BLOCK_COMMENT = String.raw`\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/`;

// createRequire imported or destructured under another name.
const CREATE_REQUIRE_ALIAS =
  /\bcreateRequire\s+as\s+([\w$]+)|\bcreateRequire\s*:\s*([\w$]+)/g;

// How many lines a createRequire call may span before the scan stops
// following it and counts its result as passed on.
const MAX_CALL_LINES = 32;

// One step through code at `index` of `line`, given whether a string or a
// comment is open (`state`): the index of the last character the step
// consumed, and the character when it is a token outside strings and
// comments (an opening quote included).
const step = (state, line, index) => {
  const char = line[index];
  const pair = line.slice(index, index + 2);
  if (state.comment) {
    if (pair === "*/") state.comment = false;
    return { index: pair === "*/" ? index + 1 : index };
  }
  if (state.quote) {
    if (char === "\\") return { index: index + 1 };
    if (char === state.quote) state.quote = null;
    return { index };
  }
  if (pair === "//") return { index: line.length };
  if (pair === "/*") {
    state.comment = true;
    return { index: index + 1 };
  }
  if (char === '"' || char === "'" || char === "`") state.quote = char;
  return { index, token: /\s/.test(char) ? null : char };
};

// The tokens from column `open` of line `start` on, for at most
// MAX_CALL_LINES lines: `{ char, rest() }`, and `{ char: null }` at the
// end of the text. Strings, templates and comments are stepped over; a
// quote or comment left open at the bound, or a string at its line's end,
// ends the tokens without that mark.
const tokensFrom = function* (lines, start, open) {
  const state = { quote: null, comment: false };
  const last = Math.min(lines.length, start + MAX_CALL_LINES);
  for (let row = start; row < last; row += 1) {
    const line = lines[row];
    for (
      let index = row === start ? open : 0;
      index < line.length;
      index += 1
    ) {
      const at = index;
      const next = step(state, line, at);
      if (next.token) yield { char: next.token, rest: () => line.slice(at) };
      index = next.index;
    }
    if (state.quote && state.quote !== "`") return;
  }
  if (last === lines.length && !state.quote && !state.comment)
    yield { char: null };
};

// Whether the call whose "(" is at column `open` of line `start` has a
// result the assignment keeps whole: after its ")" (it may span lines) the
// next token neither calls nor reads it, as createRequire(…)("x"),
// createRequire(…).call(…) or createRequire(…)[name] would, even across a
// line break. A call the scan cannot follow to its end is not kept whole.
const keptWhole = (lines, start, open) => {
  let depth = 0;
  for (const token of tokensFrom(lines, start, open)) {
    if (depth < 0)
      return token.char === null || !/^(?:[(.[`]|\?\.)/.test(token.rest());
    if (token.char === "(") depth += 1;
    else if (token.char === ")" && (depth -= 1) === 0) depth = -1;
  }
  return false;
};

const alternatives = (names) =>
  names.map((name) => name.replace(/\$/g, "\\$")).join("|");

// One pattern per distinct key, so files with the same loaders share
// compiled patterns.
const memo = (build) => {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, build(key));
    return cache.get(key);
  };
};

const EMPTY = Object.freeze([]);

// Bundlers annotate the call (/* @__PURE__ */ createRequire(…)).
const creatorPatterns = memo((creators) => ({
  present: new RegExp(String.raw`(?<![\w$])(?:${creators})\s*\(`),
  // Rolldown wraps the call: __require = /* #__PURE__ */ (() => createRequire(…))().
  binding: new RegExp(
    String.raw`(?<![.\w$])([\w$]+)\s*=\s*(?:${BLOCK_COMMENT}\s*)*(?:\(\s*\(\s*\)\s*=>\s*)?(?:[\w$]+\s*\.\s*|require\s*\(\s*["'](?:node:)?module["']\s*\)\s*\.)*(${creators})\s*\(`,
    "dg",
  ),
  call: new RegExp(String.raw`(?<![\w$])(?:${creators})\s*\(`, "g"),
}));

/**
 * How one file loads modules by name: `loaders`, an alternation of the
 * names that do (LOADERS, and every name the file binds to a createRequire
 * result, as `const require2 = createRequire(…)` or `u2 =
 * i2.createRequire(…)`), and `passedOn`, the 0-based columns, by line
 * index, of createRequire calls whose result no such name keeps, which can
 * load anything wherever it goes.
 */
const loadingOf = (lines) => {
  const passedOn = new Map();
  if (!lines.some((line) => line.includes("createRequire")))
    return { loaders: LOADERS, passedOn };
  const creators = alternatives([
    "createRequire",
    ...lines.flatMap((line) =>
      [...line.matchAll(CREATE_REQUIRE_ALIAS)].map(
        (match) => match[1] ?? match[2],
      ),
    ),
  ]);
  const { present, binding, call } = creatorPatterns(creators);
  const bound = new Set();
  lines.forEach((line, index) => {
    if (!present.test(line)) return;
    const kept = new Set(
      [...line.matchAll(binding)]
        .filter((match) =>
          keptWhole(lines, index, match.index + match[0].length - 1),
        )
        .map((match) => {
          bound.add(match[1]);
          return match.indices[2][0];
        }),
    );
    const columns = [...line.matchAll(call)]
      .map((match) => match.index)
      .filter((column) => !kept.has(column));
    if (columns.length > 0) passedOn.set(index, columns);
  });
  return {
    loaders: [LOADERS, alternatives([...bound])].filter(Boolean).join("|"),
    passedOn,
  };
};

// What names a module literally, after one of the file's loaders,
// import(…), import … from, export … from, import "…" or
// getBuiltinModule(…), which loads a built-in such as child_process
// without an import; `present`, a quick test for a line that may.
const specifierPatterns = memo((loaders) => ({
  present: new RegExp(
    String.raw`require|import|from|getBuiltinModule|${loaders}`,
  ),
  pattern: new RegExp(
    String.raw`(?:(?<![\w$])(?:${loaders})${OPEN_CALL}\s*|\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bgetBuiltinModule${OPEN_CALL}\s*)(["'\`])([^"'\`\n]+)\1`,
    "g",
  ),
}));

// The literal module specifiers a line names. A template literal with ${…}
// names a path computed at runtime, which the runtime forms count instead.
const specifiersOn = (line, { present, pattern }) => {
  if (!present.test(line)) return EMPTY;
  const found = [...line.matchAll(pattern)]
    .map((match) => match[2])
    .filter((specifier) => !specifier.includes("${"));
  return found.length > 0 ? found : EMPTY;
};

/** A line that registers an MCP tool, in the SDKs' and common frameworks' forms. */
export const REGISTRATION =
  /registerTools?\s*\(|\.tool\s*\(|setRequestHandler\s*\(|addTools?\s*\(|CallToolRequestSchema|extends\s+MCPTool/;

// What compilers and bundlers name a child_process binding: child_process_1
// (TypeScript), import_child_process (esbuild),
// child_process__WEBPACK_IMPORTED_MODULE_0__ (webpack).
export const CHILD_PROCESS_RECEIVER = String.raw`(?:child_?process|childProcess)[\w$]*`;

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
const PROCESS_CALL_FORMS = [
  // Bare: the call starts at the function's name, where REA reports it.
  {
    bare: true,
    source: String.raw`(?<![.\w$])(?:${PROCESS_FUNCTIONS}|${EXECA_FUNCTIONS}|crossSpawn|exec)${OPEN_CALL}`,
  },
  // On a receiver or through a wrapper: the call starts before the match.
  { source: String.raw`\.(?:${PROCESS_FUNCTIONS})${OPEN_CALL}` },
  {
    source: String.raw`(?:${CHILD_PROCESS_RECEIVER}|\b(?:cp|proc|shell|shelljs|sh))\.exec${OPEN_CALL}`,
  },
  {
    source: String.raw`\.(?:${PROCESS_FUNCTIONS}|exec|${EXECA_FUNCTIONS})\s*\)${OPEN_CALL}`,
  },
  {
    source: String.raw`\b(?:process\.binding|internalBinding)${OPEN_CALL}\s*["'\`](?:spawn_sync|process_wrap)["'\`]`,
  },
].map(({ bare = false, source }) => ({
  bare,
  pattern: new RegExp(source, "dg"),
}));

export const PROCESS_CALL = new RegExp(
  PROCESS_CALL_FORMS.map(({ pattern }) => pattern.source).join("|"),
);

// A line every process call form needs one of these words on.
const PROCESS_WORD = /spawn|Spawn|exec|fork|[bB]inding/;

// Every process call a line may hold, with the 0-based column it starts at
// and whether it is bare.
const processCallsOf = (line) =>
  PROCESS_WORD.test(line)
    ? PROCESS_CALL_FORMS.flatMap(({ bare, pattern }) =>
        [...line.matchAll(pattern)].map((match) => ({
          bare,
          column: match.index,
        })),
      )
    : EMPTY;

// A process function handed on as a value (startServer(spawn, …), { exec }),
// so a file that never loads child_process can still call it.
const HANDED_ON =
  /[(,=:{]\s*(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*[,)}]/;

// An argument that names no module literally: an expression, or a template
// literal with ${…}.
const COMPUTED = String.raw`${OPEN_CALL}\s*(?:[^"'\`\s)]|\`[^\`]*\$\{)`;

/**
 * The forms of loading or evaluating code a file's specifiers do not name,
 * each matched where its first word starts. The bare forms are a call REA reports at that very position, as a dynamic
 * evaluation, a load or a call; the others start at a receiver or build
 * code REA does not report there. `loaders` are the file's (loadingOf).
 */
const runtimeForms = memo((loaders) => [
  {
    form: "eval",
    bare: true,
    pattern: new RegExp(String.raw`(?<![.\w$])eval${OPEN_CALL}`, "dg"),
  },
  {
    form: "require",
    bare: true,
    pattern: new RegExp(String.raw`(?<![.\w$])(?:${loaders})${COMPUTED}`, "dg"),
  },
  {
    form: "import",
    bare: true,
    pattern: new RegExp(String.raw`(?<![.\w$])import${COMPUTED}`, "dg"),
  },
  {
    form: "member require or import",
    pattern: new RegExp(
      String.raw`\.(?:require|import|_load)${COMPUTED}`,
      "dg",
    ),
  },
  {
    form: "indirect eval",
    pattern: new RegExp(
      String.raw`\b(?:globalThis|global|window|self)\.(?:eval|Function)${OPEN_CALL}|\(\s*0\s*,\s*eval\s*\)${OPEN_CALL}`,
      "dg",
    ),
  },
  // new Function(…) and Function(…), which build a function from text.
  {
    form: "Function",
    bare: true,
    pattern: new RegExp(String.raw`(?<![.\w$])Function${OPEN_CALL}`, "dg"),
  },
  {
    form: "vm",
    pattern:
      /\b(?:runInThisContext|runInNewContext|runInContext|compileFunction)\s*(?:\?\.\s*)?\(/dg,
  },
  { form: "native code", pattern: /\bprocess\.dlopen\s*(?:\?\.\s*)?\(/dg },
]);

// A line every runtime form needs one of these words on.
const runtimeWord = memo(
  (loaders) =>
    new RegExp(
      String.raw`eval|import|require|_load|Function|runIn|compileFunction|dlopen|${loaders}`,
    ),
);

// Node's internal bindings that start a process without child_process.
const SPAWN_BINDING =
  /\b(?:process\.binding|internalBinding)\s*(?:\?\.\s*)?\(\s*["'`](?:spawn_sync|process_wrap)["'`]\s*\)/g;

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

/**
 * How one file of a package loads code, line by line, read once per
 * process: `specifiers`, the literal module specifiers each line names, and
 * `forms`, the forms of loading or evaluating code each line holds (`{
 * form, bare, column }`), with the file's own loaders (loadingOf).
 */
export const loadsOf = (() => {
  const cache = new Map();
  return (root, file) => {
    const key = path.join(root, file);
    if (!cache.has(key)) {
      const lines = linesOf(root, file);
      const { loaders, passedOn } = loadingOf(lines);
      const patterns = specifierPatterns(loaders);
      const forms = runtimeForms(loaders);
      const word = runtimeWord(loaders);
      const formsOn = (line, index) => {
        const found = [
          ...(word.test(line)
            ? forms.flatMap(({ form, bare = false, pattern }) =>
                [...line.matchAll(pattern)].map((match) => ({
                  form,
                  bare,
                  column: match.index,
                })),
              )
            : EMPTY),
          ...(passedOn.get(index) ?? EMPTY).map((column) => ({
            form: "createRequire result passed on",
            bare: false,
            column,
          })),
        ];
        return found.length > 0 ? found : EMPTY;
      };
      cache.set(key, {
        specifiers: lines.map((line) => specifiersOn(line, patterns)),
        forms: lines.map(formsOn),
      });
    }
    return cache.get(key);
  };
})();

// What makes a file process-capable: an import of a process module or
// library, and Node's spawn bindings, which start a process without one.
const processImports = (lines, specifiers) =>
  lines.flatMap((line, index) => [
    ...specifiers[index]
      .filter(
        (specifier) =>
          isProcessModule(specifier) || processLibraryOf(specifier) !== null,
      )
      .map((specifier) => ({ line: index + 1, specifier })),
    ...[...line.matchAll(SPAWN_BINDING)].map((match) => ({
      line: index + 1,
      specifier: match[0],
    })),
  ]);

/**
 * `{ files, capable, candidates, runtimeCode }`: how many files run, the
 * files that load a process module or library or use a spawn binding
 * (`{ file, imports }`), the candidate process calls (`{ file, line,
 * calls }`, each call `{ bare, column }`, none for a function handed on)
 * and the lines that load or evaluate code at runtime (`{ file, line,
 * forms }`, each form `{ form, bare, column }`).
 */
export const scan = (root) => {
  const files = runningFiles(root);
  const capable = [];
  const candidates = [];
  const runtimeCode = [];
  for (const file of files) {
    const lines = linesOf(root, file);
    const loads = loadsOf(root, file);
    const imports = processImports(lines, loads.specifiers);
    if (imports.length > 0) capable.push({ file, imports });
    // The import itself is accounted for with the file; a value handed on
    // is a candidate anywhere else in it.
    const importing = new Set(imports.map((entry) => entry.line));
    lines.forEach((line, index) => {
      const calls = processCallsOf(line);
      if (
        calls.length > 0 ||
        (imports.length > 0 &&
          !importing.has(index + 1) &&
          HANDED_ON.test(line))
      )
        candidates.push({ file, line: index + 1, calls });
      const forms = loads.forms[index];
      if (forms.length > 0) runtimeCode.push({ file, line: index + 1, forms });
    });
  }
  return { files: files.length, capable, candidates, runtimeCode };
};
