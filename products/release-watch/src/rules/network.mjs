// Network destination rules for new outbound requests.
import {
  absencePhrase,
  cite,
  hostOf,
  isVendorHost,
  newFacts,
  reported,
  urlsIn,
} from "./shared.mjs";

const APP_SOURCE = "REA analyze_javascript_application";

/** Hosts the earlier release already referenced, from app literals and helper build settings. */
export const knownHosts = (release) => {
  const hosts = new Set();
  for (const literal of release.app?.urlLiterals ?? []) {
    const host = hostOf(literal.data.url);
    if (host) hosts.add(host);
  }
  for (const helper of release.helpers) {
    for (const value of Object.values(helper.go?.settings ?? {}))
      for (const url of urlsIn(value)) {
        const host = hostOf(url);
        if (host) hosts.add(host);
      }
  }
  return hosts;
};

const destinationsFor = (request, app) => {
  if (request.data.endpoint) {
    const host = hostOf(request.data.endpoint);
    return host
      ? [
          {
            host,
            url: request.data.endpoint,
            literal: null,
            resolvedByRea: true,
          },
        ]
      : [];
  }
  return app.urlLiterals
    .filter((literal) => literal.data.module === request.data.module)
    .map((literal) => ({
      host: hostOf(literal.data.url),
      url: literal.data.url,
      literal,
      resolvedByRea: false,
    }))
    .filter((destination) => destination.host !== null);
};

const contextEvidence = (request, app) => {
  const lines = app.timers
    .filter((timer) => timer.data.module === request.data.module)
    .map((timer) =>
      cite(`Scheduled with ${timer.data.method}()`, timer, APP_SOURCE),
    );
  const builtins = app.modules.get(request.data.module)?.builtins ?? new Set();
  if (builtins.has("node:os") || builtins.has("os"))
    lines.push(
      reported(
        `${request.data.module} also imports node:os, which exposes host and user account details`,
        "inferred",
        APP_SOURCE,
      ),
    );
  return lines;
};

const classify = (destinations, vendorDomains, previous) => {
  const thirdParty = destinations.filter(
    (destination) =>
      !isVendorHost(destination.host, vendorDomains) &&
      !previous.has(destination.host),
  );
  if (thirdParty.length > 0)
    return { severity: "high", focus: thirdParty, kind: "third-party" };
  const fresh = destinations.filter(
    (destination) => !previous.has(destination.host),
  );
  if (fresh.length > 0)
    return { severity: "low", focus: fresh, kind: "first-party" };
  return { severity: "info", focus: destinations, kind: "known" };
};

const destinationEvidence = (destination, kind) => {
  if (destination.resolvedByRea)
    return reported(
      `REA resolved the request endpoint to ${destination.url}`,
      "inferred",
      APP_SOURCE,
    );
  const binding = destination.literal.data.binding;
  return cite(
    `URL literal ${destination.url}${binding ? ` assigned to ${binding}` : ""}, in the same module as the request (${kind})`,
    destination.literal,
    APP_SOURCE,
  );
};

const TITLES = {
  "third-party": (hosts) => `New third-party data destination: ${hosts}`,
  "first-party": (hosts) => `New first-party network call: ${hosts}`,
  known: (hosts) => `New request to an already-known host: ${hosts}`,
};

/** One finding per new request site, graded by where it can send data. */
export const newNetworkDestinations = (context) => {
  const { right, left, diff, labels, options } = context;
  const app = right.app;
  if (!app) return [];
  const previous = knownHosts(left);
  return newFacts(diff.app.requests).map(({ fact: request, status }) => {
    const destinations = destinationsFor(request, app);
    const requestLine = cite(
      `${request.data.method}() request in ${request.data.module} (${absencePhrase(status, labels.left)})`,
      request,
      APP_SOURCE,
    );
    if (destinations.length === 0)
      return {
        rule: "RW-N02",
        severity: "medium",
        title: `New outbound request with an unresolved destination in ${request.data.module}`,
        summary: `${labels.right} sends requests from ${request.data.module}; neither REA nor the module's literals identify the host.`,
        why: "Unexplained outbound traffic is the main exfiltration path for compromised updates.",
        recommendation:
          "Capture the release's traffic in a sandbox or ask the vendor for the destination.",
        evidence: [requestLine, ...contextEvidence(request, app)],
        unknowns: ["REA did not resolve this request's destination."],
      };
    const { severity, focus, kind } = classify(
      destinations,
      options.vendorDomains,
      previous,
    );
    const hosts = [
      ...new Set(focus.map((destination) => destination.host)),
    ].join(", ");
    return {
      rule: "RW-N01",
      severity,
      title: TITLES[kind](hosts),
      summary:
        kind === "third-party"
          ? `${request.data.module} sends requests to ${hosts}, which neither ${labels.left} nor the vendor's declared domains use.`
          : `${request.data.module} sends requests to ${hosts}.`,
      why:
        kind === "third-party"
          ? "Data leaving to a host the vendor never used before is the pattern seen in compromised updates."
          : "New network behaviour from the vendor's own domain; usually a feature.",
      recommendation:
        kind === "third-party"
          ? "Block the release until the vendor names the processor and the data sent, or the host is allow-listed."
          : "Confirm the feature in the vendor's release notes.",
      evidence: [
        requestLine,
        ...focus.map((destination) => destinationEvidence(destination, kind)),
        ...contextEvidence(request, app),
      ],
      unknowns: destinations.some((destination) => !destination.resolvedByRea)
        ? [
            "REA did not resolve the request's URL argument; the destination is the URL literal defined in the same module.",
          ]
        : [],
    };
  });
};
