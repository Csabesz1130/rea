// Network destinations, keyed by host so renamed bundles and refactored
// modules do not hide or invent a destination.
import { movedFrom } from "../moves.mjs";
import { sourceEvidence, sourceUnknowns } from "./network-evidence.mjs";
import { isHttpClient, isNamespaceHost, packageNameOf } from "../catalog.mjs";
import { captureUnread } from "../facts/capture.mjs";
import { within } from "../ranges.mjs";
import {
  displayUrl,
  hostOf,
  schemeOf,
  scriptHostOf,
  urlsIn,
} from "../urls.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  isVendorHost,
  newGroups,
  packResult,
} from "./shared.mjs";

// The read of a URL literal's variable inside the request call, when REA's
// facts show one.
const boundRead = (app, request, literal) =>
  literal.data.binding === null || request.data.range === null
    ? null
    : (app.bindingReads.find(
        (read) =>
          read.data.module === request.data.module &&
          read.data.name === literal.data.binding &&
          within(read.data.range, request.data.range),
      ) ?? null);

// URL literals bound to a binding the request reads that another module
// exports: `fetch(MODEL_URL)` with MODEL_URL imported from a constants module.
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
      const target = imported.get(read.data.name);
      if (target.name === "*") return [];
      const local =
        app.modules.get(target.module)?.exports?.get(target.name)?.local ??
        target.name;
      return app.urlLiterals
        .filter(
          (literal) =>
            literal.data.module === target.module &&
            literal.data.binding === local,
        )
        .map((literal) => ({ literal, read }));
    });
};

// Modules that import an HTTP client library and have no request site REA
// recognised: REA does not model those clients' calls.
const clientModules = (app) => {
  const requesting = new Set(
    app.requests.map((request) => request.data.module),
  );
  return new Set(
    app.imports
      .filter((fact) => isHttpClient(packageNameOf(fact.key)))
      .map((fact) => fact.data.module)
      .filter((module) => !requesting.has(module)),
  );
};

// A request REA resolved names its host. An unresolved one is attributed to
// a URL literal whose variable it reads, in its module or exported by the
// module it imports it from ("bound-literal"), else, as a guess, to every URL
// literal in its module ("module-literal"). A URL literal in a module whose
// requests go through an HTTP client REA does not model is a guess too
// ("client-literal").
const appSources = (app, add) => {
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
      });
    }
    for (const { literal, read } of importedLiterals(app, request))
      add(hostOf(literal.data.url), {
        kind: "bound-literal",
        fact: literal,
        url: literal.data.url,
        request,
        read,
      });
  }
  const clients = clientModules(app);
  for (const literal of app.urlLiterals)
    if (
      clients.has(literal.data.module) &&
      !LOCAL.test(hostOf(literal.data.url) ?? "")
    )
      add(hostOf(literal.data.url), {
        kind: "client-literal",
        fact: literal,
        url: literal.data.url,
      });
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
  if (side.app) appSources(side.app, add);
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

/** Bare host names one side's code holds as string literals (`hostname: HOST`, a block list). */
export const namedHosts = (side) =>
  new Set(
    (side.app?.stringLiterals ?? [])
      .map((literal) => literal.data.value)
      .filter((value) => HOSTNAME.test(value))
      .map((value) => value.toLowerCase()),
  );

/** Hosts one side contacts from browser code or a browser capture. */
export const browserHosts = (side) =>
  new Set(
    [...destinationsOf(side, { includeCapture: true })]
      .filter(([, sources]) =>
        sources.some(
          (source) =>
            source.kind === "capture" ||
            side.app?.browserModules.has(sourceModule(source)),
        ),
      )
      .map(([host]) => host),
  );

/**
 * The network view shared by the network, AI and web packs: hosts the new
 * side contacts that nothing REA saw in the old release references (in any
 * component), and `own`, the deployment's hosts (`deploymentHosts`).
 */
export const networkView = (
  left,
  right,
  baseline = { hosts: new Set() },
  { ignoreCapture = false, own = new Set() } = {},
) => {
  const leftDestinations = destinationsOf(left, { includeCapture: true });
  const known = new Set([...knownHosts(left), ...baseline.hosts]);
  const guessed = new Set([...guessedHosts(left), ...(baseline.guessed ?? [])]);
  // Without a readable old capture, hosts seen only at runtime cannot be compared.
  const current = destinationsOf(right, { includeCapture: !ignoreCapture });
  // The deployment's own origin is the site itself, not a destination. A
  // host the old release only guessed at is new once the new release
  // contacts it, and not new while it is still only a guess.
  const fresh = new Map(
    [...current].filter(
      ([host, sources]) =>
        !known.has(host) &&
        !own.has(host) &&
        !(guessed.has(host) && sources.every(isGuessSource)),
    ),
  );
  // How the old release reached each host, from what it contacted: not
  // guesses, and not a navigation the server redirected.
  const leftSchemes = new Map(
    [...leftDestinations].map(([host, sources]) => [
      host,
      new Set(
        sources
          .filter(
            (source) => !isGuessSource(source) && !isUpgradeRedirect(source),
          )
          .map((source) => schemeOf(source.url)),
      ),
    ]),
  );
  return { known, named: namedHosts(left), current, fresh, own, leftSchemes };
};

/** The old release, named as a whole: hosts are compared across all its components. */
const oldRelease = (context) =>
  context.releaseLabels?.left ?? context.labels.left;

/** How the old release's absence of a host is known: always bounded by REA's coverage. */
export const hostAbsence = (context) =>
  `not seen in ${oldRelease(context)}'s analyzed code${context.left.capture ? " or capture" : ""}`;

/** The unknowns every new-host claim carries when REA cannot establish the old release's absence. */
export const absenceUnknowns = (context) => [
  ...(context.left.app?.coverage.semantic === "complete" &&
  context.left.app?.coverage.graph === "complete"
    ? []
    : [
        `REA's coverage of ${oldRelease(context)} is incomplete, so it does not establish that it never contacted this host.`,
      ]),
  ...(context.left.capture === null && context.right.capture !== null
    ? [
        captureUnread(context.left)
          ? `REA could not read the capture given for ${context.labels.left}, so the host may have been contacted at runtime before.`
          : `No capture of ${oldRelease(context)} was provided, so the host may have been contacted at runtime before.`,
      ]
    : []),
];

// What else the sending modules do: timers that repeat the request, and host
// or user APIs they import.
const contextEvidence = (sources, app) => {
  if (!app) return [];
  const modules = new Set(sources.map(sourceModule).filter(Boolean));
  const lines = [];
  for (const timer of app.timers)
    if (modules.has(timer.data.module))
      lines.push(
        cite(
          `${timer.data.module} schedules work with ${timer.data.method}()`,
          timer,
          APP_SOURCE,
        ),
      );
  for (const modulePath of modules) {
    const imports = app.modules.get(modulePath)?.externalImports ?? new Set();
    if (imports.has("node:os") || imports.has("os"))
      lines.push(
        heuristic(
          `${modulePath} imports node:os, which exposes host and user account details`,
        ),
      );
  }
  return lines;
};

const isFirstParty = (host, context) =>
  isVendorHost(host, context.options.vendorDomains) ||
  context.network.own.has(host);

const destinationFinding = (host, sources, context) => {
  const { labels } = context;
  const firstParty = isFirstParty(host, context);
  // The old code held the host name, but REA saw no request to it.
  const named = context.network.named.has(host);
  const runtime = sources.some((source) => source.kind === "capture");
  return {
    rule: "RW-N01",
    severity: firstParty ? "low" : isGuess(sources) ? "medium" : "high",
    title: `New ${firstParty ? "first-party" : "third-party"} destination: ${host}`,
    summary: isGuess(sources)
      ? `${labels.right} holds a URL for ${host} next to requests REA could not resolve or does not model; the host was ${hostAbsence(context)}.`
      : `${labels.right} sends requests to ${host}${runtime ? " (seen at runtime)" : ""}; it was ${hostAbsence(context)}.`,
    why: firstParty
      ? "New network behaviour on the vendor's own domain is usually a feature."
      : "Data leaving to a host the vendor never used before is the pattern seen in compromised updates and undisclosed data sharing.",
    recommendation: firstParty
      ? "Confirm the feature in the release notes."
      : "Block the release until the vendor names the recipient and the data sent, or the host is allow-listed.",
    evidence: [
      ...sourceEvidence(sources, labels),
      ...contextEvidence(sources, context.right.app),
    ],
    unknowns: [
      ...sourceUnknowns(sources),
      ...absenceUnknowns(context),
      ...(named
        ? [
            `${context.labels.left}'s code held the name ${host} as a string, so it may have contacted it in a way REA did not see.`,
          ]
        : []),
    ],
  };
};

// URL literals in a request's module, shown as candidates, never as the
// request's established destination.
const candidateLines = (app, request) =>
  app.urlLiterals
    .filter((literal) => literal.data.module === request.data.module)
    .slice(0, 3)
    .map((literal) =>
      heuristic(
        `Candidate destination: URL literal ${displayUrl(literal.data.url)} in the same module`,
        literal.location,
      ),
    );

// Requests with no destination REA resolved and no new destination finding
// explains. A group counts unless each of its new sites takes an unresolved
// site of the same method that the release lost, so code that moved between
// modules or components is not reported as new.
const unresolvedRequests = (context, explained) =>
  newGroups(context.diff.app.requests)
    .map((group) => ({
      ...group,
      facts: group.facts.filter(
        (fact) =>
          !fact.data.endpoint &&
          !context.claimed.nodes.has(fact.node_id) &&
          !explained.has(fact.node_id),
      ),
    }))
    .filter((group) => group.facts.length > 0)
    .filter((group) => movedFrom(context.moves.requests, group.facts) === null)
    .map((group) => {
      const [fact] = group.facts;
      return {
        rule: "RW-N02",
        severity: "medium",
        title: `New request with an unresolved destination in ${fact.data.module}`,
        summary: `${context.labels.right} has ${fact.data.method}() sites in ${fact.data.module} without a resolved destination that no removed site of ${context.labels.left} accounts for (${group.counts.before} → ${group.counts.after} in this module).`,
        why: "Unexplained outbound traffic is the main exfiltration path for compromised updates.",
        recommendation:
          "Capture the release's traffic or ask the vendor for the destination.",
        evidence: [
          ...group.facts.map((site) =>
            cite(
              `${site.data.method}() request in ${site.data.module}`,
              site,
              APP_SOURCE,
            ),
          ),
          ...candidateLines(context.right.app, fact),
        ],
        unknowns: [
          `REA did not resolve the destination${group.facts.length > 1 ? "s" : ""}${group.status === "increased" ? ", and Release Watch cannot tell which site is new" : ""}.`,
        ],
      };
    });

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/;
const CLEARTEXT = new Set(["http", "ws"]);

// A captured GET the server redirected is navigation, such as an http://
// address upgraded to https://. A redirected POST still sent its body in
// cleartext.
const isUpgradeRedirect = (source) =>
  source.kind === "capture" &&
  source.fact.data.method === "GET" &&
  source.fact.data.status >= 300 &&
  source.fact.data.status < 400;

// A host the new side reaches over http:// or ws:// that the old side never
// reached in cleartext.
const cleartextChannels = (context) =>
  [...context.network.current]
    .filter(([host]) => !LOCAL.test(host))
    .flatMap(([host, sources]) => {
      // A URL that only shares a module with a request is not a channel.
      const plain = sources.filter(
        (source) =>
          CLEARTEXT.has(schemeOf(source.url)) &&
          source.kind !== "module-literal" &&
          !isUpgradeRedirect(source),
      );
      if (plain.length === 0) return [];
      const before = context.network.leftSchemes.get(host) ?? new Set();
      if ([...before].some((scheme) => CLEARTEXT.has(scheme))) return [];
      const schemes = [
        ...new Set(plain.map((source) => schemeOf(source.url))),
      ].join(" and ");
      return [
        {
          rule: "RW-N03",
          severity: "medium",
          title: `Cleartext connection to ${host}`,
          summary: `${context.labels.right} reaches ${host} over ${schemes}${before.size > 0 ? `; ${context.labels.left} reached it only over encrypted connections` : ""}.`,
          why: "Unencrypted traffic can be read and changed by anyone on the network path.",
          recommendation: "Use https:// or wss://.",
          evidence: sourceEvidence(plain, context.labels),
          unknowns: sourceUnknowns(plain),
        },
      ];
    });

// A host known only from a URL literal next to an unresolved request is a
// guess. A third-party guess still gets RW-N01, labelled as one; a
// first-party guess does not, and its request stays an RW-N02 candidate.

/** RW-N01 for new hosts no other pack claimed, RW-N02 for unresolved requests, RW-N03 for cleartext. */
export const networkPack = (context) => {
  const reported = [...context.network.fresh]
    .filter(([host]) => !context.claimed.hosts.has(host))
    .filter(([, sources]) =>
      sources.some((source) => source.kind !== "build-setting"),
    )
    .filter(
      ([host, sources]) => !isGuess(sources) || !isFirstParty(host, context),
    );
  const explained = new Set(
    [
      ...reported,
      ...[...context.network.fresh].filter(([host]) =>
        context.claimed.hosts.has(host),
      ),
    ]
      .flatMap(([, sources]) => sources)
      .map((source) => source.request?.node_id)
      .filter(Boolean),
  );
  return packResult([
    ...reported.map(([host, sources]) =>
      destinationFinding(host, sources, context),
    ),
    ...unresolvedRequests(context, explained),
    ...cleartextChannels(context),
  ]);
};
