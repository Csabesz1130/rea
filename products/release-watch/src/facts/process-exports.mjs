// Which exports of a local module hold child_process, so that a module
// importing them holds it too. From REA's export facts: an export REA
// traces to child_process (`export { execSync } from "node:child_process"`,
// `module.exports = require("child_process")`, `exports.spawn = spawn`,
// `export * from "node:child_process"`) and a re-export of another local
// module's export that does (`module.exports = require("./cp")`). Where
// REA traced no export under a name, a top-level binding of the exporting
// module with that name that holds child_process and goes where REA's graph
// does not show (`module.exports = { spawn }`) is Release Watch's
// correlation (`named`).
import { isProcessModule } from "../catalog.mjs";

// Import or export names that stand for a whole module.
const WHOLE = new Set(["*", "default"]);

// The child_process export an export REA traced holds, by the property path
// REA reports (`[]` or `["*"]` for the module), null for the whole module.
const memberOf = ({ path, imported }) => {
  const first = path ? (path[0] ?? null) : imported;
  return first === null || WHOLE.has(first) ? null : first;
};

const traced = (entry, module, name) => {
  const site = entry.externalExports.get(name);
  if (!site || !isProcessModule(site.data.specifier)) return null;
  return {
    member: memberOf(site.data),
    module,
    name,
    site,
    commonjs: site.data.form === "commonjs-export",
    heuristic: false,
  };
};

const starred = (entry, module, name) => {
  const site = entry.externalExports.get("*");
  if (name === "default" || !site || !isProcessModule(site.data.specifier))
    return null;
  return {
    member: name,
    module,
    name,
    site,
    commonjs: false,
    heuristic: false,
  };
};

// A name REA traced to a local binding or another module is not guessed.
const untraced = (entry, name) =>
  (entry.exports.get(name)?.local ?? null) === null &&
  !entry.reexports.has(name);

// Resolves one export within one lookup: `scope` is `{ modules, named,
// seen }`, `seen` the exports already asked for, which ends re-export
// cycles.
const resolve = (scope, module, name) => {
  const key = `${module}\u0000${name}`;
  const entry = scope.modules.get(module);
  if (!entry || scope.seen.has(key)) return null;
  scope.seen.add(key);
  const direct = traced(entry, module, name);
  if (direct) return direct;
  const reexport = entry.reexports.get(name);
  if (reexport) return resolve(scope, reexport.module, reexport.name);
  // A module's own export shadows what it re-exports with `export *`.
  if (entry.exports.has(name))
    return untraced(entry, name) ? scope.named(module, name) : null;
  const star = starred(entry, module, name);
  if (star) return star;
  if (name !== "default")
    for (const target of entry.stars) {
      const found = resolve(scope, target, name);
      if (found) return found;
    }
  // A property of `module.exports` when module.exports is child_process.
  const whole = name === "default" ? null : resolve(scope, module, "default");
  if (whole?.commonjs && whole.member === null)
    return { ...whole, member: name, name };
  return untraced(entry, name) ? scope.named(module, name) : null;
};

/**
 * What the export `name` of `module` holds: `{ member, module, name, site,
 * commonjs, heuristic }` with `member` the child_process export it holds
 * (null for the module), or null when it holds no child_process value REA
 * traced or Release Watch correlated. `named(module, name)` gives the
 * correlated holder of a name REA traced no export for.
 */
export const exportHolder = (modules, module, name, named) =>
  resolve({ modules, named, seen: new Set() }, module, name);

// Every name a module exports, through its star re-exports.
const exportedNames = (modules, module, seen = new Set()) => {
  const entry = modules.get(module);
  if (!entry || seen.has(module)) return [];
  seen.add(module);
  return [
    ...entry.externalExports.keys(),
    ...entry.reexports.keys(),
    ...entry.exports.keys(),
    ...[...entry.stars].flatMap((star) => exportedNames(modules, star, seen)),
  ].filter((name) => name !== "*");
};

// True when a module re-exports all of child_process, itself or through
// a star re-export of a local module.
const reexportsAll = (modules, module, seen = new Set()) => {
  const entry = modules.get(module);
  if (!entry || seen.has(module)) return false;
  seen.add(module);
  return (
    isProcessModule(entry.externalExports.get("*")?.data.specifier) ||
    [...entry.stars].some((star) => reexportsAll(modules, star, seen))
  );
};

/**
 * What importing all of `module` holds (`require("./cp")`, `import * as
 * cp`, a dynamic import): `module.exports` when it is child_process,
 * otherwise a namespace `{ names, star }` of the exports that hold
 * child_process (`star` when every child_process export is re-exported),
 * or null when none does. `namedList(module)` lists the names Release
 * Watch correlates.
 */
export const wholeHolder = (modules, module, { named, namedList }) => {
  const exported = exportHolder(modules, module, "default", named);
  if (exported?.commonjs) return exported;
  const names = new Map();
  for (const name of new Set([
    ...exportedNames(modules, module),
    ...namedList(module),
  ])) {
    const holder = exportHolder(modules, module, name, named);
    if (holder) names.set(name, holder);
  }
  const star = reexportsAll(modules, module);
  if (names.size === 0 && !star) return null;
  return {
    member: null,
    module,
    name: "*",
    site: null,
    commonjs: false,
    heuristic: [...names.values()].every((holder) => holder.heuristic) && !star,
    namespace: { names, star },
  };
};
