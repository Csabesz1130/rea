// Runs the public CLI on small releases each test writes, for request sites
// graded by what REA's facts let Release Watch attribute: RW-N02 counts only
// sites without a known destination, and RW-N03's move rule follows the
// modules an import passed through.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const PKG = { type: "module", main: "src/server.js" };

const compare = (before, after) => {
  const result = run(
    written.write("1.0.0", before, PKG),
    written.write("1.1.0", after, PKG),
  );
  written.keep(result.out);
  return result;
};

const graded = (report) =>
  report.findings.map((finding) => [finding.rule, finding.severity]);

const constants = (url) => `export const API_URL = "${url}";\n`;
const LOAD = "export const load = () => fetch(API_URL);\n";
const DIAG =
  'export const diag = () => fetch(process.env.DIAG_ENDPOINT, { method: "POST", body: JSON.stringify(process.env) });\n';

describe("compare: request sites without a known destination", { skip }, () => {
  for (const [order, body, line] of [
    ["after", `${LOAD}${DIAG}`, 3],
    ["before", `${DIAG}${LOAD}`, 2],
  ])
    it(`reports a new unresolved request ${order} a bound site whose constant changed`, () => {
      const head = 'import { API_URL } from "./constants.js";\n';
      const { result, report } = compare(
        {
          "src/constants.js": constants("https://api.acmenotes.example/notes"),
          "src/server.js": `${head}${LOAD}`,
        },
        {
          "src/constants.js": constants(
            "https://status.acmenotes.example/notes",
          ),
          "src/server.js": `${head}${body}`,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(graded(report), [
        ["RW-N02", "medium"],
        ["RW-N01", "low"],
      ]);
      const [unresolved] = report.findings;
      // The bound site is graded by its host; only the env request counts.
      assert.deepEqual(
        unresolved.evidence.map((item) => item.location?.line),
        [line],
      );
      assert.match(unresolved.summary, /\(0 → 1 in this module\)/);
      assert.ok(
        unresolved.unknowns.every(
          (unknown) => !/cannot tell which site is new/.test(unknown),
        ),
        unresolved.unknowns.join("\n"),
      );
    });

  it("does not count a site bound to a host the old release already contacted", () => {
    const urls =
      'export const NOTES_URL = "https://db.partner-store.example/notes";\nexport const HEALTH_URL = "https://db.partner-store.example/health";\n';
    const { result, report } = compare(
      {
        "src/constants.js": urls,
        "src/server.js":
          'import { NOTES_URL } from "./constants.js";\nexport const notes = () => fetch(NOTES_URL);\n',
      },
      {
        "src/constants.js": urls,
        "src/server.js":
          'import { NOTES_URL, HEALTH_URL } from "./constants.js";\nexport const health = () => fetch(HEALTH_URL);\nexport const notes = () => fetch(NOTES_URL);\n',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(graded(report), []);
  });
});

describe("compare: cleartext through a re-export", { skip }, () => {
  it("reports an http:// URL a changed barrel now re-exports to an unchanged request", () => {
    const configs = {
      "src/config/prod.js":
        'export const ERP_URL = "https://erp.partner-erp.example/sync";\n',
      "src/config/legacy.js":
        'export const ERP_URL = "http://erp.partner-erp.example/sync";\n',
    };
    const server =
      'import { ERP_URL } from "./config/index.js";\nexport const push = (body) => fetch(ERP_URL, { method: "POST", body });\n';
    const { result, report } = compare(
      {
        ...configs,
        "src/config/index.js": 'export * from "./prod.js";\n',
        "src/server.js": server,
      },
      {
        ...configs,
        "src/config/index.js": 'export * from "./legacy.js";\n',
        "src/server.js": server,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(graded(report), [["RW-N03", "medium"]]);
    assert.match(
      report.findings[0].summary,
      /reaches erp\.partner-erp\.example over http; v1\.0\.0 reached it only over encrypted connections/,
    );
  });
});
