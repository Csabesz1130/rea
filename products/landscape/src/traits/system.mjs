// Machine-access traits of one component: processes it starts (REA's
// child-process sites, uses of child_process REA did not classify, process
// libraries REA does not model), shells, pseudo-terminals and code built at
// runtime.
import { isPtyPackage } from "../catalog.mjs";
import { factLine, readingLine } from "../evidence.mjs";
import {
  commandText,
  isProcessLibrary,
  packageNameOf,
} from "../release-watch.mjs";
import { TRAITS } from "./definitions.mjs";
import { productFacts, runtimeImports } from "./runtime.mjs";

// child_process functions that always run their command in a shell
// (Node.js documentation); spawn() and execFile() do only when their
// options set `shell`, which REA does not report.
const SHELL_METHODS = new Set(["exec", "execSync"]);

const siteClaim = (site) =>
  `${site.data.method}() child-process creation${site.data.command === null ? " with a command REA did not resolve" : ` running ${commandText(site.data.command)}`}`;

const sites = (part, set) => {
  const found = productFacts(part.app.childProcesses);
  if (found.length === 0) return;
  set.add(TRAITS.process, {
    evidence: found.map((site) => factLine(part.name, siteClaim(site), site)),
    values: [...new Set(found.map((site) => `${site.data.method}()`))],
  });
  const shells = found.filter((site) => SHELL_METHODS.has(site.data.method));
  if (shells.length > 0)
    set.add(TRAITS.shell, {
      evidence: shells.map((site) =>
        factLine(
          part.name,
          `${siteClaim(site)}; ${site.data.method}() runs its command in a shell`,
          site,
        ),
      ),
      values: [...new Set(shells.map((site) => `${site.data.method}()`))],
    });
  else
    set.note(
      TRAITS.shell,
      "spawn() and execFile() run without a shell unless their options set shell, which REA does not report",
    );
};

const libraries = (part, set) => {
  for (const fact of runtimeImports(part.app)) {
    const name = packageNameOf(fact.key);
    if (isPtyPackage(name))
      set.add(TRAITS.terminal, {
        evidence: [
          factLine(
            part.name,
            `${fact.data.module} imports ${fact.key}, which runs programs in a pseudo-terminal (Landscape's catalog)`,
            fact,
          ),
        ],
        values: [name],
      });
    if (!isProcessLibrary(name)) continue;
    set.add(TRAITS.process, {
      strength: "likely",
      evidence: [
        factLine(
          part.name,
          `${fact.data.module} imports ${fact.key}, a library that starts processes; REA does not model the processes it starts`,
          fact,
        ),
      ],
      values: [name],
    });
    set.unknownBecause(
      TRAITS.shell,
      `it starts processes through ${name}, whose shell use REA does not model`,
    );
  }
};

const unclassified = (part, set) => {
  const uses = productFacts(part.app.processUnknowns);
  if (uses.length === 0) return;
  set.add(TRAITS.process, {
    strength: "likely",
    evidence: uses.map((use) =>
      readingLine(
        part.name,
        `${use.data.module} uses ${use.data.receiver}, which Release Watch ties to child_process, in a way REA did not classify as a process call`,
        use.location,
        "Release Watch",
      ),
    ),
  });
  set.unknownBecause(
    TRAITS.shell,
    "it uses child_process in ways REA did not classify, so whether they run a shell is unknown",
  );
};

const runtimeCode = (part, set) => {
  for (const fact of productFacts(part.app.dynamicEvaluation))
    set.add(TRAITS.runtimeCode, {
      evidence: [
        factLine(
          part.name,
          `${fact.data.module} evaluates code REA could not resolve statically (eval or new Function)`,
          fact,
        ),
      ],
    });
};

/** Record one component's machine-access traits. */
export const readSystem = (part, set) => {
  if (!part.app) return;
  sites(part, set);
  libraries(part, set);
  unclassified(part, set);
  runtimeCode(part, set);
};
