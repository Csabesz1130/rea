// A package loaded through a variable, with REA's real facts: REA resolves
// `import(name)` to no module, and Release Watch reads the specifier only
// where REA reports the variable constant (facts/loads.mjs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { skip } from "./cli-run.mjs";
import { finding, writtenCompare } from "./cli-reach-run.mjs";

const PACKAGE = { type: "module", main: "index.js" };
const BEFORE = { "index.js": "export const run = () => 1;\n" };

describe("compare: a package loaded through a variable", { skip }, () => {
  const compare = writtenCompare();

  it("reads the package a constant specifier names, as it reads an import", () => {
    // As @google/gemini-cli-core loads its pseudo-terminal (utils/getPty.js).
    const result = compare(
      BEFORE,
      {
        ...BEFORE,
        "pty.js":
          'export const getPty = async () => {\n  try {\n    const lydell = "@lydell/node-pty";\n    return await import(lydell);\n  } catch {\n    const nodePty = "node-pty";\n    return import(/* webpackIgnore: true */ nodePty);\n  }\n};\n',
      },
      PACKAGE,
    );
    const libraries = finding(result, "RW-C06");
    assert.equal(libraries.severity, "high", result.result.stderr);
    assert.equal(
      libraries.title,
      "Processes started through @lydell/node-pty, node-pty in new or changed code are not examined",
    );
    assert.deepEqual(
      libraries.evidence
        .slice(0, -1)
        .map(({ claim, basis, location }) => [claim, basis, location.line]),
      [
        [
          "pty.js loads @lydell/node-pty (import(lydell), where REA reports lydell constant)",
          "derived",
          4,
        ],
        [
          "pty.js loads node-pty (import(nodePty), where REA reports nodePty constant)",
          "derived",
          7,
        ],
      ],
    );
    assert.equal(
      finding(result, "RW-D01").title,
      "New third-party packages imported (2): @lydell/node-pty, node-pty",
    );
  });

  it("leaves a load unresolved where REA does not report its variable constant", () => {
    const result = compare(
      BEFORE,
      {
        ...BEFORE,
        // A parameter, a variable assigned again, one of two values, and a
        // constant that is only part of the specifier.
        "plugins.js":
          'export const byName = (name) => import(name);\nlet chosen = "execa";\nexport const choose = (name) => { chosen = name; };\nexport const picked = () => import(chosen);\nexport const either = (flag) => { const one = flag ? "execa" : "zx"; return import(one); };\nexport const part = () => { const base = "execa"; return import(base + "/sub"); };\n',
        // The name read is the inner constant, not the outer one it shadows.
        "shadow.js":
          'const pkg = "execa";\nexport const inner = () => { const pkg = "./local.js"; return import(pkg); };\n',
        "local.js": "export const local = 1;\n",
      },
      PACKAGE,
    );
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.equal(finding(result, "RW-C06"), undefined);
    assert.equal(finding(result, "RW-D01"), undefined);
  });
});
