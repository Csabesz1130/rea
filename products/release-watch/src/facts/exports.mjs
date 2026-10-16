// Export resolution over the import index modules.mjs builds from REA's
// export facts: which module defines a name another module exports. The
// one owner of the rules: an exported import or a named re-export leads to
// the module it names (`export { run } from "./shell.js"`, `export { run
// as go }` after an import), a module's own export shadows what `export *`
// gives, `export *` never gives `default`, the first star module that
// defines a name gives it, and a CommonJS `module.exports =
// require("./other")` gives the other module's names. Where REA reports no
// export under a name, a binding of the module with that name is Release
// Watch's correlation (`module.exports = { spawn }`): an import binding
// leads to what it imports, any other is the caller's own definition.
// Reach (rules/reach-resolve.mjs), destination attribution and the
// child_process exports of process gaps (process-exports.mjs) consume it.

/**
 * The export a site names in the module it loads (`imported` or the first
 * name of its property path), null for the whole module (`require("x")`,
 * `import * as x`, `module.exports = require("x")`).
 */
export const importedMember = ({ path, imported }) => {
  const first = path ? (path[0] ?? null) : imported;
  return first === null || first === "*" || first === "default" ? null : first;
};

// `module.exports = require("./other")`: REA reports a CommonJS re-export
// of the other module's whole value.
const wholeReexport = (entry) => {
  const whole = entry?.reexports.get("default");
  return whole?.form === "commonjs-export" && whole.name === "default"
    ? whole
    : null;
};

// `module.exports = require("child_process")`: an external module's whole
// value.
const externalWhole = (entry) => {
  const site = entry?.externalExports.get("default");
  return site?.data.form === "commonjs-export" &&
    importedMember(site.data) === null
    ? site
    : null;
};

const passing = (module, found) =>
  found.unknown
    ? found
    : { ...found, through: [module, ...(found.through ?? [])] };

const external = (module, site, property) => ({
  external: site,
  property,
  through: [module],
});

const defined = (scope, module, name, exported) => ({
  defined: scope.own(module, name, exported) ?? null,
  module,
  through: [module],
});

// A name that leads to another module's export, or to all of a module.
const forwardTo = (scope, module, target) =>
  passing(
    module,
    target.name === "*"
      ? { namespace: target.module, through: [] }
      : walk(scope, target.module, target.name),
  );

// What `export *` and a CommonJS module.exports give a name the module
// does not export itself, or null.
const shared = (scope, module, name, entry) => {
  for (const star of entry?.stars ?? []) {
    const found = walk(scope, star, name);
    if (!found.unknown) return passing(module, found);
  }
  const star = entry?.externalExports.get("*");
  if (star) return external(module, star, name);
  const site = externalWhole(entry);
  if (site) return external(module, site, name);
  const whole = wholeReexport(entry);
  if (!whole) return null;
  const found = walk(scope, whole.module, name);
  return found.unknown ? null : passing(module, found);
};

// A binding of the module named like the export REA reports none for;
// `guessed` names the first such binding a resolution matched.
const guessed = (scope, module, name, entry) => {
  const imported = entry?.imported.get(name);
  const found = imported
    ? forwardTo(scope, module, imported)
    : defined(scope, module, name, undefined);
  if (found.unknown || found.defined === null) return { unknown: module };
  return { ...found, guessed: { module, name } };
};

const walk = (scope, module, name) => {
  const key = `${module}\u0000${name}`;
  if (scope.seen.has(key)) return { unknown: module };
  scope.seen.add(key);
  const entry = scope.modules.get(module);
  const site = entry?.externalExports.get(name);
  if (site) return external(module, site, null);
  const exported = entry?.exports.get(name);
  const target =
    (exported?.local ? entry.imported.get(exported.local) : null) ??
    entry?.reexports.get(name);
  if (target) return forwardTo(scope, module, target);
  if (exported) return defined(scope, module, name, exported);
  return (
    (name === "default" ? null : shared(scope, module, name, entry)) ??
    guessed(scope, module, name, entry)
  );
};

/**
 * Where the export `name` of `module` is defined. `own(module, name,
 * exported)` is the caller's definition of a name a module defines itself,
 * with REA's export entry (`{ local, range }`), or undefined when REA
 * reports none under that name; null when the caller finds none. Returns
 * `{ defined, module }` (the caller's definition, which may be null),
 * `{ namespace }` (all of another module), `{ external, property }` (an
 * export REA traced to an external module, with the name read on what it
 * exports, null for the export itself) or `{ unknown: module }`. A result
 * lists in `through` the modules it passed, from `module` to the one that
 * defines the name, and in `guessed` the module and name of the first
 * binding a step matched by the export's name, when one did.
 */
export const resolveExport = (modules, module, name, own) =>
  walk({ modules, own, seen: new Set() }, module, name);

/**
 * The modules whose exports a module's namespace includes: itself, the
 * modules it re-exports with `export *`, and the module a CommonJS
 * `module.exports = require("./other")` re-exports whole.
 */
export const namespaceModules = (modules, module) => {
  const found = new Set();
  const visit = (current) => {
    if (found.has(current)) return;
    found.add(current);
    const entry = modules.get(current);
    for (const star of entry?.stars ?? []) visit(star);
    const whole = wholeReexport(entry);
    if (whole) visit(whole.module);
  };
  visit(module);
  return [...found];
};

/**
 * The names REA reports a module's namespace exporting: its own exports,
 * re-exports and exports traced to external modules, and those of the
 * modules its namespace includes, apart from their `default`.
 */
export const exportedNames = (modules, module) =>
  namespaceModules(modules, module).flatMap((current) => {
    const entry = modules.get(current);
    if (!entry) return [];
    return [
      ...entry.externalExports.keys(),
      ...entry.reexports.keys(),
      ...entry.exports.keys(),
    ].filter(
      (name) => name !== "*" && (current === module || name !== "default"),
    );
  });

/** The `export * from` sites of external modules a module's namespace includes. */
export const externalStars = (modules, module) =>
  namespaceModules(modules, module)
    .map((current) => modules.get(current)?.externalExports.get("*"))
    .filter(Boolean);
