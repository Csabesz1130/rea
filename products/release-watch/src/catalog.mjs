// Product knowledge Release Watch applies to REA facts: which hosts belong to
// AI providers, which packages are AI or MCP SDKs, HTTP clients or process
// libraries, which literal shapes are vendor credentials, which response
// headers carry security policy, and Node's child_process and module
// built-ins.
// Matches here are Release Watch heuristics, never REA observations.

const exactOrSuffix = (host, entry) =>
  entry.host !== undefined
    ? host === entry.host
    : entry.suffix !== undefined
      ? host.endsWith(entry.suffix)
      : entry.pattern.test(host);

const AI_PROVIDERS = [
  { host: "api.openai.com", provider: "OpenAI" },
  { host: "api.anthropic.com", provider: "Anthropic" },
  { host: "generativelanguage.googleapis.com", provider: "Google Gemini" },
  {
    pattern: /^([a-z0-9-]+-)?aiplatform\.googleapis\.com$/,
    provider: "Google Vertex AI",
  },
  { suffix: ".openai.azure.com", provider: "Azure OpenAI" },
  {
    pattern: /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/,
    provider: "Amazon Bedrock",
  },
  { host: "api.mistral.ai", provider: "Mistral" },
  { host: "api.cohere.com", provider: "Cohere" },
  { host: "api.cohere.ai", provider: "Cohere" },
  { host: "api.groq.com", provider: "Groq" },
  { host: "api.together.xyz", provider: "Together AI" },
  { host: "api.fireworks.ai", provider: "Fireworks AI" },
  { host: "openrouter.ai", provider: "OpenRouter" },
  { host: "api.deepseek.com", provider: "DeepSeek" },
  { host: "api.perplexity.ai", provider: "Perplexity" },
  { host: "api.x.ai", provider: "xAI" },
  { host: "api-inference.huggingface.co", provider: "Hugging Face" },
  { host: "router.huggingface.co", provider: "Hugging Face" },
  { host: "api.replicate.com", provider: "Replicate" },
];

/** The AI provider a host belongs to, or null. */
export const aiProviderOf = (host) =>
  host === null
    ? null
    : (AI_PROVIDERS.find((entry) => exactOrSuffix(host, entry))?.provider ??
      null);

// `provider` names the one provider whose API an SDK's client calls itself.
// Frameworks and UI hooks (Vercel AI SDK, LangChain) may call the vendor's
// own server instead, and Ollama a local one, so they name none.
const AI_SDKS = [
  { name: "openai", label: "OpenAI SDK", provider: "OpenAI" },
  { name: "@openai/agents", label: "OpenAI Agents SDK", provider: "OpenAI" },
  { name: "@anthropic-ai/sdk", label: "Anthropic SDK", provider: "Anthropic" },
  {
    name: "@anthropic-ai/claude-agent-sdk",
    label: "Claude Agent SDK",
    provider: "Anthropic",
  },
  {
    name: "@google/genai",
    label: "Google Gen AI SDK",
    provider: "Google Gemini",
  },
  {
    name: "@google/generative-ai",
    label: "Google Generative AI SDK",
    provider: "Google Gemini",
  },
  {
    name: "@google-cloud/vertexai",
    label: "Vertex AI SDK",
    provider: "Google Vertex AI",
  },
  {
    name: "@aws-sdk/client-bedrock-runtime",
    label: "Amazon Bedrock SDK",
    provider: "Amazon Bedrock",
  },
  { name: "@mistralai/mistralai", label: "Mistral SDK", provider: "Mistral" },
  { name: "cohere-ai", label: "Cohere SDK", provider: "Cohere" },
  { name: "groq-sdk", label: "Groq SDK", provider: "Groq" },
  { name: "ollama", label: "Ollama client" },
  { name: "ai", label: "Vercel AI SDK" },
  { scope: "@ai-sdk/", label: "Vercel AI SDK provider" },
  { name: "langchain", label: "LangChain" },
  { scope: "@langchain/", label: "LangChain" },
  { name: "llamaindex", label: "LlamaIndex" },
  {
    name: "@huggingface/inference",
    label: "Hugging Face Inference",
    provider: "Hugging Face",
  },
  { name: "replicate", label: "Replicate client", provider: "Replicate" },
];

const MCP_SERVER = /^@modelcontextprotocol\/sdk\/server(\/|$)/;
const MCP_ANY = /^@modelcontextprotocol\/sdk(\/|$)/;

/** The npm package name a module specifier refers to, or null for relative and URL specifiers. */
export const packageNameOf = (specifier) => {
  if (typeof specifier !== "string" || specifier.length === 0) return null;
  if (/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/**
 * Classify an import specifier or package name: `{ kind: "mcp-server" | "mcp" | "ai", label }`
 * for AI and MCP SDKs, with `provider` for an AI SDK that calls one
 * provider's API itself, otherwise null.
 */
export const sdkOf = (specifier) => {
  if (MCP_SERVER.test(specifier))
    return { kind: "mcp-server", label: "MCP server SDK" };
  if (MCP_ANY.test(specifier)) return { kind: "mcp", label: "MCP SDK" };
  const name = packageNameOf(specifier);
  if (name === null) return null;
  const entry = AI_SDKS.find((sdk) =>
    sdk.name !== undefined ? sdk.name === name : name.startsWith(sdk.scope),
  );
  return entry
    ? { kind: "ai", label: entry.label, provider: entry.provider ?? null }
    : null;
};

const AI_ENVIRONMENT = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
]);

/** True when an environment variable name is a documented AI provider setting. */
export const isAiEnvironmentKey = (key) => AI_ENVIRONMENT.has(key);

// Documented credential formats: a pattern body, the label, and how many
// leading characters are a public prefix that may be shown.
const CREDENTIALS = [
  { body: "sk-ant-[A-Za-z0-9_-]{20,}", kind: "Anthropic API key", keep: 7 },
  {
    body: "sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}",
    kind: "OpenAI API key",
    keep: 8,
  },
  { body: "sk-[A-Za-z0-9]{32,}", kind: "OpenAI API key", keep: 3 },
  { body: "AIza[0-9A-Za-z_-]{35}", kind: "Google API key", keep: 4 },
  { body: "gsk_[A-Za-z0-9]{40,}", kind: "Groq API key", keep: 4 },
  { body: "hf_[A-Za-z0-9]{30,}", kind: "Hugging Face token", keep: 3 },
  { body: "r8_[A-Za-z0-9]{30,}", kind: "Replicate token", keep: 3 },
  { body: "gh[pousr]_[A-Za-z0-9]{36,}", kind: "GitHub token", keep: 4 },
  { body: "github_pat_[A-Za-z0-9_]{22,}", kind: "GitHub token", keep: 11 },
  { body: "xox[abprs]-[A-Za-z0-9-]{10,}", kind: "Slack token", keep: 5 },
  { body: "(?:AKIA|ASIA)[A-Z0-9]{16}", kind: "AWS access key ID", keep: 4 },
  {
    body: "(?:sk|rk)_live_[A-Za-z0-9]{20,}",
    kind: "Stripe secret key",
    keep: 8,
  },
].map((entry) => ({
  ...entry,
  whole: new RegExp(`^${entry.body}$`),
  // Inside text: not preceded or followed by another token character.
  inside: new RegExp(`(?<![A-Za-z0-9_-])${entry.body}(?![A-Za-z0-9_-])`, "g"),
}));

/** Show a credential's documented prefix, its last four characters and its length, never the rest. */
export const maskCredential = (value, keep) =>
  `${value.slice(0, keep)}…${value.slice(-4)} (${value.length} characters)`;

/** `{ kind, masked }` when a whole literal has a documented credential format, otherwise null. */
export const credentialOf = (value) => {
  if (typeof value !== "string") return null;
  const entry = CREDENTIALS.find((credential) => credential.whole.test(value));
  return entry
    ? { kind: entry.kind, masked: maskCredential(value, entry.keep) }
    : null;
};

/** Every credential-format token inside a longer text, with its kind. */
export const credentialsIn = (text) =>
  typeof text !== "string"
    ? []
    : CREDENTIALS.flatMap((entry) =>
        [...text.matchAll(entry.inside)].map((match) => ({
          value: match[0],
          kind: entry.kind,
          masked: maskCredential(match[0], entry.keep),
        })),
      );

// Request header and query parameter names that carry API credentials. REA
// redacts Authorization and cookies itself; these names it keeps verbatim.
const CREDENTIAL_HEADERS = new Set(["x-api-key", "api-key", "x-goog-api-key"]);
const CREDENTIAL_QUERY = new Set(["api_key", "apikey", "access_token"]);

export const isCredentialHeader = (name) =>
  CREDENTIAL_HEADERS.has(String(name).toLowerCase());
export const isCredentialQuery = (name) =>
  CREDENTIAL_QUERY.has(String(name).toLowerCase());

/** Response headers that carry browser security policy, with the cost of losing each. */
export const SECURITY_HEADERS = {
  "content-security-policy": {
    label: "Content-Security-Policy",
    removed: "high",
  },
  "strict-transport-security": {
    label: "Strict-Transport-Security",
    removed: "high",
  },
  "x-frame-options": { label: "X-Frame-Options", removed: "medium" },
  "x-content-type-options": {
    label: "X-Content-Type-Options",
    removed: "medium",
  },
  "referrer-policy": { label: "Referrer-Policy", removed: "medium" },
  "permissions-policy": { label: "Permissions-Policy", removed: "medium" },
  "cross-origin-opener-policy": {
    label: "Cross-Origin-Opener-Policy",
    removed: "medium",
  },
};

// DOM properties and methods that parse HTML from a string.
export const HTML_SINKS = new Set([
  "write:/innerHTML",
  "write:/outerHTML",
  "read:/insertAdjacentHTML",
  "read:/write",
  "read:/writeln",
]);

// Hosts whose URLs in code name XML namespaces and schemas, not destinations.
const NAMESPACE_HOSTS = new Set([
  "www.w3.org",
  "schemas.openxmlformats.org",
  "schemas.microsoft.com",
  "ns.adobe.com",
  "purl.org",
  "xmlns.com",
]);

/** True when a host's URLs are identifiers, such as the SVG namespace, rather than places code sends data. */
export const isNamespaceHost = (host) => NAMESPACE_HOSTS.has(host);

// HTTP client packages whose requests REA's request extraction may not
// model. Release Watch only notes that they are imported.
const HTTP_CLIENTS = new Set([
  "axios",
  "got",
  "node-fetch",
  "undici",
  "superagent",
  "ky",
  "request",
  "needle",
  "ofetch",
  "cross-fetch",
]);

/** True when a package name is an HTTP client library. */
export const isHttpClient = (name) => HTTP_CLIENTS.has(name);

// Packages that start processes for their caller. REA's child-process
// extraction models node:child_process calls only, so processes these
// start are not classified. Release Watch only notes that they are imported.
const PROCESS_LIBRARIES = new Set([
  "execa",
  "cross-spawn",
  "shelljs",
  "zx",
  "node-pty",
  "@lydell/node-pty",
  "@homebridge/node-pty-prebuilt-multiarch",
  "tinyexec",
  "nano-spawn",
  "sudo-prompt",
  "@vscode/sudo-prompt",
  "@npmcli/promise-spawn",
  "child-process-promise",
  "foreground-child",
]);

/** True when a package name is a library that starts processes. */
export const isProcessLibrary = (name) => PROCESS_LIBRARIES.has(name);

// Node's child_process module, by either specifier.
const PROCESS_MODULE = /^(?:node:)?child_process$/;

/** True when an import specifier names Node's child_process module. */
export const isProcessModule = (specifier) =>
  typeof specifier === "string" && PROCESS_MODULE.test(specifier);

// The child_process exports that start a process. A module REA does not
// resolve counts as possibly child_process only through a read of one of
// these on what it loads (Release Watch's correlation).
const PROCESS_EXPORTS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
]);

/** True when a name is a child_process export that starts a process. */
export const isProcessExport = (name) => PROCESS_EXPORTS.has(name);

// Node's `module` built-in, which exports createRequire.
const NODE_MODULE = /^(?:node:)?module$/;

/** True when an import specifier names Node's module built-in. */
export const isNodeModule = (specifier) =>
  typeof specifier === "string" && NODE_MODULE.test(specifier);
