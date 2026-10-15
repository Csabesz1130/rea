// AI rules: new AI providers receiving data, credentials shipped in code, new
// AI or MCP SDKs, changed prompts and model output rendered as HTML.
import { createHash } from "node:crypto";

import {
  aiProviderOf,
  credentialOf,
  isAiEnvironmentKey,
  packageNameOf,
  sdkOf,
} from "../catalog.mjs";
import { sourceEvidence, sourceUnknowns } from "./network.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  heuristic,
  hostOf,
  newFacts,
  packResult,
} from "./shared.mjs";

const moduleOfSource = (source) =>
  source.request?.data.module ?? source.fact?.data?.module ?? null;

const providerFindings = (context) => {
  const { right, labels, network } = context;
  const findings = [];
  const hosts = [];
  for (const [host, sources] of network.fresh) {
    const provider = aiProviderOf(host);
    if (provider === null) continue;
    hosts.push(host);
    const fromBrowser =
      sources.some((source) => source.kind === "capture") ||
      sources.some((source) =>
        right.app?.browserModules.has(moduleOfSource(source)),
      );
    findings.push({
      rule: "RW-A01",
      severity: "high",
      title: fromBrowser
        ? `Browser code calls ${provider} directly (${host})`
        : `New AI provider receives data: ${provider} (${host})`,
      summary: `${labels.right} sends requests to ${provider}, which ${labels.left} never contacted.`,
      why: fromBrowser
        ? `Prompts and user data now go to ${provider} straight from users' browsers. A browser cannot authenticate to ${provider} without a credential anyone can read, unless the vendor issues short-lived tokens.`
        : `Prompts and user data now go to ${provider}. That is a new processor for privacy, contract and AI-governance reviews.`,
      recommendation: fromBrowser
        ? "Route model calls through the vendor's server, and confirm how the browser authenticates."
        : "Confirm the provider is covered by your data processing agreements and the vendor's AI disclosures.",
      evidence: sourceEvidence(sources, labels),
      unknowns: [
        ...sourceUnknowns(sources),
        "Release Watch does not see what the requests contain.",
      ],
    });
  }
  return { findings, hosts };
};

const credentialFindings = (context) => {
  const { left, right, labels } = context;
  if (!right.app) return [];
  const before = new Set(
    (left.app?.stringLiterals ?? []).map((fact) => fact.data.value),
  );
  return newFacts(context.diff.app.stringLiterals)
    .filter(({ fact }) => !before.has(fact.data.value))
    .flatMap(({ fact }) => {
      const credential = credentialOf(fact.data.value);
      if (credential === null) return [];
      const inBrowser = right.app.browserModules.has(fact.data.module);
      return [
        {
          rule: "RW-A02",
          severity: inBrowser ? "critical" : "high",
          title: `${credential.kind} shipped in ${inBrowser ? "browser code" : "code"}: ${fact.data.module}`,
          summary: `${labels.right} contains a string with the format of a ${credential.kind}${fact.data.binding ? `, assigned to ${fact.data.binding}` : ""}.`,
          why: inBrowser
            ? "Anyone who opens the site can read this key and use the account it belongs to."
            : "Keys in shipped code leak through packages, logs and support bundles; they belong in a secret store.",
          recommendation:
            "Revoke the key now, move the call behind a server, and review the key's usage logs.",
          evidence: [
            cite(
              `${credential.kind} ${credential.masked}${fact.data.binding ? ` assigned to ${fact.data.binding}` : ""}`,
              fact,
              APP_SOURCE,
              { redact: [{ value: fact.data.value, with: credential.masked }] },
            ),
          ],
          unknowns: [
            "Release Watch matched a documented key format; it cannot tell whether the key is live.",
            "The raw value remains in the saved REA Evidence under evidence/; treat that directory as sensitive.",
          ],
        },
      ];
    });
};

const sdkFindings = (context) => {
  const groups = new Map();
  const consider = ({ fact, status }) => {
    const sdk = sdkOf(fact.key);
    if (sdk === null) return;
    const name = packageNameOf(fact.key) ?? fact.key;
    if (!groups.has(name)) groups.set(name, { sdk, items: [] });
    groups.get(name).items.push({ fact, status });
  };
  newFacts(context.diff.app.imports).forEach(consider);
  newFacts(context.diff.app.packages).forEach(consider);
  const known = new Set(
    [
      ...(context.left.app?.imports ?? []),
      ...(context.left.app?.packages ?? []),
    ].map((fact) => packageNameOf(fact.key) ?? fact.key),
  );
  return [...groups]
    .filter(([name]) => !known.has(name))
    .map(([name, { sdk, items }]) => ({
      rule: "RW-A03",
      severity: sdk.kind === "mcp-server" ? "medium" : "low",
      title:
        sdk.kind === "mcp-server"
          ? `New MCP server: ${name}`
          : `New ${sdk.label}: ${name}`,
      summary:
        sdk.kind === "mcp-server"
          ? `${context.labels.right} now runs an MCP server that AI agents can call.`
          : `${context.labels.right} now uses ${name}.`,
      why:
        sdk.kind === "mcp-server"
          ? "Each MCP tool is an entry point that a model, and anyone who can steer it with a prompt, can invoke."
          : "The component now talks to AI models; prompts, user data and model output need review.",
      recommendation:
        sdk.kind === "mcp-server"
          ? "List the tools it exposes and what each can touch; require confirmation for tools with side effects."
          : "Review what data reaches the model and how its output is used.",
      evidence: items.map(({ fact, status }) =>
        cite(
          `${fact.data.module ? `${fact.data.module} imports` : "Installed package"} ${fact.key}${fact.data.version ? ` ${fact.data.version}` : ""} (${absencePhrase(status, context.labels.left)})`,
          fact,
          APP_SOURCE,
        ),
      ),
      unknowns: [],
    }));
};

const aiModules = (app) => {
  const modules = new Set();
  for (const [modulePath, entry] of app.modules)
    if (
      [...entry.externalImports].some((specifier) => sdkOf(specifier) !== null)
    )
      modules.add(modulePath);
  for (const read of app.configReads)
    if (isAiEnvironmentKey(read.data.key)) modules.add(read.data.module);
  for (const literal of app.urlLiterals)
    if (aiProviderOf(hostOf(literal.data.url)))
      modules.add(literal.data.module);
  return modules;
};

const isProse = (value) =>
  value.length >= 40 &&
  /\s/.test(value) &&
  !/^[a-z]+:\/\//i.test(value) &&
  credentialOf(value) === null;

const digest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);
const preview = (value) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
};

const promptFindings = (context) => {
  const { right, labels } = context;
  if (!right.app) return [];
  const modules = aiModules(right.app);
  return context.diff.app.stringLiterals
    .filter((item) => item.status === "changed")
    .filter((item) => item.right.every((fact) => modules.has(fact.data.module)))
    .filter((item) =>
      [...item.left, ...item.right].every((fact) => isProse(fact.data.value)),
    )
    .map((item) => {
      const [after] = item.right;
      const [beforeFact] = item.left;
      const name = after.data.binding ?? "a string literal";
      return {
        rule: "RW-A04",
        severity: "low",
        title: `Prompt text changed: ${name} in ${after.data.module}`,
        summary: `${name} in ${after.data.module} feeds an AI component and has new text in ${labels.right}.`,
        why: "Prompt changes alter model behaviour, safety instructions and what data the model is told to use; they deserve the same review as code.",
        recommendation:
          "Review the prompt diff with the owner of the AI feature.",
        evidence: [
          cite(
            `${labels.left}: "${preview(beforeFact.data.value)}" (${beforeFact.data.value.length} characters, sha256 ${digest(beforeFact.data.value)})`,
            beforeFact,
            APP_SOURCE,
          ),
          cite(
            `${labels.right}: "${preview(after.data.value)}" (${after.data.value.length} characters, sha256 ${digest(after.data.value)})`,
            after,
            APP_SOURCE,
          ),
        ],
        unknowns: [
          "REA keeps a string only when a variable starts with it; prompts passed inline to an SDK call are not visible, so an unchanged report does not prove unchanged prompts.",
        ],
      };
    });
};

const htmlSinkFindings = (context) => {
  const { right, labels, surfaces } = context;
  if (!right.app || !surfaces.includes("ai")) return [];
  return newFacts(context.diff.app.htmlSinks)
    .filter(({ fact }) => right.app.browserModules.has(fact.data.module))
    .flatMap(({ fact, status }) => {
      const request = right.app.requests.find(
        (candidate) => candidate.data.module === fact.data.module,
      );
      if (request === undefined) return [];
      const property = fact.data.sink.replace(/^(read|write):\//, "");
      return [
        {
          rule: "RW-A05",
          severity: "medium",
          title: `Model output may be rendered as HTML in ${fact.data.module}`,
          summary: `A new ${property} sink sits in browser code that also fetches data, in a component that calls AI models.`,
          why: "Model output is untrusted: a prompt-injected answer rendered as HTML runs script in the user's session.",
          recommendation:
            "Render model output as text, or sanitize it with an allow-list sanitizer before inserting HTML.",
          evidence: [
            cite(
              `${property} assignment or call (${absencePhrase(status, labels.left)})`,
              fact,
              APP_SOURCE,
            ),
            cite(
              `${request.data.method}() request in the same module`,
              request,
              APP_SOURCE,
            ),
            heuristic(
              "The component has an AI surface; Release Watch connects the sink and the request by module",
            ),
          ],
          unknowns: [
            "REA does not trace data from the response to the HTML sink.",
          ],
        },
      ];
    });
};

/** AI rules; claims AI provider hosts so RW-N01 does not repeat them. */
export const aiPack = (context) => {
  const providers = providerFindings(context);
  return packResult(
    [
      ...providers.findings,
      ...credentialFindings(context),
      ...sdkFindings(context),
      ...promptFindings(context),
      ...htmlSinkFindings(context),
    ],
    { hosts: providers.hosts },
  );
};
