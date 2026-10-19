// RW-C06: changed modules that import a library that starts processes
// (execa, shelljs, cross-spawn, node-pty and the like). REA's child-process
// extraction models node:child_process calls only, so a process started
// through one of these is not classified, and the process, Electron and MCP
// rules cannot see it.
import { isProcessLibrary, packageNameOf } from "../catalog.mjs";
import { renamedFrom } from "../diff.mjs";
import { APP_SOURCE, cite, heuristic } from "./shared.mjs";

const MAX_LINES = 6;

const libraryImports = (app) =>
  (app?.imports ?? []).filter((fact) =>
    isProcessLibrary(packageNameOf(fact.key)),
  );

const importKey = (module, fact) => `${module}#${packageNameOf(fact.key)}`;

/**
 * RW-C06 findings for one component. `changed` (changedFiles, the owner of
 * "changed": a file whose content the old release shipped anywhere did not
 * change) tells whether a module of the new release changed since the old
 * one; an unchanged module is not reported. High when a changed module
 * imports a process library it did not import before (under its old path
 * when it was renamed), as new process execution through child_process is;
 * medium when every such module imported it before, since whether the
 * commands it runs changed is unknown.
 */
export const processLibraries = (context, changed) => {
  const before = new Set(
    libraryImports(context.left.app).map((fact) =>
      importKey(fact.data.module, fact),
    ),
  );
  const renamed = renamedFrom(context.aliases);
  const importedBefore = (fact) =>
    [fact.data.module, renamed(fact.data.module)].some(
      (module) => module !== undefined && before.has(importKey(module, fact)),
    );
  const fresh = libraryImports(context.right.app)
    .filter((fact) => changed(fact.data.module))
    .map((fact) => ({ fact, added: !importedBefore(fact) }));
  if (fresh.length === 0) return [];
  const libraries = [
    ...new Set(fresh.map(({ fact }) => packageNameOf(fact.key))),
  ];
  const moduleCount = new Set(fresh.map(({ fact }) => fact.data.module)).size;
  const added = fresh.some((site) => site.added);
  return [
    {
      rule: "RW-C06",
      severity: added ? "high" : "medium",
      title: `Processes started through ${libraries.join(", ")} in new or changed code are not examined`,
      summary: `${moduleCount} new or changed module${moduleCount === 1 ? "" : "s"} of ${context.labels.right} import${moduleCount === 1 ? "s" : ""} a library that starts processes, which REA's process extraction does not model.`,
      why: "Commands run through these libraries are invisible to the process, Electron and MCP rules, so a new shell command there would not be reported; a direct child_process call in new code is reported high.",
      recommendation:
        "Review the commands these modules run through the library and where their arguments come from.",
      evidence: [
        ...fresh
          .slice(0, MAX_LINES)
          .map(({ fact, added: isNew }) =>
            cite(
              `${fact.data.module} imports ${fact.key}${isNew ? "" : `, as it did in ${context.labels.left}, and changed`}`,
              fact,
              APP_SOURCE,
            ),
          ),
        heuristic(
          "Release Watch lists packages that start processes; REA's child-process extraction models node:child_process calls only",
        ),
      ],
      unknowns: added
        ? []
        : [
            "These modules imported the library before; Release Watch cannot tell whether the commands they run changed.",
          ],
    },
  ];
};
