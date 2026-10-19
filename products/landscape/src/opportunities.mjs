// Openings a map suggests: something few or none of the compared products
// offer ("white space"), or a risk most of them share that a new product can
// avoid and say so ("inversion"). Each one is Landscape's correlation of the
// map's counts with a positioning that follows from them, not an REA
// observation; the counts it cites are the map's.
import { TRAITS } from "./traits/definitions.mjs";

const EMPTY = { yes: 0, likely: 0, no: 0, unknown: 0, held: 0 };

/** "3 of 5", with how many only likely and how many unknown. */
export const countText = (counts, n) => {
  const notes = [
    ...(counts.likely > 0 ? [`${counts.likely} only likely`] : []),
    ...(counts.unknown > 0 ? [`${counts.unknown} unknown`] : []),
  ];
  return `${counts.held} of ${n}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
};

const products = (count) => `${count} product${count === 1 ? "" : "s"}`;

/** The form of a verb that agrees with a count: `verb(1, "sends", "send")`. */
export const verb = (count, one, many) => (count === 1 ? one : many);

// "2 of the 3 products that start processes", or "the one product that
// starts processes" when there is one.
const share = (count, total, one, many) =>
  total === 1
    ? `the one product that ${one}`
    : `${count} of the ${total} products that ${many}`;

const capital = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;

const valuesOf = (row) =>
  row
    ? [
        ...new Set(
          Object.values(row.cells).flatMap((cell) => cell.values ?? []),
        ),
      ]
    : [];

const CATALOG = [
  {
    id: "local-first",
    kind: "white space",
    title: "Local-first AI",
    rows: [TRAITS.hostedModel, TRAITS.localModel],
    applies: ({ count }) =>
      count(TRAITS.hostedModel).held > 0 &&
      count(TRAITS.localModel).held * 2 <= count(TRAITS.hostedModel).held,
    finding: ({ count, n }) =>
      `${countText(count(TRAITS.hostedModel), n)} ${verb(count(TRAITS.hostedModel).held, "sends", "send")} prompts to a hosted model; ${countText(count(TRAITS.localModel), n)} ${verb(count(TRAITS.localModel).held, "runs", "run")} on a local one.`,
    positioning:
      "Run on a local model by default (Ollama or LM Studio), so code and data stay on the user's machine, and offer hosted models as an opt-in.",
  },
  {
    id: "any-model",
    kind: "white space",
    title: "Bring any model",
    rows: [TRAITS.hostedModel, TRAITS.severalProviders],
    applies: ({ count }) => {
      const hosted = count(TRAITS.hostedModel).held;
      return (
        hosted >= 2 &&
        (hosted - count(TRAITS.severalProviders).held) * 2 > hosted
      );
    },
    finding: ({ count }) => {
      const hosted = count(TRAITS.hostedModel).held;
      const single = hosted - count(TRAITS.severalProviders).held;
      return `${single} of the ${products(hosted)} that use a hosted model ${verb(single, "calls", "call")} one provider only.`;
    },
    positioning:
      "Let users bring any model: several providers behind one setting, including the OpenAI-compatible endpoints most providers and local servers offer.",
  },
  {
    id: "no-telemetry",
    kind: "inversion",
    title: "No telemetry",
    rows: [TRAITS.telemetry],
    applies: ({ count }) => count(TRAITS.telemetry).held > 0,
    finding: ({ count, n, row }) =>
      `${countText(count(TRAITS.telemetry), n)} ${verb(count(TRAITS.telemetry).held, "sends", "send")} analytics, telemetry or error reports (${valuesOf(row(TRAITS.telemetry)).join(", ")}).`,
    positioning:
      "Send no telemetry, or only what users switch on, say so where they choose a product, and prove it on every release: Release Watch reports a release that adds a destination.",
  },
  {
    id: "no-shell",
    kind: "inversion",
    title: "Commands without a shell",
    rows: [TRAITS.process, TRAITS.shell],
    applies: ({ count }) => count(TRAITS.shell).held > 0,
    finding: ({ count }) => {
      const shell = count(TRAITS.shell);
      return `${capital(share(shell.held, count(TRAITS.process).held, "starts processes", "start processes"))} ${verb(shell.held, "runs", "run")} commands through a shell${shell.unknown > 0 ? `; for ${shell.unknown} more, REA's facts cannot tell` : ""}.`;
    },
    positioning:
      "Run commands without a shell: one argument list per command (execFile), an allowlist of programs, and the exact command shown to the user before it runs.",
  },
  {
    id: "narrow-tools",
    kind: "inversion",
    title: "Narrow agent tools",
    rows: [TRAITS.mcpServer, TRAITS.toolProcess],
    applies: ({ count }) => count(TRAITS.toolProcess).held > 0,
    finding: ({ count }) => {
      const tools = count(TRAITS.toolProcess);
      return `${capital(share(tools.held, count(TRAITS.mcpServer).held, "serves MCP tools", "serve MCP tools"))} ${verb(tools.held, "has", "have")} a tool whose code reaches process execution${tools.unknown > 0 ? `; for ${tools.unknown} more, REA's facts cannot tell` : ""}.`;
    },
    positioning:
      "Give agents narrow tools instead of a general command runner: one tool per task, typed arguments, a confirmation step for anything that changes the machine, and a log of what ran.",
  },
  {
    id: "agent-ready",
    kind: "white space",
    title: "Usable by agents",
    rows: [TRAITS.mcpServer],
    applies: ({ count, n }) => n >= 2 && count(TRAITS.mcpServer).held === 0,
    finding: ({ n }) => `None of the ${products(n)} serves MCP tools.`,
    positioning:
      "Ship an MCP server beside the product, so agents such as Claude, Cursor and VS Code can use it directly.",
  },
  {
    id: "keys-off-client",
    kind: "inversion",
    title: "Keys stay off the client",
    rows: [TRAITS.browserModel, TRAITS.shippedKey],
    applies: ({ count }) =>
      count(TRAITS.browserModel).held + count(TRAITS.shippedKey).held > 0,
    finding: ({ count, n }) =>
      `${countText(count(TRAITS.browserModel), n)} ${verb(count(TRAITS.browserModel).held, "calls", "call")} an AI provider from browser code; ${countText(count(TRAITS.shippedKey), n)} ${verb(count(TRAITS.shippedKey).held, "ships", "ship")} a credential in the code.`,
    positioning:
      "Keep provider keys off the client: keys the user holds locally, or a server that holds them and enforces limits.",
  },
  {
    id: "encrypted",
    kind: "inversion",
    title: "Encrypted everywhere",
    rows: [TRAITS.plainHttp],
    applies: ({ count }) => count(TRAITS.plainHttp).held > 0,
    finding: ({ count, n }) =>
      `${countText(count(TRAITS.plainHttp), n)} ${verb(count(TRAITS.plainHttp).held, "sends", "send")} to a remote host over plain HTTP.`,
    positioning:
      "Use TLS for every connection, and reject plain HTTP endpoints in settings.",
  },
  {
    id: "hardened-desktop",
    kind: "inversion",
    title: "Hardened desktop app",
    rows: [TRAITS.electron, TRAITS.weakWindow],
    applies: ({ count }) => count(TRAITS.weakWindow).held > 0,
    finding: ({ count }) =>
      `${capital(share(count(TRAITS.weakWindow).held, count(TRAITS.electron).held, "is an Electron app", "are Electron apps"))} ${verb(count(TRAITS.weakWindow).held, "turns", "turn")} off a window safeguard.`,
    positioning:
      "Keep every Electron safeguard on: renderer sandbox, context isolation and no Node.js in pages, with a narrow preload bridge.",
  },
  {
    id: "own-scripts",
    kind: "inversion",
    title: "Only your own scripts",
    rows: [TRAITS.foreignScript],
    applies: ({ count }) => count(TRAITS.foreignScript).held > 0,
    finding: ({ count, n }) =>
      `${countText(count(TRAITS.foreignScript), n)} ${verb(count(TRAITS.foreignScript).held, "loads", "load")} scripts from other hosts.`,
    positioning:
      "Serve every script from your own origin, so no CDN or vendor can change the code your users run.",
  },
  {
    id: "offline",
    kind: "white space",
    title: "Works offline",
    rows: [TRAITS.pages, TRAITS.offline],
    applies: ({ count }) =>
      count(TRAITS.pages).held >= 2 && count(TRAITS.offline).held === 0,
    finding: ({ count }) =>
      `None of the ${products(count(TRAITS.pages).held)} with web pages registers a service worker.`,
    positioning:
      "Work offline: a service worker that keeps the app usable without a connection.",
  },
  {
    id: "interactive",
    kind: "white space",
    title: "Interactive sessions",
    rows: [TRAITS.process, TRAITS.terminal],
    applies: ({ count }) =>
      count(TRAITS.process).held >= 2 && count(TRAITS.terminal).held === 0,
    finding: ({ count }) =>
      `None of the ${products(count(TRAITS.process).held)} that start processes runs interactive terminal sessions.`,
    positioning:
      "Offer interactive sessions in a pseudo-terminal for programs that prompt, such as ssh, database shells and installers.",
  },
];

/**
 * The openings a map's rows suggest for the `n` products its counts cover:
 * `[{ id, kind, title, finding, positioning, rows, basis }]`.
 */
export const openings = (rows, n) => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const context = {
    n,
    row: (definition) => byId.get(definition.id) ?? null,
    count: (definition) => byId.get(definition.id)?.counts ?? EMPTY,
  };
  if (n === 0) return [];
  return CATALOG.filter((entry) => entry.applies(context)).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    finding: entry.finding(context),
    positioning: entry.positioning,
    rows: entry.rows.map((definition) => definition.id),
    basis: "Landscape's correlation of the map's counts",
  }));
};
