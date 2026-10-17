// Runs the public CLI on small releases each test writes, for network and AI
// rules that depend on REA's real facts: where a moved key was before, what
// REA examined of the old release, which timers belong to a request, and
// how file names read. Prompt changes are in cli-prompts.test.mjs.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const compare = (
  before,
  after,
  { pkg = { type: "module" }, args = [] } = {},
) => {
  const result = run(
    written.write("1.0.0", before, pkg),
    written.write("1.1.0", after, pkg),
    ...args,
  );
  written.keep(result.out);
  return result;
};

const claims = (finding) => finding.evidence.map((item) => item.claim);

const manifest = (version) =>
  JSON.stringify({
    product: "Chat",
    version,
    components: [
      { name: "web", path: "web" },
      { name: "api", path: "api" },
    ],
  });

const KEY = "sk-proj-DEMO-not-a-real-key-000000000000000000";
const PAGE =
  '<!doctype html><title>Chat</title><script type="module" src="./app.js"></script>\n';
const CONFIG = `export const OPENAI_API_KEY = "${KEY}";\n`;
const CALL =
  'import { OPENAI_API_KEY } from "./config.js";\nexport const ask = (q) => fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: q });\n';

describe("compare: a key that moved into browser code", { skip }, () => {
  const browserSide = {
    "release-watch.json": manifest("1.1.0"),
    "web/index.html": PAGE,
    "web/app.js":
      'import { ask } from "./llm.js";\ndocument.querySelector("#go").onclick = () => ask("hi");\n',
    "web/config.js": CONFIG,
    "web/llm.js": CALL,
    "api/package.json": '{"name":"api","type":"module","main":"src/server.js"}',
    "api/src/server.js":
      'import http from "node:http";\nhttp.createServer((req, res) => res.end("ok")).listen(8080);\n',
  };

  it("grades a key moved from server code into browser code critical", () => {
    const { result, report, outputs } = compare(
      {
        "release-watch.json": manifest("1.0.0"),
        "web/index.html": PAGE,
        "web/app.js":
          'document.querySelector("#go").onclick = () => fetch("/api/ask", { method: "POST" });\n',
        "api/package.json":
          '{"name":"api","type":"module","main":"src/server.js"}',
        "api/src/server.js":
          'import http from "node:http";\nimport { ask } from "./llm.js";\nhttp.createServer(async (req, res) => res.end(await (await ask(req.url)).text())).listen(8080);\n',
        "api/src/config.js": CONFIG,
        "api/src/llm.js": CALL,
      },
      browserSide,
    );
    assert.equal(result.status, 2, result.stderr);
    const finding = report.findings.find((item) => item.rule === "RW-A02");
    assert.deepEqual(
      [finding.severity, finding.component, finding.title],
      ["critical", "web", "OpenAI API key now in browser code: config.js"],
    );
    assert.ok(
      claims(finding).some((claim) =>
        /takes src\/config\.js in v1\.0\.0 as server code: src\/server\.js imports node:http/.test(
          claim,
        ),
      ),
      JSON.stringify(claims(finding)),
    );
    assert.ok(outputs.every((text) => !text.includes(KEY)));
  });

  it("keeps a key moved from code a page may load at high", () => {
    // The old key sat in a script of the web component that no page loads
    // by a script tag: a dedicated worker or a script loaded at runtime.
    const { result, report } = compare(
      {
        "release-watch.json": manifest("1.0.0"),
        "web/index.html": PAGE,
        "web/app.js":
          'const worker = new Worker("./worker.js");\ndocument.querySelector("#go").onclick = () => worker.postMessage("hi");\n',
        "web/worker.js": `${CONFIG}self.onmessage = (event) => fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: \`Bearer \${OPENAI_API_KEY}\` }, body: event.data });\n`,
        "api/package.json":
          '{"name":"api","type":"module","main":"src/server.js"}',
        "api/src/server.js":
          'import http from "node:http";\nhttp.createServer((req, res) => res.end("ok")).listen(8080);\n',
      },
      browserSide,
    );
    assert.equal(result.status, 2, result.stderr);
    const finding = report.findings.find((item) => item.rule === "RW-A02");
    assert.deepEqual(
      [finding.severity, finding.title],
      ["high", "OpenAI API key now in browser code: config.js"],
    );
    assert.ok(
      finding.unknowns.some((text) =>
        /may also have been in the browser/.test(text),
      ),
    );
  });
});

describe(
  "compare: timers around a new destination's requests",
  { skip },
  () => {
    it("cites only the timers REA's facts tie to the request, as Release Watch's correlation, capped", () => {
      const ui =
        'export const toast = (text) => { const el = document.createElement("p"); el.textContent = text; setTimeout(() => el.remove(), 3000); };\nexport const blink = (el) => setInterval(() => el.classList.toggle("on"), 500);\n';
      const retries = Array.from(
        { length: 5 },
        (_, n) =>
          `  setTimeout(() => fetch(ENDPOINT, { method: "POST" }), ${n + 1}000);\n`,
      ).join("");
      const beacon = `const ENDPOINT = "https://ingest.tracker.example.net/v1/e";\nfunction send() {\n  return fetch(ENDPOINT, { method: "POST", body: JSON.stringify({ at: Date.now() }) });\n}\nexport function start() {\n  send();\n  setInterval(send, 3600000);\n}\nexport const retry = () => {\n${retries}};\n${ui}`;
      const { result, report } = compare(
        { "src/ui.js": ui, "src/index.js": 'export * from "./ui.js";\n' },
        {
          "src/ui.js": ui,
          "src/beacon.js": beacon,
          "src/index.js":
            'export * from "./ui.js";\nexport { start, retry } from "./beacon.js";\n',
        },
        { pkg: { type: "module", main: "src/index.js" } },
      );
      assert.equal(result.status, 2, result.stderr);
      const finding = report.findings.find(
        (item) =>
          item.rule === "RW-N01" && /tracker\.example\.net/.test(item.title),
      );
      const timers = finding.evidence.filter((item) =>
        /setTimeout|setInterval|timers/.test(item.claim),
      );
      assert.deepEqual(
        timers.map((item) => [item.basis, item.location?.line ?? null]),
        [
          ["heuristic", 7],
          ["heuristic", 10],
          ["heuristic", 11],
          ["heuristic", null],
        ],
      );
      assert.match(
        timers[0].claim,
        /^src\/beacon\.js schedules send, a function around the request, with setInterval\(\)/,
      );
      assert.match(
        timers[1].claim,
        /sends the request from inside a setTimeout\(\) call/,
      );
      assert.match(timers[3].claim, /^3 more timers Release Watch relates/);
    });
  },
);

describe("compare: content-hashed bundle names", { skip }, () => {
  it("names the file in titles, claims, locations and coverage alike", () => {
    const tasks = Array.from(
      { length: 40 },
      (_, n) =>
        `export function task${n}(a, b) { const c = a + b * ${n}; tasks.push({ c, n: ${n} }); return c > ${n} ? a : b; }\n`,
    ).join("");
    const { result, report, outputs } = compare(
      {
        "dist/index.js":
          'export { run } from "./config-manager-D8IneV9B.js";\n',
        "dist/config-manager-D8IneV9B.js":
          'import { spawnSync } from "node:child_process";\nexport const run = (p) => spawnSync("make", ["check"], { cwd: p });\n',
      },
      {
        "dist/index.js":
          'export { run, agent } from "./config-manager-DsRE1v6M.js";\nexport { tasks } from "./task-manager-JLDji0yR.js";\n',
        "dist/config-manager-DsRE1v6M.js":
          'import { spawn, spawnSync } from "node:child_process";\nexport const run = (p) => spawnSync("make", ["check"], { cwd: p });\nexport const agent = (p, prompt) => spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], { cwd: p });\n',
        // Large enough to reach the per-file node ceiling below.
        "dist/task-manager-JLDji0yR.js": `export const tasks = [];\n${tasks}`,
      },
      {
        pkg: { type: "module", main: "dist/index.js" },
        args: ["--max-semantic-nodes-per-file", "100"],
      },
    );
    assert.equal(result.status, 2, result.stderr);
    const spawned = "dist/config-manager-DsRE1v6M.js";
    const spawn = report.findings.find((item) => item.rule === "RW-P01");
    assert.equal(spawn.title, `New process execution: spawn() in ${spawned}`);
    assert.ok(
      spawn.evidence.some((item) => item.location?.file === spawned),
      JSON.stringify(spawn.evidence),
    );
    const ceiling = "dist/task-manager-JLDji0yR.js";
    const coverage = report.findings.find((item) => item.rule === "RW-C01");
    assert.ok(coverage.summary.includes(ceiling), coverage.summary);
    assert.ok(
      report.components[0].coverage.right.gaps.some((gap) =>
        gap.includes(ceiling),
      ),
    );
    for (const text of outputs) assert.doesNotMatch(text, /dist\/‹/);
  });
});

describe(
  "compare: request sites REA did not fully examine before",
  { skip },
  () => {
    const filler = (count, prefix = "f") =>
      Array.from(
        { length: count },
        (_, n) =>
          `export function ${prefix}${n}(a, b) { const c = a + b * ${n}; return c > ${n} ? [a, c] : { b, c }; }\n`,
      ).join("");
    const sync =
      'export const sync = (url, body) => fetch(url, { method: "POST", body });\n';
    const requests = (report) =>
      report.findings.filter((finding) => finding.rule === "RW-N02");

    it("says sites in an old module at the per-file ceiling were not observed, not new", () => {
      const { result, report } = compare(
        { "dist/index.js": `${filler(40)}${sync}` },
        {
          "dist/index.js": `${filler(2)}${sync}export const ping = (url) => fetch(url, { method: "HEAD" });\n`,
        },
        {
          pkg: { type: "module", main: "dist/index.js" },
          args: ["--max-semantic-nodes-per-file", "150"],
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const [finding] = requests(report);
      assert.deepEqual(
        [finding.severity, finding.title],
        [
          "medium",
          "Request with an unresolved destination not observed in v1.0.0: dist/index.js",
        ],
      );
      assert.match(
        finding.summary,
        /\(0 observed → 2 in this module\), but REA examined dist\/index\.js of v1\.0\.0 only in part \(it reached the per-file node ceiling\), so Release Watch cannot tell whether any is new\.$/,
      );
      // The limit the old file reached, as limits.mjs words a re-run: the
      // per-file option given here keeps its value at any depth.
      assert.match(
        finding.recommendation,
        /^Re-run with higher --max-semantic-nodes-per-file than this run's 150 so the old code is examined,/,
      );
    });

    it("names the old files REA gave no facts and its global limit", () => {
      const page = (chunk) =>
        `<!doctype html><title>w</title><script type="module" src="./assets/${chunk}"></script>\n`;
      const parts = (count) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, n) => [
            `assets/part${n}.js`,
            filler(6, `p${n}_`),
          ]),
        );
      // The entry chunk is renamed and REA reaches its global node limit on
      // the old release before it.
      const { result, report } = compare(
        {
          "index.html": page("zq81mfka.js"),
          ...parts(12),
          "assets/zq81mfka.js": sync,
        },
        {
          "index.html": page("ab3kd9xw.js"),
          ...parts(2),
          "assets/ab3kd9xw.js": sync,
        },
        { args: ["--max-semantic-nodes", "300"] },
      );
      assert.equal(result.status, 0, result.stderr);
      const [finding] = requests(report);
      assert.match(
        finding.title,
        /^Request with an unresolved destination not observed in v1\.0\.0: assets\/ab3kd9xw\.js$/,
      );
      assert.match(
        finding.summary,
        /REA gave assets\/zq81mfka\.js of v1\.0\.0 no semantic facts/,
      );
      // The old release's files elsewhere and its global limit are one
      // sentence on every finding about the new release.
      const elsewhere = finding.unknowns.filter((text) =>
        text.endsWith("so what is reported here may have been there before."),
      );
      assert.equal(elsewhere.length, 1, JSON.stringify(finding.unknowns));
      assert.match(
        elsewhere[0],
        /^REA gave no semantic facts to \d+ other files of v1\.0\.0 \(assets\/part\d+\.js, assets\/part\d+\.js and \d+ more\) and reached its global node limit there, so/,
      );
    });
  },
);
