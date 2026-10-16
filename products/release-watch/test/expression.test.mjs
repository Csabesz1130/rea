// The form in which Release Watch compares expressions REA did not resolve:
// formatting compares equal, any other change does not.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { comparableExpression } from "../src/facts/expression.mjs";

const same = (a, b) => comparableExpression(a) === comparableExpression(b);

describe("comparable expressions", () => {
  it("ignores spacing, comments, quoting and parentheses that change nothing", () => {
    for (const [a, b] of [
      ['process.env.SB !== "0"', "process.env.SB!=='0'"],
      ['"\\x41"', "'A'"],
      ["!app.isPackaged", "!(app.isPackaged)"],
      ["(a && b)", "a /* both */ && b"],
      ["typeof (x) === 'string'", 'typeof x === "string"'],
      ["(x) => x", "x => x"],
    ])
      assert.ok(same(a, b), `${a} | ${b}`);
  });

  it("keeps every other difference", () => {
    for (const [a, b] of [
      ["!app.isPackaged", "app.isPackaged"],
      ["a && (b || c)", "a && b || c"],
      ["(a?.b).c", "a?.b.c"],
      ["x => ({})", "x => {}"],
      ["f(a)", "f a"],
      ["a - -b", "a--b"],
      ["'a'", "'b'"],
    ])
      assert.ok(!same(a, b), `${a} | ${b}`);
  });

  it("compares text it does not tokenize as REA reported it", () => {
    for (const text of ["/a b/.test(x)", "`${a}`", "'\\101'"])
      assert.equal(comparableExpression(text), text);
    assert.equal(comparableExpression(null), null);
  });
});
