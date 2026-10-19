// Runs the public CLI on small releases each test writes, for RW-A04 on
// REA's real facts: which strings of AI code changed, which of them are
// prompts rather than messages or package metadata, and which old text a
// finding quotes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { writtenCompare } from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const written = writtenCompare();
const compare = (before, after) => written(before, after, { type: "module" });
const claims = (finding) => finding.evidence.map((item) => item.claim);
const quotes = (finding) =>
  finding.evidence
    .filter((item) => item.side === "left")
    .map((item) => item.claim);

const AI = 'import OpenAI from "openai";\n';
const ask =
  'export const ask = (q, system) => new OpenAI().chat.completions.create({ messages: [{ role: "system", content: system }, { role: "user", content: q }] });\n';
const prompts = (report) =>
  report.findings
    .filter((finding) => finding.rule === "RW-A04")
    .map((finding) => finding.title);
const PLEASE =
  "Please define a function handler property inside the service config.";
const SURE =
  "Make sure the events are using the text or html format for every message.";
const SYSTEM =
  "You summarize a user's note in two sentences and never include names.";
const NEW_SYSTEM = SYSTEM.replace(
  "never include names",
  "always start with the author's name",
);

describe("compare: prompt text in AI code", { skip }, () => {
  it("does not report text a minified module held before under another name", () => {
    const { result, report } = compare(
      {
        "dist/bundle.js": `${AI}const G = "${PLEASE}", V = "${SURE}";\n${ask}export const a = () => ask(G, V);\n`,
      },
      {
        "dist/bundle.js": `${AI}const K = "${PLEASE}", G = "${SURE}";\n${ask}export const a = () => ask(K, G);\n`,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(prompts(report), []);
  });

  it("reports a minified variable whose text is new to its module", () => {
    const { result, report } = compare(
      {
        "dist/bundle.js": `${AI}const G = "${SYSTEM}";\n${ask}export const a = (q) => ask(q, G);\n`,
      },
      {
        "dist/bundle.js": `${AI}const G = "${SYSTEM.replace("never include names", "start with the author's name")}";\n${ask}export const a = (q) => ask(q, G);\n`,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(prompts(report), [
      "Prompt text changed: G in dist/bundle.js",
    ]);
  });

  it("reports a prompt held by an object property whose text changed", () => {
    const config = (text) =>
      `${AI}const settings = { system: "${text}" };\n${ask}export const a = (q) => ask(q, settings.system);\n`;
    const { result, report } = compare(
      { "src/chat.js": config(SYSTEM) },
      {
        "src/chat.js": config(
          SYSTEM.replace("never include names", "start with the author's name"),
        ),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(prompts(report), [
      "Prompt text changed: settings.system in src/chat.js",
    ]);
  });

  it("does not take a bundled package.json value or an error message for a prompt", () => {
    const test =
      "vitest run --root ../.. packages/protocol/tests packages/protocol/json-rpc/tests";
    // test:unit takes test's text (stagehand 4.1.0); lint and the error
    // message get text no old string had.
    const bundle = ({ unit, lint, message }) =>
      `${AI}var package_default = { name: "@acme/agent", version: "1.0.0", scripts: { test: "${test}", "test:unit": "${unit}", lint: "${lint}" } };\nconst MSG = "${message}";\n${ask}export const version = package_default.version;\nexport const a = (q, fn) => { if (!fn) { console.error(MSG); throw new TypeError(MSG); } return ask(q, "${SYSTEM}"); };\n`;
    const { result, report } = compare(
      {
        "dist/agent.js": bundle({
          unit: `${test} --exclude=packages/protocol/tests/browser-runtime/**`,
          lint: "oxlint --deny-warnings packages/protocol packages/agent and the scripts",
          message: PLEASE,
        }),
      },
      {
        "dist/agent.js": bundle({
          unit: test,
          lint: "eslint --max-warnings 0 packages/protocol packages/agent and the scripts",
          message:
            "Please define a function handler property inside the connect config.",
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(prompts(report), []);
  });
});

describe("compare: which value a prompt finding takes", { skip }, () => {
  it("takes each value of a minified name for a prompt or a message on its own", () => {
    const create = (system) =>
      `new O().chat.completions.create({ messages: [{ role: "system", content: ${system} }, { role: "user", content: q }] })`;
    // dist/b.js swaps a prompt and a thrown message between two names; in
    // dist/c.js one name holds a prompt in one function and a thrown
    // message in another.
    const swapped = (first, second, thrown, system) =>
      `import O from "openai";\nvar a = "${first}", b = "${second}";\nexport const r = (q, f) => { if (!f) throw Error(${thrown}); return ${create(system)}; };\n`;
    const scoped = (text) =>
      `import O from "openai";\nfunction p(q) { const e = "${text}"; return ${create("e")}; }\nfunction v(f) { const e = "${PLEASE}"; if (!f) throw Error(e); return f; }\nexport { p, v };\n`;
    const { result, report } = compare(
      {
        "dist/b.js": swapped(SYSTEM, PLEASE, "b", "a"),
        "dist/c.js": scoped(SYSTEM),
      },
      {
        "dist/b.js": swapped(PLEASE, NEW_SYSTEM, "a", "b"),
        "dist/c.js": scoped(NEW_SYSTEM),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const found = report.findings.filter((item) => item.rule === "RW-A04");
    assert.deepEqual(found.map((item) => item.title).sort(), [
      "Prompt text changed: b in dist/b.js",
      "Prompt text changed: e in dist/c.js",
    ]);
    // b held the message before, which the new module still holds as a:
    // the old text quoted is the prompt the new module no longer holds.
    const swap = found.find((item) => item.title.endsWith("dist/b.js"));
    assert.equal(quotes(swap).length, 1);
    assert.match(
      quotes(swap)[0],
      /^v1\.0\.0 a: "You summarize .* never include names\."/,
    );
    assert.ok(
      claims(swap).some((claim) =>
        claim.startsWith(
          "b's v1.0.0 text is still in v1.1.0 under another name; Release Watch quotes the one prompt text dist/b.js held in v1.0.0",
        ),
      ),
      JSON.stringify(claims(swap)),
    );
  });

  it("does not take a message printed through a computed console method or markup for a prompt", () => {
    const docs = (pages) =>
      `${AI}const C = "warn", T = "https://deepchat.dev/docs/", icon = "${pages.icon}";\n${pages.list
        .map(
          (page, n) =>
            `export function f${n}(t) { const i = \`Please see the official documentation: \${T}directConnection/${page}\`; if (t.chat) { console[C](i); delete t.chat; } return new OpenAI(); }\n`,
        )
        .join("")}export const draw = () => icon;\n`;
    const svg = (path) =>
      `<?xml version='1.0' encoding='UTF-8'?> <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${path}'/></svg>`;
    const { result, report } = compare(
      {
        "dist/deepChat.js": docs({
          icon: svg("M0 0h24v24H0z"),
          list: ["OpenAI"],
        }),
      },
      {
        "dist/deepChat.js": docs({
          icon: svg("M1 1h22v22H1z"),
          list: ["OpenAI", "Cohere"],
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(prompts(report), []);
  });

  it("reports an agent card's description REA shows read, though the card has a version", () => {
    const card = (text) =>
      `${AI}const agentCard = { name: "planner", version: "1.0.0", url: "https://agents.example.com/planner", description: "${text}" };\n${ask}export const a = (q) => ask(q, agentCard.description);\nexport const v = agentCard.version;\n`;
    // Bundled package.json objects: one with no package-only field whose
    // description nothing reads, and one with scripts whose description
    // a CLI reads.
    const pkg = (text) =>
      `${AI}var package_default = { name: "@acme/agent", version: "1.0.0", description: "${text}" };\n${ask}export const version = package_default.version;\n`;
    const cli = (text) =>
      `${AI}var pkg = { name: "@acme/cli", version: "1.0.0", description: "${text}", scripts: { build: "tsc" } };\n${ask}export const help = (program) => program.description(pkg.description);\n`;
    const FRAMEWORK =
      "An AI web browsing framework focused on simplicity and extensibility.";
    const faster = FRAMEWORK.replace("simplicity", "simplicity, speed");
    const { result, report } = compare(
      {
        "src/agent.js": card(SYSTEM),
        "dist/index.js": pkg(FRAMEWORK),
        "dist/cli.js": cli(FRAMEWORK),
      },
      {
        "src/agent.js": card(NEW_SYSTEM),
        "dist/index.js": pkg(faster),
        "dist/cli.js": cli(faster),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(prompts(report), [
      "Prompt text changed: agentCard.description in src/agent.js",
    ]);
  });
});

describe("compare: which old text a prompt finding quotes", { skip }, () => {
  it("says when a name's old text is still there and which old prompt text is gone, if one", () => {
    // In dist/bundle.js no old prompt text is gone; in dist/two.js two
    // are, so neither is quoted.
    const two = (texts) =>
      `${AI}const ${texts.map(([name, text]) => `${name} = "${text}"`).join(", ")};\n${ask}export const a = (q) => ask(q + ${texts[0][0]}, ${
        texts
          .slice(1)
          .map(([name]) => name)
          .join(" + ") || '""'
      });\n`;
    const { result, report } = compare(
      {
        "dist/bundle.js": two([["G", PLEASE]]),
        "dist/two.js": two([
          ["G", PLEASE],
          ["V", SYSTEM],
          ["W", SURE],
        ]),
      },
      {
        "dist/bundle.js": two([
          ["K", PLEASE],
          ["G", NEW_SYSTEM],
        ]),
        "dist/two.js": two([
          ["K", PLEASE],
          ["G", NEW_SYSTEM],
        ]),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const found = report.findings.filter((item) => item.rule === "RW-A04");
    assert.deepEqual(found.map((item) => item.title).sort(), [
      "Prompt text changed: G in dist/bundle.js",
      "Prompt text changed: G in dist/two.js",
    ]);
    for (const finding of found) {
      assert.match(
        quotes(finding)[0],
        /^v1\.0\.0: "Please define .*›\), which v1\.1\.0 still holds as K$/,
      );
      assert.equal(quotes(finding).length, 1);
    }
    const [none, both] = found.sort((a, b) => a.title.localeCompare(b.title));
    assert.match(
      none.summary,
      /its old text is still there under another name, and no prompt text of the old module is gone\.$/,
    );
    assert.match(
      both.summary,
      /and Release Watch cannot tell which of the 2 prompt texts the old module no longer holds it replaces\.$/,
    );
  });
});
