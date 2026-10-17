// AI rules: where prompts go (ai-placement.mjs), credentials shipped in
// code, new AI or MCP SDKs, changed prompts (prompts.mjs) and model output
// rendered as HTML.
import { credentialOf, credentialsIn } from "../catalog.mjs";
import { movedFrom } from "../moves.mjs";
import { mcpServers, sdkUses } from "../surfaces.mjs";
import {
  BROWSER_CODE,
  BROWSER_LIMIT,
  SERVER_LIMIT,
  providerFindings,
  sdkPlacementFindings,
  serverLine,
  serverModules,
  union,
} from "./ai-placement.mjs";
import { oldRelease } from "./network.mjs";
import { promptFindings } from "./prompts.mjs";
import {
  componentAbsence,
  heldElsewhere,
  perComponent,
} from "./component-absence.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  newGroups,
  packResult,
} from "./shared.mjs";

// Credential-format tokens in one string: the whole literal, or tokens
// inside a longer one (a header value, a config blob).
const credentialTokens = (value) => {
  const whole = credentialOf(value);
  return whole ? [{ value, ...whole }] : credentialsIn(value);
};

// Strings that can hold a key, with the fact that locates each: string
// literals and the URLs REA resolved for requests (a key in a query string).
const keyCarriers = (app) => [
  ...(app?.stringLiterals ?? []).map((fact) => ({
    fact,
    value: fact.data.value,
    module: fact.data.module,
    binding: fact.data.binding,
  })),
  ...(app?.endpoints ?? []).map((fact) => ({
    fact,
    value: fact.data.value,
    module: fact.location?.file ?? null,
    binding: null,
  })),
];

const tokensOf = (carriers, keep = () => true) =>
  new Set(
    carriers
      .filter(keep)
      .flatMap((carrier) =>
        credentialTokens(carrier.value).map((token) => token.value),
      ),
  );

/**
 * Credential tokens one app ships: `all`, those in browser code, those in
 * code Release Watch places neither in a page nor on a server (`unplaced`),
 * each a Set of values, and `server`, a Map from each token in server code
 * (serverModules) to the module holding it and why (`{ module, via }`).
 */
export const shippedTokens = (app) => {
  const carriers = keyCarriers(app);
  const server = serverModules(app);
  const inBrowser = (carrier) => app?.browserModules.has(carrier.module);
  return {
    all: tokensOf(carriers),
    browser: tokensOf(carriers, inBrowser),
    unplaced: tokensOf(
      carriers,
      (carrier) => !inBrowser(carrier) && !server.has(carrier.module),
    ),
    server: new Map(
      carriers
        .filter((carrier) => server.has(carrier.module))
        .flatMap((carrier) =>
          credentialTokens(carrier.value).map((token) => [
            token.value,
            { module: carrier.module, via: server.get(carrier.module) },
          ]),
        ),
    ),
  };
};

// Where a key the old release shipped outside browser code was: the old
// carrier when every one was server code, else null (it may have been
// browser code Release Watch does not classify).
const serverOrigin = (context, shipped) => {
  const unplaced = union(shipped.unplaced, context.baseline.unplacedTokens);
  const server = new Map([
    ...(context.baseline.serverTokens ?? []),
    ...shipped.server,
  ]);
  return (value) => (unplaced.has(value) ? null : (server.get(value) ?? null));
};

// One RW-A02 finding. A key the old release shipped is reported again
// only in browser code: critical when every old carrier was server code
// (`origin`), high when one may have been browser code Release Watch does
// not classify.
const credentialFinding = (context, { carrier, token, moved, origin }) => {
  const { labels } = context;
  const inBrowser = context.right.app.browserModules.has(carrier.module);
  const binding = carrier.binding ? ` assigned to ${carrier.binding}` : "";
  const unplaced = moved && origin === null;
  const before = origin
    ? `${labels.left} had the same key only in code Release Watch takes as server code (${origin.module})`
    : `${labels.left} had the same key only in code it did not classify that way`;
  return {
    rule: "RW-A02",
    severity: inBrowser && !unplaced ? "critical" : "high",
    title: `${token.kind} ${moved ? "now in" : "shipped in"} ${inBrowser ? "browser code" : "code"}: ${carrier.module}`,
    summary: moved
      ? `${labels.right} ships a ${token.kind} in code Release Watch classifies as browser code; ${before}.`
      : `${labels.right} contains a string with the format of a ${token.kind}${binding}.`,
    why: inBrowser
      ? "Anyone who opens the site can read this key and use the account it belongs to."
      : "Keys in shipped code leak through packages, logs and support bundles; they belong in a secret store.",
    recommendation:
      "Revoke the key now, move the call behind a server, and review the key's usage logs.",
    evidence: [
      cite(
        `${token.kind} ${token.masked}${binding} (${moved ? `also in a string REA reported for ${labels.left}` : `not in any string REA reported for ${labels.left}`})`,
        carrier.fact,
        APP_SOURCE,
      ),
      ...(inBrowser ? [BROWSER_CODE] : []),
      ...(origin ? [serverLine(oldRelease(context), origin)] : []),
      ...(unplaced
        ? [
            heuristic(
              `Release Watch did not classify the ${labels.left} code that held this key as browser code`,
            ),
          ]
        : []),
    ],
    unknowns: [
      ...(unplaced ? [BROWSER_LIMIT] : []),
      ...(origin ? [SERVER_LIMIT] : []),
      "Release Watch matched a documented key format; it cannot tell whether the key is live.",
      "REA reports strings assigned to variables and URLs it resolved; a key written inline in a call or header is not seen.",
      "The raw value remains in the saved REA Evidence under evidence/; treat that directory as sensitive.",
    ],
  };
};

/**
 * RW-A02. Every new-side string is checked, not only new or changed keys, so
 * a key added to an existing variable or embedded in a longer string is
 * found. A key the old release already shipped is reported again only when
 * it moved into browser code.
 */
const credentialFindings = (context) => {
  const { left, right } = context;
  if (!right.app) return [];
  // What this component and every component of the old release shipped, so
  // a key that moved between components is not new.
  const shipped = shippedTokens(left.app);
  const before = union(shipped.all, context.baseline.tokens);
  const beforeInBrowser = union(
    shipped.browser,
    context.baseline.browserTokens,
  );
  const originOf = serverOrigin(context, shipped);
  const seen = new Set();
  return keyCarriers(right.app).flatMap((carrier) => {
    const inBrowser = right.app.browserModules.has(carrier.module);
    return credentialTokens(carrier.value)
      .filter(
        (token) =>
          !before.has(token.value) ||
          (inBrowser && !beforeInBrowser.has(token.value)),
      )
      .filter((token) => {
        const identity = `${carrier.module}\u0000${token.value}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .map((token) => {
        const moved = before.has(token.value);
        return credentialFinding(context, {
          carrier,
          token,
          moved,
          origin: moved ? originOf(token.value) : null,
        });
      });
  });
};

const statusesOf = (items) =>
  new Map(items.map((item) => [item.key, item.status]));

// What RW-A03 says about a new SDK: a new MCP server, an MCP server SDK
// or framework in a component that already served MCP through another one
// (it switched packages and runs no new server), another MCP SDK package,
// or an AI SDK.
const SDK_TEXT = {
  server: (context) => ({
    severity: "medium",
    title: (name) => `New MCP server: ${name}`,
    summary: () =>
      `${context.labels.right} now runs an MCP server that AI agents can call.`,
    why: "Each MCP tool is an entry point that a model, and anyone who can steer it with a prompt, can invoke.",
    recommendation:
      "List the tools it exposes and what each can touch; require confirmation for tools with side effects.",
  }),
  switched: (context, served) => ({
    severity: "low",
    title: (name, sdk) => `New ${sdk.label}: ${name}`,
    summary: (name) =>
      `${context.labels.right} now serves MCP through ${name}; ${context.labels.left} already ran an MCP server through ${served.join(", ")}.`,
    why: "A different server SDK can change how tools are registered, dispatched and validated.",
    recommendation:
      "Check that the server exposes the same tools, with the same handlers, as before.",
  }),
  other: (context) => ({
    severity: "low",
    title: (name, sdk) => `New ${sdk.label}: ${name}`,
    summary: (name) => `${context.labels.right} now uses ${name}.`,
    why: "The component now talks to AI models; prompts, user data and model output need review.",
    recommendation:
      "Review what data reaches the model and how its output is used.",
  }),
  mcp: (context, served, sdk) => ({
    severity: "low",
    title: (name) => `New ${sdk.label}: ${name}`,
    summary: (name) =>
      `${context.labels.right} now uses ${name}${MCP_TEXT[sdk.role].does}.`,
    why: MCP_TEXT[sdk.role].why,
    recommendation: MCP_TEXT[sdk.role].recommendation,
  }),
};

// An MCP SDK package that runs no server in the component, by its role
// (catalog.mjs): it talks to MCP servers or agents, not to AI models.
const MCP_TEXT = {
  client: {
    does: ", which connects to MCP servers and calls their tools",
    why: "What an MCP server's tools return comes from outside the component and can steer a model that reads it, and those tools act with the access the component gives them.",
    recommendation:
      "Check which MCP servers it connects to, what it sends them and how their results are used.",
  },
  transport: {
    does: ", which serves an MCP server over HTTP",
    why: "An HTTP transport makes a server's tools reachable to anyone who can reach its endpoint, not only to a local agent.",
    recommendation:
      "Check where the endpoint listens, how it authenticates callers and which tools it exposes.",
  },
  shared: {
    does: "",
    why: "MCP SDK code connects a component to MCP servers or serves one; Release Watch does not establish which from this package.",
    recommendation:
      "Check whether the component now connects to MCP servers or exposes tools, and to whom.",
  },
};

// An SDK RW-A01 reports in browser code is not repeated.
const sdkFindings = (context, placed) => {
  const before = new Set([
    ...sdkUses(context.left.app).keys(),
    ...context.baseline.sdks,
    ...placed,
  ]);
  const statuses = new Map([
    ...statusesOf(context.diff.app.imports),
    ...statusesOf(context.diff.app.packages),
  ]);
  const served = mcpServers(context.left.app).map(({ name }) => name);
  return [...sdkUses(context.right.app)]
    .filter(([name]) => !before.has(name))
    .map(([name, { sdk, facts }]) => {
      const kind =
        sdk.kind === "mcp"
          ? "mcp"
          : sdk.kind !== "mcp-server"
            ? "other"
            : served.length > 0
              ? "switched"
              : "server";
      const text = SDK_TEXT[kind](context, served, sdk);
      return {
        rule: "RW-A03",
        severity: text.severity,
        title: text.title(name, sdk),
        summary: text.summary(name),
        why: text.why,
        recommendation: text.recommendation,
        evidence: facts.map((fact) =>
          cite(
            `${fact.data.module ? `${fact.data.module} imports` : "Installed package"} ${fact.key}${fact.data.version ? ` ${fact.data.version}` : ""} (${componentAbsence(context, { status: statuses.get(fact.key), held: false })})`,
            fact,
            APP_SOURCE,
          ),
        ),
        unknowns: [],
      };
    });
};

const htmlSinkFindings = (context) => {
  const { right, surfaces } = context;
  if (!right.app || !surfaces.includes("ai")) return [];
  return (
    newGroups(context.diff.app.htmlSinks)
      .filter((group) =>
        right.app.browserModules.has(group.facts[0].data.module),
      )
      // A sink whose file moved unchanged from another component is not new.
      .filter(
        (group) =>
          !context.moves.htmlSinks ||
          movedFrom(context.moves.htmlSinks, group.facts) === null,
      )
      .flatMap((group) => {
        const [fact] = group.facts;
        const request = right.app.requests.find(
          (candidate) => candidate.data.module === fact.data.module,
        );
        if (request === undefined) return [];
        const property = fact.data.sink.replace(/^(read|write):\//, "");
        const held = heldElsewhere(context, "htmlSinks", group);
        return [
          {
            rule: "RW-A05",
            severity: "medium",
            title: `Model output may be rendered as HTML in ${fact.data.module}`,
            summary: `A new ${property} sink sits in browser code that also fetches data, in a component that calls AI models (${componentAbsence(context, { ...group, held, had: "had one in a module at this path" })}).`,
            why: "Model output is untrusted: a prompt-injected answer rendered as HTML runs script in the user's session.",
            recommendation:
              "Render model output as text, or sanitize it with an allow-list sanitizer before inserting HTML.",
            evidence: [
              ...group.facts.map((site) =>
                cite(`${property} assignment or call`, site, APP_SOURCE),
              ),
              cite(
                `${request.data.method}() request in the same module`,
                request,
                APP_SOURCE,
              ),
              BROWSER_CODE,
              heuristic(
                "The component has an AI surface; Release Watch connects the sink and the request by module",
              ),
            ],
            unknowns: [
              "REA does not trace data from the response to the HTML sink.",
              ...(held ? [perComponent("HTML sinks")] : []),
            ],
          },
        ];
      })
  );
};

/** AI rules; claims AI provider hosts so RW-N01 does not repeat them. */
export const aiPack = (context) => {
  const providers = providerFindings(context);
  const placements = sdkPlacementFindings(context);
  return packResult(
    [
      ...providers.findings,
      ...placements.findings,
      ...credentialFindings(context),
      ...sdkFindings(context, placements.sdks),
      ...promptFindings(context),
      ...htmlSinkFindings(context),
    ],
    { hosts: providers.hosts },
  );
};
