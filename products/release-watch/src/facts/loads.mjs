// The specifier of a load REA resolved to no module, where REA's facts
// still give it. REA reports `import(name)` and `require(name)` with the
// expression it could not resolve and no specifier. Release Watch reads the
// specifier when the load's whole argument is one variable and REA defines
// that variable by a single string constant:
//
//   const lydell = "@lydell/node-pty";
//   const module = await import(lydell);
//
// The one owner of that reading: the import facts every catalog rule reads
// (process libraries, SDKs, HTTP clients, new packages) and the process
// rules' child_process seeds take it from here. No source is read: REA
// renders the expression, reports the read of the variable inside the
// load's range, and reports the constant that defines the variable.
import { packageNameOf } from "../catalog.mjs";
import { startsBefore, within } from "../ranges.mjs";

// How REA names each form of load, and the keyword that form is written with.
const KEYWORDS = new Map([
  ["dynamic-import", "import"],
  ["require", "require"],
]);

// REA renders an unresolved load as its source text. Block comments and
// white space between its tokens say nothing about what it loads
// (`import(/* webpackIgnore: true */ name)`); removing them cannot turn
// another expression into `import(name)`, which holds one identifier.
const bare = (expression) => expression.replace(/\/\*.*?\*\/|\s+/gs, "");

// A specifier that names a package or a Node.js built-in, as REA's own
// import facts do: not a path, and no URL but `node:`.
const isExternal = (specifier) =>
  specifier.startsWith("node:") || packageNameOf(specifier) !== null;

const rangeKey = (range) =>
  `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`;

const bindingKey = (module, range) => `${module}#${rangeKey(range)}`;

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

// The loads of a module whose argument REA renders: `import(…)` and
// `require(…)` with an expression and a range, in source order (REA lists
// them in none). An import whose file REA could not find renders no
// expression and is not a load of a variable.
const renderedLoads = (entry) =>
  entry.unresolvedSites
    .filter(
      (site) =>
        KEYWORDS.has(site.data.form) &&
        site.data.range &&
        typeof site.data.expression === "string",
    )
    .sort((a, b) => startsBefore(a.data.range, b.data.range));

// The read that is a load's whole argument: REA reads a variable inside the
// load's range, and the load is written as nothing but that variable's
// name (`import(name + "/sub")` and `import(resolve(name))` are not).
const argumentRead = (site, reads) => {
  const written = bare(site.data.expression);
  const keyword = KEYWORDS.get(site.data.form);
  return (
    reads.find(
      (read) =>
        within(read.data.range, site.data.range) &&
        written === `${keyword}(${read.data.name})`,
    ) ?? null
  );
};

/**
 * The loads of one application REA resolved to no module whose specifier
 * REA's facts give, each module's in source order: `[{ module, site,
 * binding, value }]`, with `site` the load's entry in
 * `modules.get(module).unresolvedSites`, `binding` the name of the variable
 * that is its argument and `value` the string constant REA reports as that
 * variable's only value (bindings.mjs's `constant`: one string literal
 * defines it and nothing assigns to it). A variable REA reports several
 * values for, a parameter and an assigned variable give none: what such a
 * load takes stays unknown. Only modules that hold such a load are indexed.
 */
export const constantLoads = (modules, { bindingReads, stringLiterals }) => {
  const loads = new Map();
  for (const [module, entry] of modules) {
    const sites = renderedLoads(entry);
    if (sites.length > 0) loads.set(module, sites);
  }
  if (loads.size === 0) return [];
  const reads = new Map();
  for (const read of bindingReads)
    if (loads.has(read.data.module) && read.data.binding_range)
      push(reads, read.data.module, read);
  const constants = new Map();
  for (const literal of stringLiterals)
    if (loads.has(literal.data.module) && literal.data.binding_constant)
      constants.set(
        bindingKey(literal.data.module, literal.data.binding_range),
        literal.data.value,
      );
  const found = [];
  for (const [module, sites] of loads)
    for (const site of sites) {
      const read = argumentRead(site, reads.get(module) ?? []);
      if (read === null) continue;
      const value = constants.get(bindingKey(module, read.data.binding_range));
      if (value !== undefined)
        found.push({ module, site, binding: read.data.name, value });
    }
  return found;
};

/**
 * Records what `constantLoads` found where the rest of Release Watch reads
 * it. Each load's site keeps its place among the loads REA did not resolve
 * and gains `data.constant` (`{ binding, value }`), so a rule that asks
 * what the load takes need not guess. A constant that names a package or a
 * built-in also becomes an import of the module, once per specifier the
 * module does not already import: it is added to the entry's
 * `externalImports` and returned as an import fact shaped like REA's own,
 * with state "derived" and `data.constant` (`{ binding, expression }`)
 * saying how Release Watch read it. A path is left to REA, which owns
 * which file it resolves to.
 */
export const recordConstantLoads = (modules, loads) => {
  const imports = [];
  for (const { module, site, binding, value } of loads) {
    site.data.constant = { binding, value };
    const entry = modules.get(module);
    if (!isExternal(value) || entry.externalImports.has(value)) continue;
    entry.externalImports.add(value);
    imports.push({
      ...site,
      key: value,
      label: value,
      state: "derived",
      data: {
        specifier: value,
        module,
        constant: { binding, expression: site.data.expression },
      },
    });
  }
  return imports;
};

/**
 * How a module came to load what an import fact names, for an evidence
 * line: "imports" for an import REA resolved, or the load and the constant
 * Release Watch read its specifier from. `name` is what the line calls the
 * import: its specifier, or the package a rule groups it under.
 */
export const importClaim = (fact, name = fact.key) =>
  fact.data.constant
    ? `${fact.data.module} loads ${name} (${bare(fact.data.constant.expression)}, where REA reports ${fact.data.constant.binding} constant)`
    : `${fact.data.module} imports ${name}`;
