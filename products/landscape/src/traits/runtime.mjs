// What runs when a product runs: REA's facts outside TypeScript declaration
// files, which hold types, and outside files named as tests, which some
// packages ship but only a test runner runs (Landscape's catalog). Every
// trait reads its facts through these tests.
import { isTestPath } from "../catalog.mjs";
import {
  clientImports,
  isDeclarationPath,
  packageNameOf,
  sourceModule,
} from "../release-watch.mjs";

/** True for a module whose code runs with the product; a fact with no module is kept. */
export const runsWithProduct = (modulePath) =>
  typeof modulePath !== "string" ||
  (!isDeclarationPath(modulePath) && !isTestPath(modulePath));

/** True for a fact REA reports in code that runs with the product. */
export const inProduct = (fact) =>
  runsWithProduct(fact?.data?.module ?? fact?.location?.file ?? null);

/** The facts of a list REA reports in code that runs with the product. */
export const productFacts = (facts) => facts.filter(inProduct);

/** A destination's sources in code that runs with the product; a capture or a build setting always counts. */
export const productSources = (sources) =>
  sources.filter(
    (source) =>
      source.kind === "capture" ||
      source.kind === "build-setting" ||
      runsWithProduct(sourceModule(source)),
  );

const runtime = new WeakMap();

/** The import facts of one app's running code. */
export const runtimeImports = (app) => {
  if (!runtime.has(app)) runtime.set(app, productFacts(app.imports));
  return runtime.get(app);
};

/** A test for import facts of one app's running code. */
export const isRuntimeImport = (app) => {
  const facts = new Set(runtimeImports(app));
  return (fact) => facts.has(fact);
};

/**
 * The HTTP clients REA does not model that one app's running code imports,
 * by package name (Release Watch's clientImports owns which they are).
 * Requests through them show only as URL literals REA reports, so what the
 * app contacts through them may not show at all.
 */
export const unmodeledClients = (app) => {
  const running = isRuntimeImport(app);
  return [
    ...new Set(
      clientImports(app)
        .filter(running)
        .map((fact) => packageNameOf(fact.key)),
    ),
  ];
};

/** Why traits that rest on requests cannot be settled for an app, or null. */
export const clientReason = (app) => {
  const clients = unmodeledClients(app);
  return clients.length === 0
    ? null
    : `it imports ${clients.join(", ")}, ${clients.length === 1 ? "an HTTP client" : "HTTP clients"} REA does not model, so what it reaches through ${clients.length === 1 ? "it" : "them"} shows only as URL literals REA reports`;
};
