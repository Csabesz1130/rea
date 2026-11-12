// A product's traits and building blocks, read from the facts Release Watch
// projects for each of its components.
import { destinationsOf, packagesOf, sdkUses } from "../release-watch.mjs";
import { deriveAi, readAi } from "./ai.mjs";
import { readAgent } from "./agent.mjs";
import { readApp } from "./app.mjs";
import { deriveData, readData } from "./data.mjs";
import { isRuntimeImport, productSources } from "./runtime.mjs";
import { createTraitSet } from "./set.mjs";
import { readSystem } from "./system.mjs";

const READERS = [readAi, readAgent, readSystem, readData, readApp];

const partOf = (component) => ({
  name: component.name,
  side: component.side,
  app: component.side.app,
  destinations: new Map(
    [...destinationsOf(component.side, { includeCapture: true })]
      .map(([host, sources]) => [host, productSources(sources)])
      .filter(([, sources]) => sources.length > 0),
  ),
});

// AI and MCP SDKs and other third-party packages one component's running
// code imports.
const addStack = (app, sdks, packages) => {
  if (!app) return;
  const running = isRuntimeImport(app);
  for (const [name, use] of sdkUses(app))
    if (use.facts.some(running))
      sdks.set(name, { label: use.sdk.label, kind: use.sdk.kind });
  for (const [name, facts] of packagesOf(app))
    if (facts.some(running)) packages.add(name);
};

/**
 * Reads one product's traits and building blocks a component at a time, so
 * each component's facts can be released once it is read: `read(component)`
 * for each `{ name, side }`, then `finish()`, which returns `{ traits,
 * stack }`: the traits as traits/set.mjs finishes them, and the building
 * blocks, `{ sdks, packages }`, the AI and MCP SDKs the product's modules
 * import (`{ name, label, kind }`, kind as Release Watch's catalog gives it:
 * "ai", "mcp-server" or "mcp") and the other third-party packages, by name.
 */
export const productReader = () => {
  const set = createTraitSet();
  const sdks = new Map();
  const packages = new Set();
  return {
    read(component) {
      const part = partOf(component);
      for (const read of READERS) read(part, set);
      addStack(component.side.app, sdks, packages);
    },
    finish() {
      deriveAi(set);
      deriveData(set);
      return {
        traits: set.finish(),
        stack: {
          sdks: [...sdks]
            .map(([name, sdk]) => ({ name, ...sdk }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          packages: [...packages].sort(),
        },
      };
    },
  };
};
