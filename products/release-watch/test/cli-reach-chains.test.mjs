// Runs the public CLI on small releases each test writes, for a value that
// reads its own property writes back. Each such read adds members to the
// chain reach follows the value through, so the chains, and the places
// reach visits, grew without end; Release Watch cuts a chain at MAX_PATH
// members and reports what lies past the cut as a guess.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_PATH } from "../src/rules/reach-resolve.mjs";
import {
  claims,
  finding,
  GIT,
  graded,
  MCP,
  SDK,
  server,
  writtenCompare,
} from "./cli-reach-run.mjs";
import { skip } from "./cli-run.mjs";

const compare = writtenCompare();

// task-master-ai's config loader in miniature: each model's settings are
// copied from another's, so a read of `config.models.main` leads back to
// `config.models` with a longer chain every time.
const CONFIG = `import { runGit } from "./git.js";
const n = { models: { main: { provider: "a" }, research: { provider: "b" }, fallback: { provider: "c" } }, gc: () => runGit(["gc"]) };
export function load(file) {
  let l = { ...n };
  l.models.main = { ...l.models.research };
  l.models.research = { ...l.models.fallback };
  l.models.fallback = { ...l.models.main };
  l.models.main.provider = l.models.fallback.provider;
  l.models.research.provider = l.models.main.provider;
  return l;
}
export const config = load("x");
`;

const ECHO =
  'server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));\n';
const PROVIDER =
  'server.registerTool("provider", {}, async () => ({ content: [], out: config.models.main.provider.models.fallback.provider }));\n';
// A value nested deeper than MAX_PATH members, and a read of its function.
const MEMBERS = "abcdefghij".split("");
const CHAIN = `ops.${MEMBERS.join(".")}.`;
const nested = (...tools) =>
  `${SDK}import { runGit } from "./git.js";\nconst ops = ${MEMBERS.map((member) => `{ ${member}: `).join("")}{ gc: () => runGit(["gc"]) }${" }".repeat(MEMBERS.length)};\n${server("1")}${tools.join("")}export default server;\n`;
const index = (...tools) =>
  `${SDK}import { config } from "./config.js";\n${server("1")}${tools.join("")}export default server;\n`;

describe(
  "compare: a value that reads its own property writes",
  { skip },
  () => {
    it("cuts the member chain and reports what lies past it as a guess", () => {
      const result = compare(
        {
          "src/index.js": index(ECHO),
          "src/config.js": CONFIG,
          "src/git.js": GIT,
        },
        {
          "src/index.js": index(ECHO, PROVIDER),
          "src/config.js": CONFIG,
          "src/git.js": GIT,
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      assert.deepEqual(graded(result), [["RW-M01", "critical"]]);
      const found = finding(result, "RW-M01");
      // Each path to the site follows a guess, a cut chain among them.
      assert.match(found.title, /^MCP tool may start processes/);
    });

    it("words a chain longer than the cut as a guess", () => {
      const deep = `${CHAIN.slice(0, -1)}.gc()`;
      const result = compare(
        { "src/index.js": nested(ECHO), "src/git.js": GIT },
        {
          "src/index.js": nested(
            ECHO,
            `server.registerTool("gc", {}, async () => ({ content: [], out: ${deep} }));\n`,
          ),
          "src/git.js": GIT,
        },
        MCP,
      );
      assert.equal(result.result.status, 2, result.result.stderr);
      const found = finding(result, "RW-M01");
      assert.match(found.title, /^MCP tool may start processes/);
      assert.match(
        claims(found),
        new RegExp(
          `a chain of more than ${MAX_PATH} members, which Release Watch cut there`,
        ),
      );
      assert.ok(
        found.unknowns.some((unknown) =>
          unknown.includes(
            `the member chain Release Watch followed grew past ${MAX_PATH} members`,
          ),
        ),
        JSON.stringify(found.unknowns),
      );
    });
  },
);
