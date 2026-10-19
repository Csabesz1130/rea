// Which exports of a local module hold child_process, so that a module
// importing them holds it too. exports.mjs resolves each name through
// re-exports; here the definition it reaches is read for child_process: an
// export REA traces to child_process (`export { execSync } from
// "node:child_process"`, `module.exports = require("child_process")`,
// `exports.spawn = spawn`, `export * from "node:child_process"`), a
// property of such a module.exports, or a namespace re-export of a module
// that holds it. Where REA traced no export under a name, a top-level
// binding of the exporting module with that name that holds child_process
// and goes where REA's graph does not show (`module.exports = { spawn }`)
// is Release Watch's correlation (`named`).
import { isProcessModule } from "../catalog.mjs";
import {
  exportedNames,
  externalStars,
  importedMember,
  namespaceModules,
  resolveExport,
} from "./exports.mjs";

// The holder of an export REA traced to child_process: the child_process
// export it holds (null for the module), the name read on it included.
const tracedHolder = (found, name) => {
  const { external: site, property } = found;
  if (!isProcessModule(site.data.specifier)) return null;
  return {
    member: property ?? importedMember(site.data),
    module: found.through.at(-1),
    name,
    site,
    commonjs: property === null && site.data.form === "commonjs-export",
    heuristic: false,
  };
};

// What one resolved export holds; `seen` holds the modules whose whole
// namespace is being read, which ends namespace re-export cycles. A holder
// found through a binding matched by the export's name is Release Watch's
// correlation, held in that binding.
const holderOf = (modules, found, { name, context }) => {
  const holder =
    found.defined !== undefined
      ? found.defined
      : found.external
        ? tracedHolder(found, name)
        : wholeAt(modules, found.namespace, context);
  return holder && found.guessed
    ? { ...holder, ...found.guessed, heuristic: true }
    : holder;
};

// One export within one lookup: `context` is `{ exports, seen }`.
const exportAt = (modules, module, name, context) => {
  const found = resolveExport(modules, module, name, (at, own, exported) =>
    exported?.local ? null : context.exports.named(at, own),
  );
  return found.unknown ? null : holderOf(modules, found, { name, context });
};

// The names a module's namespace may hold child_process under: those REA
// reports it exporting, and those Release Watch correlates.
const candidateNames = (modules, module, { exports }) =>
  new Set([
    ...exportedNames(modules, module),
    ...namespaceModules(modules, module).flatMap((at) => exports.namedList(at)),
  ]);

const wholeAt = (modules, module, context) => {
  if (context.seen.has(module)) return null;
  context.seen.add(module);
  const exported = exportAt(modules, module, "default", context);
  const names = new Map();
  if (!exported?.commonjs)
    for (const name of candidateNames(modules, module, context)) {
      const holder = exportAt(modules, module, name, context);
      if (holder) names.set(name, holder);
    }
  context.seen.delete(module);
  if (exported?.commonjs) return exported;
  const star = externalStars(modules, module).some((site) =>
    isProcessModule(site.data.specifier),
  );
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

/**
 * What the export `name` of `module` holds: `{ member, module, name, site,
 * commonjs, heuristic }` with `member` the child_process export it holds
 * (null for the module), a namespace holder (`wholeHolder`), or null when
 * it holds no child_process value REA traced or Release Watch correlated.
 * `exports.named(module, name)` gives the correlated holder of a name REA
 * traced no export for, `exports.namedList(module)` the names it has one
 * for.
 */
export const exportHolder = (modules, module, name, exports) =>
  exportAt(modules, module, name, { exports, seen: new Set() });

/**
 * What importing all of `module` holds (`require("./cp")`, `import * as
 * cp`, a dynamic import): `module.exports` when it is child_process,
 * otherwise a namespace `{ names, star }` of the exports that hold
 * child_process (`star` when every child_process export is re-exported),
 * or null when none does.
 */
export const wholeHolder = (modules, module, exports) =>
  wholeAt(modules, module, { exports, seen: new Set() });
