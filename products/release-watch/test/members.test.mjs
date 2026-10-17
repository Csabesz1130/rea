// What facts/members.mjs says a member read is read on, from synthetic REA
// nodes shaped like the ones REA reports for each form.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { membersOf } from "../src/facts/members.mjs";

const at = (line, start, end, endLine = line) => ({
  start: { line, column: start },
  end: { line: endLine, column: end },
});
let next = 0;
const node = (kind, label, range) => ({
  node_id: `n${(next += 1)}`,
  kind,
  label,
  identity: { module_path: "src/index.js", source_range: range },
});
const read = (path, range) => node("expression", `read:/${path}`, range);

// The receiver membersOf gives the one member read among `nodes`.
const receiver = (nodes, references = []) => {
  const [member] = membersOf({ nodes, relations: [] }, references);
  return member.receiver;
};

describe("facts: the expression a member read is read on", () => {
  it("gives none when REA reports nothing before the member (this.run)", () => {
    assert.equal(receiver([read("run", at(3, 4, 12))]), null);
  });

  it("gives the call a member of a call's result is read on (runGit(args).pid)", () => {
    const call = at(6, 130, 150);
    assert.deepEqual(
      receiver([
        read("pid", at(6, 130, 154)),
        node("call-site", "call", call),
        node("expression", "runGit", at(6, 130, 136)),
        node("expression", "argument 0", at(6, 137, 149)),
      ]),
      { range: call, global: null },
    );
  });

  it("gives the parenthesized expression, one column after the read", () => {
    const awaited = at(14, 73, 88);
    assert.deepEqual(
      receiver([
        node("call-site", "call", at(14, 72, 123)),
        read("run", at(14, 72, 93)),
        node("task", "awaited expression", awaited),
        node("call-site", "call", at(14, 79, 88)),
        node("expression", "connect", at(14, 79, 86)),
      ]),
      { range: awaited, global: null },
    );
  });

  it("gives the parenthesized expression after spaces or a line break", () => {
    // ( await connect() ).run
    const spaced = at(3, 2, 17);
    assert.deepEqual(
      receiver([
        read("run", at(3, 0, 23)),
        node("task", "awaited expression", spaced),
      ]),
      { range: spaced, global: null },
    );
    // (\n  await connect()\n).run
    const broken = at(4, 2, 17);
    assert.deepEqual(
      receiver([
        read("run", at(3, 0, 5, 5)),
        node("task", "awaited expression", broken),
        node("call-site", "call", at(4, 8, 17)),
      ]),
      { range: broken, global: null },
    );
  });

  it("names a global receiver no binding resolves (Object.keys)", () => {
    const object = node("expression", "Object", at(2, 0, 6));
    assert.deepEqual(
      receiver(
        [read("keys", at(2, 0, 11)), object],
        [{ node: object, name: "Object" }],
      ),
      { range: object.identity.source_range, global: "Object" },
    );
  });

  it("gives no receiver range when REA's nodes there form no one expression", () => {
    const unsettled = { range: null, global: null };
    // (a || b).run
    assert.deepEqual(
      receiver([
        read("run", at(1, 0, 12)),
        node("expression", "a", at(1, 1, 2)),
        node("expression", "b", at(1, 6, 7)),
      ]),
      unsettled,
    );
    // [a, b].forEach
    assert.deepEqual(
      receiver([
        read("forEach", at(2, 0, 14)),
        node("expression", "a", at(2, 1, 2)),
        node("expression", "b", at(2, 4, 5)),
      ]),
      unsettled,
    );
  });
});
