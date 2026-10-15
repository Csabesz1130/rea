// Network destinations, keyed by host so renamed bundles and refactored
// modules do not hide or invent a destination.
import {
  APP_SOURCE,
  CAPTURE_SOURCE,
  absencePhrase,
  cite,
  displayUrl,
  hostOf,
  isVendorHost,
  newFacts,
  packResult,
  reported,
  urlsIn,
} from "./shared.mjs";

const GO_SOURCE = "REA inspect_go_binary";
const MAX_SOURCES = 4;

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
    for (const literal of app.urlLiterals)
      if (literal.data.module === request.data.module)
        add(hostOf(literal.data.url), {
          kind: "module-literal",
          fact: literal,
          url: literal.data.url,
          request,
        });
  }
};

/**
 * Every host one side sends requests to, with the facts that show it.
 * Capture-observed hosts are included only when `includeCapture` is set.
 */
export const destinationsOf = (side, { includeCapture }) => {
  const hosts = new Map();
  const add = (host, source) => {
    if (!host) return;
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

/** Hosts serving the captured HTML documents: the deployment's own origin. */
export const ownHostsOf = (side) =>
  new Set(
    (side.capture?.documents ?? []).map((document) =>
      hostOf(document.data.origin),
    ),
  );

/**
 * The network view shared by the network, AI and web packs: hosts the new
 * side contacts that nothing on the old side references.
 */
export const networkView = (left, right) => {
  const known = new Set([
    ...destinationsOf(left, { includeCapture: true }).keys(),
    ...(left.app?.pageScripts ?? []).map((script) =>
      hostOf(script.data.script_path),
    ),
  ]);
  const current = destinationsOf(right, {
    includeCapture: left.capture !== null,
  });
  const fresh = new Map([...current].filter(([host]) => !known.has(host)));
  return {
    known,
    current,
    fresh,
    own: new Set([...ownHostsOf(left), ...ownHostsOf(right)]),
  };
};

/** Evidence lines for one host's sources, most direct first. */
export const sourceEvidence = (sources, labels) => {
  const order = {
    capture: 0,
    endpoint: 1,
    request: 2,
    "module-literal": 3,
    "build-setting": 4,
  };
  const seen = new Set();
  const lines = [];
  for (const source of [...sources].sort(
    (a, b) => order[a.kind] - order[b.kind],
  )) {
    const identity = `${source.kind}:${source.url}:${source.fact?.node_id ?? source.helper?.relative}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (source.kind === "capture") {
      const data = source.fact.data;
      lines.push(
        cite(
          `${data.method} ${displayUrl(source.url)} answered ${data.status ?? "without a status"} at runtime`,
          source.fact,
          CAPTURE_SOURCE,
        ),
      );
    } else if (source.kind === "endpoint")
      lines.push(
        cite(
          `${source.fact.data.mechanism ?? "request"} to ${displayUrl(source.url)}`,
          source.fact,
          APP_SOURCE,
        ),
      );
    else if (source.kind === "request")
      lines.push(
        cite(
          `${source.fact.data.method}() request to ${displayUrl(source.url)}`,
          source.fact,
          APP_SOURCE,
        ),
      );
    else if (source.kind === "module-literal") {
      lines.push(
        cite(
          `${source.request.data.method}() request in ${source.request.data.module}`,
          source.request,
          APP_SOURCE,
        ),
      );
      const binding = source.fact.data.binding;
      lines.push(
        cite(
          `URL literal ${displayUrl(source.url)}${binding ? ` assigned to ${binding}` : ""}, in the same module as the request`,
          source.fact,
          APP_SOURCE,
          {
            redact:
              displayUrl(source.url) === source.url
                ? []
                : [{ value: source.url, with: displayUrl(source.url) }],
          },
        ),
      );
    } else
      lines.push(
        reported(
          `${source.helper.relative} is linked with a build setting that contains ${displayUrl(source.url)}`,
          "observed",
          GO_SOURCE,
        ),
      );
  }
  const shown = lines.slice(0, MAX_SOURCES * 2);
  if (lines.length > shown.length)
    shown.push(
      reported(
        `${lines.length - shown.length} more references in ${labels.right}`,
        "observed",
        APP_SOURCE,
      ),
    );
  return shown;
};

/** What a host's sources cannot establish. */
export const sourceUnknowns = (sources) => {
  const unknowns = [];
  if (sources.some((source) => source.kind === "module-literal"))
    unknowns.push(
      "REA did not resolve the request's URL argument; the destination is a URL literal in the same module.",
    );
  if (sources.every((source) => source.kind === "capture"))
    unknowns.push(
      "A capture records one session; it does not show which code sends the request or what other paths contact.",
    );
  if (sources.every((source) => source.kind === "build-setting"))
    unknowns.push(
      "A build setting records the value; REA does not establish that the program contacts it.",
    );
  return unknowns;
};

// What else the sending modules do: timers that repeat the request, and
// host or user APIs they import.
const contextEvidence = (sources, app) => {
  if (!app) return [];
  const modules = new Set(
    sources
      .map((source) => source.request?.data.module ?? source.fact?.data?.module)
      .filter(Boolean),
  );
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
        reported(
          `${modulePath} also imports node:os, which exposes host and user account details`,
          "inferred",
          APP_SOURCE,
        ),
      );
  }
  return lines;
};

const destinationFinding = (host, sources, context) => {
  const { labels, options, network } = context;
  const firstParty =
    isVendorHost(host, options.vendorDomains) || network.own.has(host);
  const runtime = sources.some((source) => source.kind === "capture");
  return {
    rule: "RW-N01",
    severity: firstParty ? "low" : "high",
    title: `New ${firstParty ? "first-party" : "third-party"} destination: ${host}`,
    summary: `${labels.right} sends requests to ${host}${runtime ? " (seen at runtime)" : ""}, which nothing in ${labels.left} references.`,
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
    unknowns: sourceUnknowns(sources),
  };
};

// New request sites whose destination neither REA nor the module's literals give.
const unresolvedRequests = (context) =>
  newFacts(context.diff.app.requests)
    .filter(
      ({ fact }) =>
        !fact.data.endpoint && !context.claimed.nodes.has(fact.node_id),
    )
    .filter(
      ({ fact }) =>
        !(context.right.app?.urlLiterals ?? []).some(
          (literal) => literal.data.module === fact.data.module,
        ),
    )
    .map(({ fact, status }) => ({
      rule: "RW-N02",
      severity: "medium",
      title: `New request with an unresolved destination in ${fact.data.module}`,
      summary: `${context.labels.right} sends requests from ${fact.data.module}; neither REA nor the module's literals identify the host.`,
      why: "Unexplained outbound traffic is the main exfiltration path for compromised updates.",
      recommendation:
        "Capture the release's traffic or ask the vendor for the destination.",
      evidence: [
        cite(
          `${fact.data.method}() request in ${fact.data.module} (${absencePhrase(status, context.labels.left)})`,
          fact,
          APP_SOURCE,
        ),
      ],
      unknowns: ["REA did not resolve this request's destination."],
    }));

/** RW-N01 for every new host no other pack claimed, and RW-N02 for unresolved requests. */
export const networkPack = (context) =>
  packResult([
    ...[...context.network.fresh]
      .filter(([host]) => !context.claimed.hosts.has(host))
      .filter(([, sources]) =>
        sources.some((source) => source.kind !== "build-setting"),
      )
      .map(([host, sources]) => destinationFinding(host, sources, context)),
    ...unresolvedRequests(context),
  ]);
