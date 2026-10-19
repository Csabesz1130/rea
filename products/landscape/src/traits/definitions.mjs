// The traits Landscape maps: one property of a product's shipped code each,
// in the group a reader looks for it under. A capability is something a
// product offers; a risk is something it exposes its users to. Which REA
// facts establish each trait is the group module's reading (ai.mjs,
// agent.mjs, system.mjs, data.mjs, app.mjs); every one is Landscape's
// grouping of facts Release Watch projects from REA Evidence.

export const GROUPS = [
  { id: "ai", label: "AI models" },
  { id: "agent", label: "Agent tools (MCP)" },
  { id: "system", label: "Machine access" },
  { id: "data", label: "Data leaving the machine" },
  { id: "desktop", label: "Desktop (Electron)" },
  { id: "web", label: "Web" },
];

const trait = (id, group, kind, label) => ({ id, group, kind, label });

export const TRAITS = {
  hostedModel: trait("ai.hosted", "ai", "capability", "Uses a hosted AI model"),
  severalProviders: trait(
    "ai.multi-provider",
    "ai",
    "capability",
    "Supports several AI providers",
  ),
  localModel: trait(
    "ai.local-model",
    "ai",
    "capability",
    "Runs on a local model",
  ),
  environmentKey: trait(
    "ai.environment-key",
    "ai",
    "capability",
    "Reads AI provider keys from the environment",
  ),
  browserModel: trait(
    "ai.browser-call",
    "ai",
    "risk",
    "Calls an AI provider from browser code",
  ),
  shippedKey: trait(
    "ai.shipped-key",
    "ai",
    "risk",
    "Ships a credential in its code",
  ),
  mcpServer: trait(
    "agent.mcp-server",
    "agent",
    "capability",
    "Is an MCP server",
  ),
  mcpClient: trait(
    "agent.mcp-client",
    "agent",
    "capability",
    "Connects to MCP servers",
  ),
  toolProcess: trait(
    "agent.tool-process",
    "agent",
    "risk",
    "An MCP tool reaches process execution",
  ),
  process: trait("system.process", "system", "capability", "Starts processes"),
  shell: trait(
    "system.shell",
    "system",
    "risk",
    "Runs commands through a shell",
  ),
  terminal: trait(
    "system.terminal",
    "system",
    "capability",
    "Runs interactive terminal sessions",
  ),
  runtimeCode: trait(
    "system.runtime-code",
    "system",
    "risk",
    "Evaluates code built at runtime",
  ),
  remote: trait("data.remote", "data", "capability", "Contacts remote hosts"),
  telemetry: trait(
    "data.telemetry",
    "data",
    "risk",
    "Sends analytics, telemetry or error reports",
  ),
  updates: trait(
    "data.update-check",
    "data",
    "capability",
    "Checks a registry for updates",
  ),
  plainHttp: trait(
    "data.plain-http",
    "data",
    "risk",
    "Sends to a remote host over plain HTTP",
  ),
  electron: trait(
    "desktop.electron",
    "desktop",
    "capability",
    "Is an Electron desktop app",
  ),
  weakWindow: trait(
    "desktop.weak-window",
    "desktop",
    "risk",
    "A window turns off an Electron safeguard",
  ),
  pages: trait("web.pages", "web", "capability", "Ships web pages"),
  offline: trait(
    "web.offline",
    "web",
    "capability",
    "Registers a service worker",
  ),
  browserStorage: trait(
    "web.storage",
    "web",
    "capability",
    "Keeps data in browser storage",
  ),
  foreignScript: trait(
    "web.foreign-script",
    "web",
    "risk",
    "Loads scripts from other hosts",
  ),
};

/** The trait for calls to one AI provider (`OpenAI`), placed before the other AI traits. */
export const providerTrait = (provider) => ({
  id: `ai.provider:${provider}`,
  group: "ai",
  kind: "capability",
  label: `Calls ${provider}`,
  provider,
});

/** True for a provider trait's id. */
export const isProviderTrait = (id) => id.startsWith("ai.provider:");
