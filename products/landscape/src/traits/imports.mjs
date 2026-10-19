// The imports a component's running code makes: REA's import facts outside
// TypeScript declaration files, which hold types and run nothing. Every
// trait that rests on an import reads them here.
import {
  clientImports,
  isDeclarationPath,
  packageNameOf,
} from "../release-watch.mjs";

const runtime = new WeakMap();

/** The import facts of one app's running code. */
export const runtimeImports = (app) => {
  if (!runtime.has(app))
    runtime.set(
      app,
      app.imports.filter((fact) => !isDeclarationPath(fact.data.module)),
    );
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
