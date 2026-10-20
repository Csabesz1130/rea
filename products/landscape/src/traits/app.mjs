// Desktop and web traits of one component: Electron and its window
// safeguards (Release Watch's reading of REA's window options), web pages,
// service workers, browser storage and scripts loaded from other hosts.
import { factLine, readingLine } from "../evidence.mjs";
import {
  displayScript,
  scriptHostOf,
  surfacesOf,
  windowSafeguards,
} from "../release-watch.mjs";
import { TRAITS } from "./definitions.mjs";
import { productFacts } from "./runtime.mjs";

const desktop = (part, set) => {
  const reasons = surfacesOf(part.side).electron;
  if (reasons.length > 0)
    set.add(TRAITS.electron, {
      evidence: reasons.map((reason) =>
        readingLine(part.name, reason, null, "Release Watch"),
      ),
    });
  for (const window of productFacts(part.app?.windows ?? []))
    for (const guard of windowSafeguards(window)) {
      if (guard.state === "unsafe")
        set.add(TRAITS.weakWindow, {
          evidence: [
            factLine(
              part.name,
              `a BrowserWindow in ${window.data.source_path ?? "the app"} runs ${guard.without}: ${guard.text}`,
              window,
            ),
          ],
          values: [guard.label],
        });
      else if (guard.state === "dynamic")
        set.unknownBecause(
          TRAITS.weakWindow,
          `a window's ${guard.name} is a value REA did not resolve`,
        );
    }
};

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

// What shows a component ships pages: scripts its HTML loads, modules
// Release Watch places in pages.
const pageWords = (scripts, modules) =>
  [
    ...(scripts > 0 ? [`its pages load ${plural(scripts, "script")}`] : []),
    ...(modules > 0
      ? [`Release Watch places ${plural(modules, "module")} in web pages`]
      : []),
  ].join("; ");

const web = (part, set) => {
  const { app } = part;
  const pageScripts = productFacts(app.pageScripts);
  if (pageScripts.length > 0 || app.browserModules.size > 0)
    set.add(TRAITS.pages, {
      evidence: [
        readingLine(
          part.name,
          pageWords(pageScripts.length, app.browserModules.size),
          null,
          "Release Watch",
        ),
      ],
    });
  for (const worker of productFacts(app.serviceWorkers))
    set.add(TRAITS.offline, {
      evidence: [
        factLine(
          part.name,
          `registers service worker ${worker.data.specifier}`,
          worker,
        ),
      ],
    });
  for (const store of productFacts(app.storage))
    set.add(TRAITS.browserStorage, {
      evidence: [
        factLine(
          part.name,
          `uses ${store.data.storage_kind}${store.data.name ? ` key ${store.data.name}` : ""}`,
          store,
        ),
      ],
      values: [store.data.storage_kind],
    });
  for (const script of pageScripts) {
    const host = scriptHostOf(script.data.script_path);
    if (host)
      set.add(TRAITS.foreignScript, {
        evidence: [
          factLine(
            part.name,
            `a page loads ${displayScript(script.data.script_path)}`,
            script,
          ),
        ],
        values: [host],
      });
  }
};

/** Record one component's desktop and web traits. */
export const readApp = (part, set) => {
  desktop(part, set);
  if (part.app) web(part, set);
};
