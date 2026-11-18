import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { VISITOR_KEYS } from "@babel/types";
import { readLocal } from "./files.mjs";

const unknown = Symbol("non-literal");
const binary = new Map([
  ["+", (a, b) => a + b],
  ["-", (a, b) => a - b],
  ["*", (a, b) => a * b],
  ["/", (a, b) => a / b],
  ["%", (a, b) => a % b],
  ["===", (a, b) => a === b],
  ["!==", (a, b) => a !== b],
  ["<", (a, b) => a < b],
  [">", (a, b) => a > b],
  ["<=", (a, b) => a <= b],
  [">=", (a, b) => a >= b],
  ["^", (a, b) => a ^ b],
  ["&", (a, b) => a & b],
  ["|", (a, b) => a | b],
]);
const unary = new Map([
  ["!", (a) => !a],
  ["~", (a) => ~a],
  ["+", (a) => +a],
  ["-", (a) => -a],
]);
function constant(node, depth = 0) {
  if (!node || depth > 64) return unknown;
  if (
    [
      "NumericLiteral",
      "StringLiteral",
      "BooleanLiteral",
      "NullLiteral",
    ].includes(node.type)
  )
    return node.type === "NullLiteral" ? null : node.value;
  let result = unknown;
  if (node.type === "BinaryExpression" && binary.has(node.operator)) {
    const a = constant(node.left, depth + 1),
      b = constant(node.right, depth + 1);
    if (a !== unknown && b !== unknown)
      result = binary.get(node.operator)(a, b);
  } else if (node.type === "UnaryExpression" && unary.has(node.operator)) {
    const a = constant(node.argument, depth + 1);
    if (a !== unknown) result = unary.get(node.operator)(a);
  } else if (node.type === "ConditionalExpression") {
    const test = constant(node.test, depth + 1);
    if (test !== unknown)
      result = constant(test ? node.consequent : node.alternate, depth + 1);
  } else if (node.type === "TemplateLiteral") {
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
      parts.push(node.quasis[i].value.cooked);
      if (i < node.expressions.length) {
        const x = constant(node.expressions[i], depth + 1);
        if (x === unknown) return unknown;
        parts.push(String(x));
      }
    }
    result = parts.join("");
  }
  if (
    typeof result === "number" &&
    (!Number.isFinite(result) || Object.is(result, -0))
  )
    return unknown;
  if (typeof result === "string" && result.length > 2048) return unknown;
  return result;
}
export function explainConstants(path, { offset, limit }) {
  const { text, sha256 } = readLocal(path, 4 * 1024 * 1024, { digest: true });
  const ast = parse(text, {
    sourceType: "unambiguous",
    plugins: ["jsx"],
    attachComment: false,
  });
  const todo = [ast.program],
    matches = [];
  while (todo.length) {
    const n = todo.pop();
    if (n.end <= offset) continue;
    if (
      [
        "BinaryExpression",
        "UnaryExpression",
        "ConditionalExpression",
        "TemplateLiteral",
      ].includes(n.type)
    ) {
      const value = constant(n);
      if (value !== unknown && n.start >= offset) {
        if (matches.length === limit)
          return { sha256, matches, next_offset: n.start };
        matches.push({
          start: n.start,
          end: n.end,
          line: n.loc.start.line,
          column: n.loc.start.column,
          value,
        });
        continue;
      }
    }
    const children = [];
    for (const key of VISITOR_KEYS[n.type] ?? []) {
      if (n.type === "TaggedTemplateExpression" && key === "quasi") {
        children.push(...n.quasi.expressions);
        continue;
      }
      const x = n[key];
      if (Array.isArray(x)) {
        for (const child of x) if (child) children.push(child);
      } else if (x) children.push(x);
    }
    // Source order also holds for constructs whose grammar visitor keys are out of order.
    children.sort((a, b) => a.start - b.start);
    for (let i = children.length - 1; i >= 0; i--) todo.push(children[i]);
  }
  return { sha256, matches, next_offset: null };
}

export async function mapPosition(
  path,
  { line, column, limit, offset = 0 },
  signal,
) {
  const { SourceMapDecoder } =
    await import("../../../dist/javascript/sourceMaps/SourceMapDecoder.js");
  const { WEB_SOURCE_MAP_LIMITS } =
    await import("../../../dist/domain/webSourceLocation.js");
  const { text, sha256 } = readLocal(path, WEB_SOURCE_MAP_LIMITS.mapBytes, {
    digest: true,
  });
  const codec = new SourceMapDecoder();
  try {
    const r = await codec.trace(
      {
        text,
        path: resolve(path),
        url: pathToFileURL(resolve(path)).href,
        position: { line, column },
      },
      { signal },
    );
    if (!r.ok) throw r.error;
    const report = r.value;
    const matches = report.matches.slice(offset, offset + limit).map((m) => {
      if (m.state !== "mapped") return m;
      const pos = m.original_position,
        embedded = m.content.state === "embedded";
      const excerpt =
        embedded && pos.offset != null
          ? m.content.text.slice(Math.max(0, pos.offset - 80), pos.offset + 160)
          : null;
      return {
        source: m.reported_source,
        source_root: m.reported_source_root,
        name: m.name,
        position: pos,
        section: m.section_path,
        embedded_sha256: embedded ? m.content.utf8_sha256 : null,
        excerpt,
      };
    });
    return {
      source_map_sha256: sha256,
      lookup: report.lookup,
      matches,
      total: report.matches.length,
    };
  } finally {
    await codec.close();
  }
}

// Report the mapping rows and their declared line ranges. Multiple matching rows
// can describe inlining, overloads or a shared obfuscated name.
export function mappedSymbol(
  path,
  { class_name, method, line, limit, offset = 0 },
) {
  const { text, sha256 } = readLocal(path, 64 * 1024 * 1024, { digest: true });
  const matches = [];
  let total = 0,
    owner = null,
    skipped = 0,
    lineNumber = 0;
  const add = (value) => {
    if (total++ >= offset && matches.length < limit) matches.push(value);
  };
  for (let start = 0; start < text.length;) {
    const next = text.indexOf("\n", start);
    const raw = text.slice(start, next < 0 ? text.length : next);
    start = next < 0 ? text.length : next + 1;
    lineNumber++;
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const head = /^(\S+) -> (\S+):$/.exec(s);
    if (head) {
      owner = head[2] === class_name ? head[1] : null;
      if (owner && !method)
        add({ original_class: owner, mapping_line: lineNumber });
      continue;
    }
    if (!owner || !method) continue;
    const row =
      /^(?:(\d+):(\d+):)?(\S+) ([^\s(]+)\(([^)]*)\)(?::(\d+)(?::(\d+))?)? -> (\S+)$/.exec(
        s,
      );
    if (!row) {
      if (s.includes("(")) skipped++;
      continue;
    }
    if (row[8] !== method) continue;
    const range = row[1] ? [Number(row[1]), Number(row[2])] : null;
    if (line !== undefined && range && (line < range[0] || line > range[1]))
      continue;
    const original = row[6] ? [Number(row[6]), Number(row[7] ?? row[6])] : null;
    const dot = row[4].lastIndexOf(".");
    add({
      original_class: dot >= 0 ? row[4].slice(0, dot) : owner,
      method: row[4].slice(dot + 1),
      return_type: row[3],
      parameters: row[5],
      obfuscated_range: range,
      original_range: original,
      mapping_line: lineNumber,
    });
  }
  return {
    mapping_sha256: sha256,
    matches,
    total,
    unparsed_method_rows: skipped,
  };
}
