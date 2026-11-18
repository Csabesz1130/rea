// RW-F01: code that reads or names a credential store the old release's
// code did not. REA reports a file read whose path is a literal, and the
// string literals a variable or property holds; it does not report a
// literal passed straight to a call, so a path built inline from pieces
// is not seen.
import { credentialStoresIn } from "../catalog.mjs";
import { examinedInPart } from "../facts/coverage.mjs";
import { changedFiles } from "./analysis-coverage.mjs";
import { APP_SOURCE, cite, heuristic, packResult } from "./shared.mjs";

const MAX_LINES = 4;

// The paths one app's code holds, by module: `{ value, fact, read }`, a
// file read REA resolved to a literal path (`read`) or a string literal.
const pathsOf = (app, counted) => {
  const byModule = new Map();
  const add = (fact, value, read) => {
    const module = fact.data.module;
    if (module === null || typeof value !== "string" || !counted(module))
      return;
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push({ value, fact, read });
  };
  for (const fact of app?.configReads ?? [])
    if (fact.data.source_kind === "file") add(fact, fact.data.key, true);
  for (const fact of app?.stringLiterals ?? [])
    add(fact, fact.data.value, false);
  return byModule;
};

/**
 * The credential stores an app's code reads or names, by store: `[{
 * module, how, values, fact }]` for each module, `how` "read" when REA
 * reports a file read of the store's path, "path" when a literal holds it
 * and "parts" when separate literals hold its pieces; `fact` is the first
 * fact that matched. `counted` selects the modules to look in.
 */
export const storesOf = (app, counted = () => true) => {
  const stores = new Map();
  for (const [module, paths] of pathsOf(app, counted))
    for (const found of credentialStoresIn(paths.map((item) => item.value))) {
      const matched = paths.filter((item) => found.values.includes(item.value));
      if (!stores.has(found.store)) stores.set(found.store, []);
      stores.get(found.store).push({
        module,
        how: matched.some((item) => item.read) ? "read" : found.how,
        values: found.values,
        fact: (matched.find((item) => item.read) ?? matched[0]).fact,
      });
    }
  return stores;
};

const line = (site) => {
  if (site.how === "parts")
    return heuristic(
      `${site.module} holds ${site.values.map((value) => JSON.stringify(value)).join(" and ")} as separate literals, the pieces of the path`,
      site.fact.location ?? null,
    );
  return cite(
    `${site.module} ${site.how === "read" ? "reads the file" : "holds the path"} ${JSON.stringify(site.values[0])}`,
    site.fact,
    APP_SOURCE,
  );
};

const storeFindings = (context) => {
  const { left, right, labels } = context;
  if (!right.app) return [];
  const before = storesOf(left.app);
  // A literal in a file the old release shipped with this content is not new.
  const after = storesOf(right.app, changedFiles(context));
  const partly = left.app ? examinedInPart(left.app).length > 0 : true;
  return [...after]
    .filter(([store]) => !before.has(store))
    .map(([store, sites]) => ({
      rule: "RW-F01",
      severity: "high",
      title: `Code ${sites.some((site) => site.how === "read") ? "reads" : "names"} a credential store not named before: ${store}`,
      summary: `${labels.right} ${sites.some((site) => site.how === "read") ? "reads" : "names"} where ${store} are kept, in ${sites.map((site) => site.module).join(", ")} (${partly ? `not observed in ${labels.left}; REA coverage does not establish absence` : `no code of ${labels.left} names it`}).`,
      why: "Code that reads another program's credentials can act as the user elsewhere. The path in the code is the first sign of it.",
      recommendation:
        "Ask the vendor why this release needs the file, and check that nothing sends its content off the machine.",
      evidence: sites.slice(0, MAX_LINES).map(line),
      unknowns: [
        sites.some((site) => site.how === "read")
          ? "REA reports the read, not where the file's content goes."
          : "REA reports the literal, not whether the file is read or where its content goes.",
        'A path built inline from pieces, as in path.join(home, ".aws", "credentials"), is not seen: REA does not report literals passed straight to a call.',
      ],
    }));
};

/** File rules. */
export const filePack = (context) => packResult(storeFindings(context));
