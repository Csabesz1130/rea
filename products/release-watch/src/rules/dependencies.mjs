// Third-party packages the new release imports that the old one did not.
// AI and MCP SDKs are graded by RW-A03; Node.js built-ins are not packages.
import { builtinModules } from "node:module";

import { packageNameOf, sdkOf } from "../catalog.mjs";
import { APP_SOURCE, cite, heuristic, packResult } from "./shared.mjs";

const BUILTINS = new Set(builtinModules);
const MAX_LINES = 8;

/** Third-party packages one application imports, by package name, with the import facts. */
export const packagesOf = (app) => {
  const packages = new Map();
  for (const fact of app?.imports ?? []) {
    const name = packageNameOf(fact.key);
    if (
      name === null ||
      fact.key.startsWith("node:") ||
      BUILTINS.has(name) ||
      sdkOf(fact.key) !== null
    )
      continue;
    if (!packages.has(name)) packages.set(name, []);
    packages.get(name).push(fact);
  }
  return packages;
};

/** RW-D01: one finding per component listing newly imported packages. */
export const dependencyPack = (context) => {
  if (context.baseline.apps === 0 || !context.right.app) return packResult();
  const before = new Set([
    ...packagesOf(context.left.app).keys(),
    ...context.baseline.packages,
  ]);
  const fresh = [...packagesOf(context.right.app)].filter(
    ([name]) => !before.has(name),
  );
  if (fresh.length === 0) return packResult();
  const lines = fresh.map(([name, facts]) =>
    cite(`${facts[0].data.module} imports ${name}`, facts[0], APP_SOURCE),
  );
  const names = fresh.map(([name]) => name);
  return packResult([
    {
      rule: "RW-D01",
      severity: "low",
      title: `New third-party packages imported (${fresh.length}): ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`,
      summary: `${context.labels.right} imports ${fresh.length} package${fresh.length === 1 ? "" : "s"} that no module of the old release imported.`,
      why: "New dependencies bring new maintainers and install-time code into the release.",
      recommendation: "Check each package against your dependency policy.",
      evidence: [
        ...lines.slice(0, MAX_LINES),
        ...(lines.length > MAX_LINES
          ? [heuristic(`${lines.length - MAX_LINES} more packages`)]
          : []),
      ],
      unknowns: [
        "Bundled code inlines its dependencies; REA reports only imports that remain in the shipped files.",
      ],
    },
  ]);
};
