// The hosts one side sends requests to, attributed from REA's facts and
// keyed by host so renamed bundles and refactored modules do not hide or
// invent a destination. The one owner of what counts as a destination, a
// guess, and how and from where one side contacted each host.
import { isHttpClient, isNamespaceHost, packageNameOf } from "../catalog.mjs";
import { within } from "../ranges.mjs";
import { hostOf, schemeOf, scriptHostOf, urlsIn } from "../urls.mjs";
import { indexOf, memberOn } from "./reach-index.mjs";
import { exportTarget } from "./reach-resolve.mjs";

export const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/;

const MAX_MEMBER_HOPS = 8;

// The binding a URL literal is the value of, and the property path below
// it: `[]` for the binding's own value, `["telemetry"]` for a property of
// `ENDPOINTS` (REA's property slot).
const slotOf = (literal) =>
  literal.data.binding !== null
    ? { binding: literal.data.binding, path: [] }
    : (literal.data.property ?? null);

/** The name a URL literal is assigned to (`TELEMETRY_URL`, `ENDPOINTS.telemetry`), or null. */
export const assignedName = (literal) => {
  const slot = slotOf(literal);
  return slot ? [slot.binding, ...slot.path].join(".") : null;
};

const startsWith = (path, prefix) =>
  prefix.every((key, index) => path[index] === key);

/**
 * URL literals of `module` that a read of `binding` followed by the member
 * path `path` gives: the literal is the value read, or what is read is
 * taken from it (`URL.replace(…)`). With `contained`, also the literals
 * inside the value read (an options object passed whole).
 */
const literalsRead = (
  app,
  { module, binding, path },
  { contained = false } = {},
) =>
  app.urlLiterals.filter((literal) => {
    const slot = slotOf(literal);
    return (
      literal.data.module === module &&
      slot?.binding === binding &&
      (startsWith(path, slot.path) ||
        (contained && startsWith(slot.path, path)))
    );
  });

// The member path REA reads on a binding read (`["telemetry"]` for
// `ENDPOINTS.telemetry`), `[]` when none.
const memberPath = (app, read) =>
  memberOn(indexOf(app), read.data.module, read.data.range)?.path ?? [];

// What a request site reads, as Release Watch names it in evidence.
const readName = (app, read) =>
  [read.data.name, ...memberPath(app, read)].join(".");

// The read of a URL literal's variable (or of the object holding it, with
// the member that names it) inside the request call, when REA's facts show
// one.
const boundRead = (app, request, literal) => {
  const slot = slotOf(literal);
  if (slot === null || request.data.range === null) return null;
  return (
    app.bindingReads.find(
      (read) =>
        read.data.module === request.data.module &&
        read.data.name === slot.binding &&
        within(read.data.range, request.data.range) &&
        startsWith(memberPath(app, read), slot.path),
    ) ?? null
  );
};

/**
 * What an imported name read with the member path `path` leads to: the
 * module and binding that hold it, the member path left below that
 * binding, and the modules the export resolution passed through
 * (reach-resolve owns it: export bindings, named, namespace and star
 * re-exports). Null when it leads to no binding (a function, an unknown).
 */
const importedValue = (app, target, path) => {
  const state = { app, index: indexOf(app) };
  let found =
    target.name === "*"
      ? { namespace: target.module }
      : exportTarget(state, target.module, target.name);
  let rest = path;
  const through = [...(found?.through ?? [])];
  for (
    let hops = 0;
    found?.namespace && rest.length > 0 && hops < MAX_MEMBER_HOPS;
    hops += 1
  ) {
    found = exportTarget(state, found.namespace, rest[0]);
    through.push(...(found?.through ?? []));
    rest = rest.slice(1);
  }
  // An anonymous default export is a value REA names no binding for, so no
  // URL literal's slot can match it.
  return found?.value?.binding
    ? {
        module: found.value.module,
        binding: found.value.binding.name,
        path: rest,
        through,
      }
    : null;
};

// URL literals another module holds that a request reads through an
// import: `fetch(MODEL_URL)`, `fetch(ENDPOINTS.telemetry)` or
// `fetch(C.TELEMETRY_URL)` with `C` a namespace import.
const importedLiterals = (app, request) => {
  if (request.data.range === null) return [];
  const imported = app.modules.get(request.data.module)?.imported;
  if (!imported) return [];
  return app.bindingReads
    .filter(
      (read) =>
        read.data.module === request.data.module &&
        read.data.binding_owner === null &&
        imported.has(read.data.name) &&
        within(read.data.range, request.data.range),
    )
    .flatMap((read) => {
      const value = importedValue(
        app,
        imported.get(read.data.name),
        memberPath(app, read),
      );
      return value
        ? literalsRead(app, value).map((literal) => ({
            literal,
            read,
            through: value.through,
          }))
        : [];
    });
};

// The imported values a module reads: an imported name, or the member of
// it the read names (`API.baseURL`, `C.API_BASE` with `C` a namespace
// import). A namespace read whole names no value.
const importedValues = (app, module) => {
  const imported = app.modules.get(module)?.imported ?? new Map();
  return app.bindingReads
    .filter(
      (read) =>
        read.data.module === module &&
        read.data.binding_owner === null &&
        imported.has(read.data.name),
    )
    .flatMap((read) => {
      const target = imported.get(read.data.name);
      const path = memberPath(app, read);
      if (target.name === "*" && path.length === 0) return [];
      return [importedValue(app, target, path)].filter(Boolean);
    });
};

// Clients REA reads as fetch calls; for the others a recognised request
// site in the module says nothing about the client's own requests.
const FETCH_LIKE = new Set(["node-fetch", "cross-fetch", "undici"]);

/**
 * Imports of HTTP client libraries whose requests REA does not model in
 * the importing module: every such client, except a fetch-like one in a
 * module where REA recognised request sites.
 */
export const clientImports = (app) => {
  const requesting = new Set(
    app.requests.map((request) => request.data.module),
  );
  return app.imports.filter((fact) => {
    const name = packageNameOf(fact.key);
    return (
      isHttpClient(name) &&
      !(FETCH_LIKE.has(name) && requesting.has(fact.data.module))
    );
  });
};

/** Modules whose requests go through an HTTP client REA does not model, each with the client's package name. */
export const clientModules = (app) =>
  new Map(
    clientImports(app).map((fact) => [
      fact.data.module,
      packageNameOf(fact.key),
    ]),
  );

// URL literals HTTP-client code may send to, each with how it relates to a
// client module: held by the client module itself, or a value it imports
// from another module (a constant, an object or one of its properties, a
// namespace member), with the modules that import passed through.
const clientLiterals = (app) => {
  const clients = clientModules(app);
  const found = new Map();
  for (const literal of app.urlLiterals)
    if (clients.has(literal.data.module))
      found.set(literal, { module: literal.data.module, via: "self" });
  for (const module of clients.keys())
    for (const value of importedValues(app, module))
      for (const literal of literalsRead(app, value, { contained: true }))
        if (!found.has(literal))
          found.set(literal, {
            module,
            via: "imports",
            through: value.through,
          });
  return [...found].map(([literal, client]) => ({
    literal,
    client: { ...client, package: clients.get(client.module) },
  }));
};

// A request REA resolved names its host. An unresolved one is attributed to
// a URL literal whose variable or object property it reads, in its module
// or exported by the module it imports it from ("bound-literal"), else, as
// a guess, to every URL literal in its module ("module-literal"). A URL
// literal that code using an HTTP client REA does not model holds or
// imports is a guess too ("client-literal").
const sourcesOf = (app) => {
  const found = [];
  const add = (host, source) => found.push([host, source]);
  for (const fact of app.endpoints)
    if (!fact.data.candidate)
      add(hostOf(fact.data.value), {
        kind: "endpoint",
        fact,
        url: fact.data.value,
      });
  for (const request of app.requests) {
    if (request.data.endpoint) {
      add(hostOf(request.data.endpoint), {
        kind: "request",
        fact: request,
        url: request.data.endpoint,
      });
      continue;
    }
    for (const literal of app.urlLiterals) {
      if (literal.data.module !== request.data.module) continue;
      const read = boundRead(app, request, literal);
      add(hostOf(literal.data.url), {
        kind: read ? "bound-literal" : "module-literal",
        fact: literal,
        url: literal.data.url,
        request,
        read,
        reads: read ? readName(app, read) : null,
      });
    }
    for (const { literal, read, through } of importedLiterals(app, request))
      add(hostOf(literal.data.url), {
        kind: "bound-literal",
        fact: literal,
        url: literal.data.url,
        request,
        read,
        reads: readName(app, read),
        through,
      });
  }
  for (const { literal, client } of clientLiterals(app))
    if (!LOCAL.test(hostOf(literal.data.url) ?? ""))
      add(hostOf(literal.data.url), {
        kind: "client-literal",
        fact: literal,
        url: literal.data.url,
        client,
        through: client.through ?? [],
      });
  return found;
};

// One app's sources are attributed once, however many views ask for them.
const appSources = new WeakMap();
const sourcesOfApp = (app) => {
  if (!appSources.has(app)) appSources.set(app, sourcesOf(app));
  return appSources.get(app);
};

/**
 * Every host one side sends requests to, with the facts that show it.
 * Capture-observed hosts are included only when `includeCapture` is set.
 */
export const destinationsOf = (side, { includeCapture }) => {
  const hosts = new Map();
  const add = (host, source) => {
    // XML namespace URLs in code are identifiers, not destinations.
    if (!host || (source.kind !== "capture" && isNamespaceHost(host))) return;
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host).push(source);
  };
  if (side.app)
    for (const [host, source] of sourcesOfApp(side.app)) add(host, source);
  for (const helper of side.helpers)
    for (const value of Object.values(helper.go?.settings ?? {}))
      for (const url of urlsIn(value))
        add(hostOf(url), { kind: "build-setting", helper, url });
  if (includeCapture && side.capture)
    for (const exchange of side.capture.exchanges)
      add(exchange.data.host, {
        kind: "capture",
        fact: exchange,
        url: `${exchange.data.origin}${exchange.data.path}`,
      });
  return hosts;
};

const HOSTNAME = /^(?=.{4,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** True for a source that only places a URL near a request: a guess. */
export const isGuessSource = (source) =>
  source.kind === "module-literal" || source.kind === "client-literal";

/** True when every source of a host only places its URL near requests or in a build setting. */
export const isGuess = (sources) =>
  sources.every(
    (source) => isGuessSource(source) || source.kind === "build-setting",
  );

/** Hosts one old side is known to contact: destinations, captured hosts and HTML script hosts; not guesses. */
export const knownHosts = (side) =>
  new Set([
    ...[...destinationsOf(side, { includeCapture: true })]
      .filter(([, sources]) => sources.some((source) => !isGuessSource(source)))
      .map(([host]) => host),
    ...(side.app?.pageScripts ?? [])
      .map((script) => scriptHostOf(script.data.script_path))
      .filter(Boolean),
  ]);

/** Hosts one old side only guessed at: URL literals near requests or HTTP clients. */
export const guessedHosts = (side) =>
  new Set(
    [...destinationsOf(side, { includeCapture: true })]
      .filter(([, sources]) => sources.every(isGuessSource))
      .map(([host]) => host),
  );

/** The module a destination source was seen in: the request's, the literal's, or the endpoint's location. */
export const sourceModule = (source) =>
  source.request?.data.module ??
  source.fact?.data?.module ??
  source.fact?.location?.file ??
  null;

/**
 * Every module a destination source rests on: the request's, the URL
 * literal's or endpoint's, the HTTP client module's, and the modules an
 * import of the URL passed through (re-exporting barrels). Empty for a
 * capture or a build setting.
 */
export const sourceModules = (source) => [
  ...new Set(
    [
      source.request?.data.module,
      source.kind === "capture" ? null : sourceModule({ fact: source.fact }),
      source.client?.module,
      ...(source.through ?? []),
    ].filter(Boolean),
  ),
];

/**
 * A test for requests of one app without a known destination: REA did not
 * resolve one, and Release Watch binds no URL literal to the request
 * through REA's binding reads ("bound-literal"). RW-N02 and the release's
 * request moves count only these.
 */
export const withoutDestination = (app) => {
  const bound = new Set(
    (app ? sourcesOfApp(app) : [])
      .filter(([, source]) => source.kind === "bound-literal")
      .map(([, source]) => source.request.node_id),
  );
  return (request) => !request.data.endpoint && !bound.has(request.node_id);
};

/** Bare host names one side's code holds as string literals (`hostname: HOST`, a block list). */
export const namedHosts = (side) =>
  new Set(
    (side.app?.stringLiterals ?? [])
      .map((literal) => literal.data.value)
      .filter((value) => HOSTNAME.test(value))
      .map((value) => value.toLowerCase()),
  );

/** The sources of a host that sit in browser code or a browser capture. */
export const browserSources = (side, sources) =>
  sources.filter(
    (source) =>
      source.kind === "capture" ||
      side.app?.browserModules.has(sourceModule(source)),
  );

const browserPlacement = (side) =>
  [...destinationsOf(side, { includeCapture: true })]
    .map(([host, sources]) => [host, browserSources(side, sources)])
    .filter(([, sources]) => sources.length > 0);

/** Hosts one side contacts from browser code or a browser capture; a URL its browser code only holds near requests is not a contact. */
export const browserHosts = (side) =>
  new Set(
    browserPlacement(side)
      .filter(([, sources]) => !sources.every(isGuessSource))
      .map(([host]) => host),
  );

/** Hosts one side's browser code only guessed at. */
export const browserGuessedHosts = (side) =>
  new Set(
    browserPlacement(side)
      .filter(([, sources]) => sources.every(isGuessSource))
      .map(([host]) => host),
  );

// A captured GET the server redirected is navigation, such as an http://
// address upgraded to https://. A redirected POST still sent its body in
// cleartext.
export const isUpgradeRedirect = (source) =>
  source.kind === "capture" &&
  source.fact.data.method === "GET" &&
  source.fact.data.status >= 300 &&
  source.fact.data.status < 400;

/** How one side reached each host, from what it contacted: not guesses, and not a navigation the server redirected. */
export const contactSchemes = (side) =>
  new Map(
    [...destinationsOf(side, { includeCapture: true })].map(
      ([host, sources]) => [
        host,
        new Set(
          sources
            .filter(
              (source) => !isGuessSource(source) && !isUpgradeRedirect(source),
            )
            .map((source) => schemeOf(source.url)),
        ),
      ],
    ),
  );

/** Schemes per host from several sides' `contactSchemes`, merged. */
export const mergeSchemes = (...maps) => {
  const merged = new Map();
  for (const map of maps)
    for (const [host, schemes] of map ?? [])
      merged.set(host, new Set([...(merged.get(host) ?? []), ...schemes]));
  return merged;
};
