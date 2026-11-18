// Runs the public CLI on small releases each test writes, for RW-F01: code
// that names a credential store the old release's code did not name, as
// one path or as the pieces a path is built from.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const PACKAGE = { type: "module", main: "index.js" };
const compare = (before, after) => {
  const result = run(
    written.write("1.0.0", before, PACKAGE),
    written.write("1.1.0", after, PACKAGE),
  );
  written.keep(result.out);
  return result;
};

const NOTES =
  'import { readFileSync } from "node:fs";\nexport const notes = () => readFileSync("notes.txt", "utf8");\n';
// A path whose pieces variables hold, and one REA sees read as a literal.
const AWS = [
  'import { readFileSync } from "node:fs";',
  'import { homedir } from "node:os";',
  'import path from "node:path";',
  'const DIRECTORY = ".aws";',
  'const FILE = "credentials";',
  "export const profile = () =>",
  '  readFileSync(path.join(homedir(), DIRECTORY, FILE), "utf8");',
  "",
].join("\n");
const SSH =
  'import { readFileSync } from "node:fs";\nexport const key = () => readFileSync("/root/.ssh/id_ed25519", "utf8");\n';
// The pieces passed straight to a call: REA reports none of them.
const KUBE = [
  'import { readFileSync } from "node:fs";',
  'import { homedir } from "node:os";',
  'import path from "node:path";',
  "export const cluster = () =>",
  '  readFileSync(path.join(homedir(), ".kube", "config"), "utf8");',
  "",
].join("\n");

describe("compare: credential stores a release's code names", { skip }, () => {
  it("reports a store named by one path, and one named by its pieces", () => {
    const { result, report } = compare(
      { "index.js": NOTES },
      { "index.js": NOTES, "cloud.js": AWS, "keys.js": SSH, "kube.js": KUBE },
    );
    assert.equal(result.status, 2, result.stderr);
    const findings = report.findings.filter(
      (finding) => finding.rule === "RW-F01",
    );
    // kube.js builds its path inline: a store this rule does not see.
    assert.deepEqual(findings.map((finding) => finding.title).sort(), [
      "Code names a credential store not named before: AWS credentials",
      "Code reads a credential store not named before: SSH private keys",
    ]);
    const claims = findings.flatMap((finding) =>
      finding.evidence.map((line) => `${line.basis}: ${line.claim}`),
    );
    assert.ok(
      claims.includes(
        'observed: keys.js reads the file "/root/.ssh/id_ed25519"',
      ),
      claims.join("\n"),
    );
    assert.ok(
      claims.some((claim) =>
        /cloud\.js holds "\.aws" and "credentials" as separate literals/.test(
          claim,
        ),
      ),
      claims.join("\n"),
    );
    assert.match(findings[0].summary, /no code of v1\.0\.0 names it/);
  });

  it("is silent for a store the old release named, and for half a path", () => {
    const { report } = compare(
      { "index.js": NOTES, "cloud.js": AWS },
      {
        "index.js": NOTES,
        "cloud.js": AWS,
        // The same store from another module, and names that are no store.
        "more.js": `${AWS}export const names = [".ssh", "credentials", "config"];\n`,
      },
    );
    assert.deepEqual(
      report.findings.filter((finding) => finding.rule === "RW-F01"),
      [],
    );
  });
});
