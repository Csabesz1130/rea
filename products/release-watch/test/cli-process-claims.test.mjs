// Runs the public CLI on small releases each test writes, for what RW-P01
// claims about a process site the new release does not show where it was
// (still shipped, or in a file REA examined only in part) and about the
// commands of a changed site: named as their source lines show them, and
// hedged only where REA did not resolve a command on either side.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const compare = (before, after, ...args) => {
  const result = run(
    written.write("1.0.0", before),
    written.write("1.1.0", after),
    ...args,
  );
  written.keep(result.out);
  return result;
};

const findingsOf = (report, rule) =>
  report.findings.filter((finding) => finding.rule === rule);

// An old site, a new module with the same call that sorts before it, and a
// new module that uses up REA's global node limit before REA reaches the
// old one: only the new call is in the new release's facts.
const UNINSTALL =
  'const { exec } = require("child_process");\nexports.version = (done) => exec("npm --version", done);\n';
const DIAGNOSTICS =
  'const { exec } = require("child_process");\nexports.report = (done) => exec("npm --version", done);\n';
const FILLER = Array.from(
  { length: 200 },
  (_, index) =>
    `exports.f${index} = (a, b) => { const x = a + b * ${index}; return [x, a, b].map((v) => v + ${index}); };`,
).join("\n");
const LIMIT = ["--max-semantic-nodes", "400"];

// Asserts REA left uninstall.js unexamined, so the case means what it says.
const assertUnreached = (report) =>
  assert.ok(
    findingsOf(report, "RW-C01").some((finding) =>
      finding.evidence.some((item) =>
        /no semantic facts after REA's global node limit: .*uninstall\.js/.test(
          item.claim,
        ),
      ),
    ),
    JSON.stringify(report.findings),
  );

describe("compare: process sites the new facts lack", { skip }, () => {
  it("does not take a site in a file still shipped unchanged as moved", () => {
    const { result, report } = compare(
      { "uninstall.js": UNINSTALL },
      {
        "uninstall.js": UNINSTALL,
        "diagnostics.js": DIAGNOSTICS,
        "helpers.js": FILLER,
      },
      ...LIMIT,
    );
    assert.equal(result.status, 2, result.stderr);
    assertUnreached(report);
    const [exec] = findingsOf(report, "RW-P01");
    assert.equal(exec.severity, "high", JSON.stringify(exec));
    assert.equal(exec.title, "New process execution: exec() in diagnostics.js");
    assert.ok(
      !JSON.stringify(report).includes("no longer has it"),
      JSON.stringify(exec),
    );
  });

  it("says a site in a changed file REA did not examine may be the same call", () => {
    const { result, report } = compare(
      { "uninstall.js": UNINSTALL },
      {
        "uninstall.js": `${UNINSTALL}exports.legacy = true;\n`,
        "diagnostics.js": DIAGNOSTICS,
        "helpers.js": FILLER,
      },
      ...LIMIT,
    );
    assert.equal(result.status, 2, result.stderr);
    assertUnreached(report);
    const [exec] = findingsOf(report, "RW-P01");
    assert.equal(exec.severity, "high", JSON.stringify(exec));
    assert.ok(
      exec.unknowns.includes(
        "v1.0.0 ran exec() with the same command in uninstall.js, which REA could not fully examine in v1.1.0; this may be the same call, moved.",
      ),
      JSON.stringify(exec.unknowns),
    );
  });
});

describe("compare: request sites the new facts lack", { skip }, () => {
  it("says a request in a changed file REA did not examine may be the same request", () => {
    const send =
      'exports.send = (u, b) => fetch(u, { method: "POST", body: b });\n';
    const { result, report } = compare(
      { "uninstall.js": send },
      {
        "uninstall.js": `${send}exports.legacy = true;\n`,
        "diagnostics.js":
          'exports.post = (u, b) => fetch(u, { method: "POST", body: b });\n',
        "helpers.js": FILLER,
      },
      ...LIMIT,
    );
    assert.equal(result.status, 2, result.stderr);
    assertUnreached(report);
    const [request] = findingsOf(report, "RW-N02");
    assert.equal(request?.severity, "medium", JSON.stringify(report.findings));
    assert.ok(
      request.unknowns.includes(
        "v1.0.0 had a fetch() request without a known destination in uninstall.js, which REA could not fully examine in v1.1.0; this may be the same request, moved.",
      ),
      JSON.stringify(request.unknowns),
    );
  });
});

describe("compare: a command REA resolved on one side only", { skip }, () => {
  it("claims a new command only when REA resolved every old one", () => {
    const run = (shell) =>
      `const { spawn } = require("child_process");\nexports.run = (command${shell === "shell" ? ', shell = "/bin/bash"' : ""}) => spawn(${shell}, ["-c", command], { stdio: "pipe" });\n`;
    const { result, report } = compare(
      {
        "run.js": run('"/bin/bash"'),
        "fixed.js": run('"/bin/bash"'),
      },
      { "run.js": run("shell"), "fixed.js": run('"/bin/zsh"') },
    );
    assert.equal(result.status, 2, result.stderr);
    const [fixed, dynamic] = ["fixed.js", "run.js"].map((file) =>
      findingsOf(report, "RW-P01").find(
        (finding) =>
          finding.title === `Process execution changed: spawn() in ${file}`,
      ),
    );
    assert.equal(
      fixed.summary,
      'v1.1.0 runs "/bin/zsh" from fixed.js, which v1.0.0 did not run there.',
    );
    assert.deepEqual(
      fixed.evidence.map((item) => item.claim),
      [
        'spawn() child-process creation running "/bin/zsh"',
        'v1.0.0: spawn() ran "/bin/bash"',
      ],
    );
    assert.equal(
      dynamic.summary,
      "REA did not resolve the command v1.1.0 runs from run.js, so it may be the command v1.0.0 ran there.",
    );
    assert.ok(
      dynamic.unknowns.includes(
        "REA did not resolve the command v1.1.0 runs at one site here, so that site may be the same call with the same command as before.",
      ),
      JSON.stringify(dynamic.unknowns),
    );
    assert.deepEqual(
      dynamic.evidence.map((item) => item.claim),
      [
        "spawn() child-process creation with a command REA did not resolve",
        'v1.0.0: spawn() ran "/bin/bash"',
      ],
    );
  });

  it("hedges only the sites REA did not resolve on either side", () => {
    const head = 'const { spawn } = require("child_process");\n';
    const { result, report } = compare(
      {
        "mixed.js": `${head}exports.a = (c) => spawn("ls", [c]);\nexports.b = (c) => spawn("ls", ["-l", c]);\n`,
        "late.js": `${head}exports.a = (c, sh = process.env.SHELL) => spawn(sh, ["-c", c]);\n`,
      },
      {
        "mixed.js": `${head}exports.a = (c) => spawn("curl", [c]);\nexports.b = (c, sh = process.env.SH) => spawn(sh, ["-l", c]);\n`,
        "late.js": `${head}exports.a = (c) => spawn("/bin/bash", ["-c", c]);\n`,
      },
    );
    assert.equal(result.status, 2, result.stderr);
    const [mixed, late] = ["mixed.js", "late.js"].map((file) =>
      findingsOf(report, "RW-P01").find(
        (finding) =>
          finding.title === `Process execution changed: spawn() in ${file}`,
      ),
    );
    assert.equal(
      mixed.summary,
      'v1.1.0 runs "curl" from mixed.js, which v1.0.0 did not run there. REA did not resolve the command v1.1.0 runs from mixed.js at one other site, so it may be a command v1.0.0 ran there.',
    );
    assert.ok(
      mixed.unknowns.includes(
        "REA did not resolve the command v1.1.0 runs at one site here, so that site may be the same call with the same command as before.",
      ),
      JSON.stringify(mixed.unknowns),
    );
    // REA resolved no command of v1.0.0 there, so none is called resolved.
    assert.equal(
      late.summary,
      'REA did not resolve the command v1.0.0 ran from late.js, so "/bin/bash" may be the same command.',
    );
    assert.ok(!JSON.stringify(late).includes("resolved commands"));
  });
});

describe(
  "compare: old sites REA did not resolve beside ones it did",
  { skip },
  () => {
    it("counts them as sites, and hedges a new command by them", () => {
      const head = 'const { spawn } = require("child_process");\n';
      const env = (name) =>
        `exports.${name} = (c, s = process.env.${name.toUpperCase()}) => spawn(s, [c]);\n`;
      const { result, report } = compare(
        {
          "pair.js": `${head}exports.a = (c) => spawn("ls", [c]);\nexports.b = (c) => spawn("cat", [c]);\n${env("d")}`,
          "split.js": `${head}exports.a = (c) => spawn("ls", [c]);\n${env("b")}${env("d")}`,
        },
        {
          "pair.js": `${head}exports.a = (c) => spawn("curl", [c]);\nexports.b = (c) => spawn("wget", [c]);\n${env("d")}`,
          "split.js": `${head}exports.a = (c) => spawn("curl", [c]);\n${env("b")}${env("d")}`,
        },
      );
      assert.equal(result.status, 2, result.stderr);
      const [pair, split] = ["pair.js", "split.js"].map((file) =>
        findingsOf(report, "RW-P01").find(
          (finding) =>
            finding.title === `Process execution changed: spawn() in ${file}`,
        ),
      );
      // Two new commands and one old site REA did not resolve: at most one
      // of them can be the command it ran.
      assert.equal(
        pair.summary,
        "v1.1.0 runs 2 commands from pair.js that no command REA resolved for v1.0.0 there matches; REA did not resolve the command v1.0.0 ran there at one other site, so one of them may be that one.",
      );
      assert.ok(
        pair.unknowns.includes(
          "One of the 2 commands may be a command v1.0.0 ran here: REA did not resolve the command it ran at one other site here.",
        ),
        JSON.stringify(pair.unknowns),
      );
      // Sites, not commands, are counted: two old sites may run one command.
      assert.equal(
        split.summary,
        'v1.1.0 runs "curl" from split.js, which no command REA resolved for v1.0.0 there matches; REA did not resolve the commands v1.0.0 ran there at 2 other sites, so it may be one of those.',
      );
    });
  },
);

describe("compare: the commands a changed site names", { skip }, () => {
  it("names a changed command with its credentials masked, as its source line is", () => {
    const head = 'const { exec } = require("child_process");\n';
    const { result, report, outputs } = compare(
      {
        "run.js": `${head}exports.a = (d) => exec("curl https://api.example.com/v1/ping", d);\nexports.b = (d) => exec("curl https://api.example.com", d);\nexports.c = (d) => exec("node job.js", d);\n`,
      },
      {
        "run.js": `${head}exports.a = (d) => exec("curl -H \\"Authorization: Bearer sk-live-abcdef1234567890\\" https://user:hunter2@api.example.com/v1/ping", d);\nexports.b = (d) => exec("curl -u admin:S3cretPassw0rd https://api.example.com", d);\nexports.c = (d) => exec("API_KEY=Zq81mXk2Lp0Rt7Vw node job.js", d);\n`,
      },
    );
    assert.equal(result.status, 2, result.stderr);
    for (const secret of [
      "sk-live-abcdef1234567890",
      "hunter2",
      "S3cretPassw0rd",
      "Zq81mXk2Lp0Rt7Vw",
    ])
      for (const output of outputs) assert.ok(!output.includes(secret), secret);
    const [exec] = findingsOf(report, "RW-P01");
    const claims = exec.evidence.map((item) => item.claim);
    for (const pattern of [
      /^exec\(\) child-process creation running "curl -H \\"Authorization: ‹[0-9a-f]{6,}›\\" https:\/\/api\.example\.com\/v1\/ping"$/,
      /^exec\(\) child-process creation running "curl -u ‹[0-9a-f]{6,}› https:\/\/api\.example\.com"$/,
      /^exec\(\) child-process creation running "API_KEY=‹[0-9a-f]{6,}› node job\.js"$/,
    ])
      assert.ok(
        claims.some((claim) => pattern.test(claim)),
        `${pattern}: ${JSON.stringify(claims)}`,
      );
    assert.ok(claims.includes('v1.0.0: exec() ran "node job.js"'));
  });
});
