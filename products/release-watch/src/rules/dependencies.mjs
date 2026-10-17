// Third-party packages the new release imports that the old one did not.
// AI and MCP SDKs are graded by RW-A03; Node.js built-ins are not packages.
import { builtinModules } from "node:module";

import { packageNameOf, sdkOf } from "../catalog.mjs";
import { importsUnknown } from "../facts/coverage.mjs";
import { unknownElsewhere } from "./component-absence.mjs";
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

// Packages the new side imports that the diff could not compare, because
// REA's graph reports no imports for the old file importing them there.
const notCompared = (context) =>
  new Set(
    context.diff.app.imports
      .filter(
        (item) => item.status === "not-compared" && item.left.length === 0,
      )
      .map((item) => packageNameOf(item.key)),
  );

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const named = (entries) => {
  const names = entries.map(([name]) => name);
  return `${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`;
};

// Old components REA has no facts for may have imported a package no
// analyzed module did (unknownElsewhere).
const freshClause = (context, count) => {
  const elsewhere = unknownElsewhere(context);
  return `${plural(count, "package")} that no ${elsewhere === null ? "" : "analyzed "}module of the old release imported${elsewhere === null ? "" : `; ${elsewhere}, which may have`}`;
};

const summaryOf = (context, { fresh, unseen }) =>
  `${context.labels.right} imports ${[
    ...(fresh.length > 0 ? [freshClause(context, fresh.length)] : []),
    ...(unseen.length > 0
      ? [
          `${plural(unseen.length, "package")} in files whose imports REA's graph does not report for ${context.labels.left}, so whether ${unseen.length === 1 ? "it is" : "they are"} new is unknown`,
        ]
      : []),
  ].join("; it also imports ")}.`;

// The old files whose imports are unknown, named for the finding's unknowns.
const unknownImportsLine = (context) => {
  const files = [...importsUnknown(context.left.app)];
  return `REA recorded a failure and no import relationship for ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""} in ${context.labels.left}, so what ${files.length === 1 ? "it" : "they"} imported is unknown and the packages imported there in ${context.labels.right} were not compared.`;
};

/** RW-D01: one finding per component listing newly imported packages. */
export const dependencyPack = (context) => {
  if (context.baseline.apps === 0 || !context.right.app) return packResult();
  const before = new Set([
    ...packagesOf(context.left.app).keys(),
    ...context.baseline.packages,
  ]);
  const unknown = notCompared(context);
  const imported = [...packagesOf(context.right.app)].filter(
    ([name]) => !before.has(name),
  );
  const fresh = imported.filter(([name]) => !unknown.has(name));
  const unseen = imported.filter(([name]) => unknown.has(name));
  if (imported.length === 0) return packResult();
  const lines = [...fresh, ...unseen].map(([name, facts]) =>
    cite(`${facts[0].data.module} imports ${name}`, facts[0], APP_SOURCE),
  );
  return packResult([
    {
      rule: "RW-D01",
      severity: "low",
      title:
        fresh.length > 0
          ? `New third-party packages imported (${fresh.length}): ${named(fresh)}`
          : `Third-party packages not compared with ${context.labels.left} (${unseen.length}): ${named(unseen)}`,
      summary: summaryOf(context, { fresh, unseen }),
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
        ...(unseen.length > 0 ? [unknownImportsLine(context)] : []),
      ],
    },
  ]);
};
