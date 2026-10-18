// A product's traits and building blocks, read from the facts Release Watch
// projects for each of its components.
import { destinationsOf, packagesOf, sdkUses } from "../release-watch.mjs";
import { deriveAi, readAi } from "./ai.mjs";
import { readAgent } from "./agent.mjs";
import { readApp } from "./app.mjs";
import { deriveData, readData } from "./data.mjs";
import { isRuntimeImport } from "./imports.mjs";
import { createTraitSet } from "./set.mjs";
import { readSystem } from "./system.mjs";

const READERS = [readAi, readAgent, readSystem, readData, readApp];

const partOf = (component) => ({
  name: component.name,
  side: component.side,
  app: component.side.app,
  destinations: destinationsOf(component.side, { includeCapture: true }),
});

/**
 * One product's traits: `{ held, unknown, notes }` (traits/set.mjs), from
 * every component it has facts for.
 */
export const productTraits = (product) => {
  const set = createTraitSet();
  for (const component of product.components) {
    const part = partOf(component);
    for (const read of READERS) read(part, set);
  }
  deriveAi(set);
  deriveData(set);
  return set.finish();
};

/**
 * What a product is built with, from the imports REA reports: `{ sdks,
 * packages }`, the AI and MCP SDKs its modules import (`{ name, label,
 * kind }`, kind as Release Watch's catalog gives it: "ai", "mcp-server" or
 * "mcp")
 * and the other third-party packages, by name.
 */
export const productStack = (product) => {
  const sdks = new Map();
  const packages = new Set();
  for (const { side } of product.components) {
    const { app } = side;
    if (!app) continue;
    const running = isRuntimeImport(app);
    for (const [name, use] of sdkUses(app))
      if (use.facts.some(running))
        sdks.set(name, { label: use.sdk.label, kind: use.sdk.kind });
    for (const [name, facts] of packagesOf(app))
      if (facts.some(running)) packages.add(name);
  }
  return {
    sdks: [...sdks]
      .map(([name, sdk]) => ({ name, ...sdk }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    packages: [...packages].sort(),
  };
};
