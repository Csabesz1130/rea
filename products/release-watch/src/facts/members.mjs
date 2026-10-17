// Member reads REA reports (`shell.run`, `read:/run`), with REA's read path
// below the object and the expression REA's nodes place each one on. REA
// reports no node for `this` or `super`, so a read with nothing before its
// member is on one of them (or on a literal); the receiver of any other is
// the one node that holds all REA reports there, wherever it starts inside
// the read's parentheses, and it may share them with `this` when the space
// it leaves there is uneven. Ranges and node ids only; no source is read.
import { comesBefore, firstStarting, startsBefore } from "../ranges.mjs";

const rangeOf = (node) => node?.identity?.source_range ?? null;
const moduleOf = (node) => node?.identity?.module_path ?? null;
const MEMBER_READ = /^read:\/(.+)$/;

// Every positioned node of each module, by start, the longest first among
// those starting together.
const nodesByModule = (semantic) => {
  const modules = new Map();
  for (const node of semantic.nodes) {
    if (!rangeOf(node)) continue;
    const module = moduleOf(node);
    if (!modules.has(module)) modules.set(module, []);
    modules.get(module).push(node);
  }
  for (const list of modules.values())
    list.sort(
      (a, b) =>
        startsBefore(rangeOf(a), rangeOf(b)) ||
        startsBefore({ start: rangeOf(b).end }, { start: rangeOf(a).end }),
    );
  return modules;
};

// The outermost nodes REA reports inside a member read that end before it
// does: what the member is read on. Nodes that end with it or after it are
// the read itself and the calls and arguments around it.
const beforeMember = (nodes, range) => {
  const found = [];
  let next = firstStarting(nodes, range, { rangeOf });
  while (next < nodes.length) {
    const at = rangeOf(nodes[next]);
    if (!comesBefore(at.start, range.end)) break;
    if (!comesBefore(at.end, range.end)) {
      next += 1;
      continue;
    }
    found.push(nodes[next]);
    next = Math.max(
      next + 1,
      firstStarting(nodes, { start: at.end }, { rangeOf }),
    );
  }
  return found;
};

// The space one node leaves inside a member read's parentheses on one side:
// columns on the node's line, or a line break.
const space = (from, to) =>
  from.line === to.line ? to.column - from.column : "break";

// True when the one node REA reports inside a member read's parentheses
// may share them with an operand REA reports no node for, such as `this`
// in `(x || this).run` or `(this || x).run`: the space it leaves after the
// opening parenthesis differs from the space before the closing one, which
// is taken to sit right before `.member` (REA reports no position for
// either). The same space on both sides (`( x )`, or line breaks around
// it), one column more after it for a `?.` read, is layout.
const leavesRoom = (range, node, path) => {
  const at = rangeOf(node);
  if (!comesBefore(range.start, at.start)) return false;
  const members = path.reduce((length, name) => length + name.length + 1, 0);
  const opening = { line: range.start.line, column: range.start.column + 1 };
  const closing = {
    line: range.end.line,
    column: range.end.column - members - 1,
  };
  const before = space(opening, at.start);
  const after = space(at.end, closing);
  // Optional chaining (`(x)?.run`) puts one more column before the member.
  return !(
    before === after ||
    (typeof before === "number" && after === before + 1)
  );
};

// The expression a member read is read on, as REA's nodes place it: null
// when REA reports nothing before the member (`this.run`, `super.run`, a
// literal), else `{ range, global, room }` with the one node that holds all
// REA reports there, `global` naming a receiver no binding resolves
// (`Object.keys`), and `room` set when that node may share the read's
// parentheses with `this` (`leavesRoom`). REA starts a member read at its
// opening parenthesis, and the expression inside may start after spaces, a
// line break or a comment (`( await connect() ).run`), so the node need not
// start the read. `range` is null when REA's nodes there do not form one
// expression (`(a || b).run`, `[a, b].forEach`).
const receiverOf = (nodes, range, path, globals) => {
  const found = beforeMember(nodes, range);
  if (found.length === 0) return null;
  const [only] = found;
  return found.length === 1
    ? {
        range: rangeOf(only),
        global: globals.get(only) ?? null,
        room: leavesRoom(range, only, path),
      }
    : { range: null, global: null, room: false };
};

/**
 * Property reads (`shell.run`): `{ module, range, path, receiver, location }`
 * with REA's read path below the object and the expression it is read on
 * (`receiverOf`). `references` are the names REA reports no binding for,
 * `{ node, name }`, which name a global receiver.
 */
export const membersOf = (semantic, references) => {
  const globals = new Map(references.map(({ node, name }) => [node, name]));
  const modules = nodesByModule(semantic);
  return semantic.nodes.flatMap((node) => {
    const path =
      node.kind === "expression"
        ? MEMBER_READ.exec(node.label ?? "")?.[1].split("/")
        : null;
    const range = rangeOf(node);
    if (!path || !range) return [];
    return [
      {
        module: moduleOf(node),
        range,
        path,
        receiver: receiverOf(modules.get(moduleOf(node)), range, path, globals),
        location: {
          file: moduleOf(node),
          line: range.start.line,
          column: range.start.column,
        },
      },
    ];
  });
};
