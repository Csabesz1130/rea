// The form in which Release Watch compares an expression REA reports as
// source text (a webPreferences value or spread REA did not resolve): its
// tokens with spacing, comments and string quoting normalized, and without
// the parentheses around a name, a member path, a literal or the whole
// expression. A reformatted expression compares equal; any other change,
// including an added `!`, does not. Text with a template or regular
// expression literal, an escaped name, a legacy octal escape or a character
// outside JavaScript's tokens is compared as REA reported it.

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "%=",
  "/=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
  ..."{}()[];,<>+-*/%&|^!~?:=.#",
];
// Sticky: each matches at the position its lastIndex names.
const SPACE = /(?:\s+|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/uy;
const WORD = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUMBER =
  /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?(?![\p{ID_Continue}$])/uy;
// Words after which `(` groups rather than calls, and `/` starts a regular
// expression rather than divides.
const OPERATOR_WORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
const LINE_BREAKS = new Set(["\n", "\r", "\u2028", "\u2029"]);

const hexEscape = (text, at) => {
  if (text[at] === "x") {
    const hex = /^[\da-fA-F]{2}/.exec(text.slice(at + 1, at + 3));
    return hex
      ? { value: String.fromCharCode(Number.parseInt(hex[0], 16)), end: at + 3 }
      : null;
  }
  const braced = /^\{([\da-fA-F]{1,6})\}/.exec(text.slice(at + 1, at + 9));
  const plain = braced
    ? null
    : /^[\da-fA-F]{4}/.exec(text.slice(at + 1, at + 5));
  const code = Number.parseInt(braced?.[1] ?? plain?.[0] ?? "", 16);
  if (Number.isNaN(code) || code > 0x10ffff) return null;
  return {
    value: String.fromCodePoint(code),
    end: at + 1 + (braced ?? plain)[0].length,
  };
};

// The character a string escape stands for, `{ value, end }`, or null when
// Release Watch does not decode it.
const escapeAt = (text, at) => {
  const char = text[at];
  if (char === undefined) return null;
  if (Object.hasOwn(ESCAPES, char))
    return { value: ESCAPES[char], end: at + 1 };
  if (char === "\r" && text[at + 1] === "\n") return { value: "", end: at + 2 };
  if (LINE_BREAKS.has(char)) return { value: "", end: at + 1 };
  if (char === "0" && !/\d/.test(text[at + 1] ?? ""))
    return { value: "\0", end: at + 1 };
  if (/\d/.test(char)) return null;
  if (char === "x" || char === "u") return hexEscape(text, at);
  return { value: char, end: at + 1 };
};

// A quoted string at `start`: `{ value, end }`, or null when unterminated or
// holding an escape Release Watch does not decode.
const stringAt = (text, start) => {
  const quote = text[start];
  let value = "";
  for (let at = start + 1; at < text.length;) {
    const char = text[at];
    if (char === quote) return { value, end: at + 1 };
    if (char === "\n" || char === "\r") return null;
    if (char !== "\\") {
      value += char;
      at += 1;
      continue;
    }
    const escaped = escapeAt(text, at + 1);
    if (escaped === null) return null;
    value += escaped.value;
    at = escaped.end;
  }
  return null;
};

// Whether `/` after this token starts a regular expression.
const regexAfter = (token) =>
  token === undefined ||
  (token.kind === "punctuator" && !/^[)\]}]$/.test(token.text)) ||
  (token.kind === "word" && OPERATOR_WORDS.has(token.text));

// The next token at `at`: `{ token, end }`, `{ end }` for spacing or a
// comment, or null for text Release Watch does not tokenize.
const matchAt = (pattern, text, at) => {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
};

const tokenAt = (text, at, previous) => {
  const space = matchAt(SPACE, text, at);
  if (space) return { end: at + space.length };
  const char = text[at];
  if (char === '"' || char === "'") {
    const string = stringAt(text, at);
    return string
      ? {
          token: { kind: "string", text: JSON.stringify(string.value) },
          end: string.end,
        }
      : null;
  }
  for (const [kind, pattern] of [
    ["number", NUMBER],
    ["word", WORD],
  ]) {
    const match = matchAt(pattern, text, at);
    if (match) return { token: { kind, text: match }, end: at + match.length };
  }
  if (char === "/" && regexAfter(previous)) return null;
  // `?.` before a digit is a conditional and a number.
  if (text.startsWith("?.", at) && !/\d/.test(text[at + 2] ?? ""))
    return { token: { kind: "punctuator", text: "?." }, end: at + 2 };
  const punctuator = PUNCTUATORS.find((candidate) =>
    text.startsWith(candidate, at),
  );
  return punctuator
    ? {
        token: { kind: "punctuator", text: punctuator },
        end: at + punctuator.length,
      }
    : null;
};

const tokensOf = (text) => {
  const tokens = [];
  for (let at = 0; at < text.length;) {
    const next = tokenAt(text, at, tokens.at(-1));
    if (next === null) return null;
    if (next.token) tokens.push(next.token);
    at = next.end;
  }
  return tokens;
};

// Whether `(` at `index` groups an expression rather than calls a function.
const groups = (tokens, index) => {
  const previous = tokens[index - 1];
  if (previous === undefined) return true;
  if (previous.kind === "word") return OPERATOR_WORDS.has(previous.text);
  return (
    previous.kind === "punctuator" && !/^(?:\)|\]|\?\.)$/.test(previous.text)
  );
};

// A name, a member path (`app.isPackaged`, no `?.`) or one literal.
const simple = (tokens) =>
  tokens.length === 1
    ? tokens[0].kind !== "punctuator"
    : tokens.length % 2 === 1 &&
      tokens.every((token, index) =>
        index % 2 === 0 ? token.kind === "word" : token.text === ".",
      );

// The indexes of the parentheses that change nothing, or null when the
// parentheses do not balance.
const removableParentheses = (tokens) => {
  const removed = new Set();
  const open = [];
  const inside = (from, to) =>
    tokens
      .slice(from + 1, to)
      .filter((_token, offset) => !removed.has(from + 1 + offset));
  for (const [index, token] of tokens.entries()) {
    if (token.text === "(") open.push(index);
    if (token.text !== ")") continue;
    if (open.length === 0) return null;
    const start = open.pop();
    if (groups(tokens, start) && simple(inside(start, index)))
      removed.add(start).add(index);
  }
  return open.length === 0 ? removed : null;
};

// The index of the parenthesis that closes the first token's.
const closingFirst = (tokens) => {
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
};

// Drops parentheses around the whole remaining expression.
const unwrap = (tokens) => {
  let kept = tokens;
  while (
    kept.length > 1 &&
    kept[0].text === "(" &&
    closingFirst(kept) === kept.length - 1
  )
    kept = kept.slice(1, -1);
  return kept;
};

/**
 * The comparison form of an expression REA reported as text, the text
 * itself when Release Watch cannot tokenize it, or null without text.
 */
export const comparableExpression = (text) => {
  if (typeof text !== "string") return null;
  const tokens = tokensOf(text);
  const removed = tokens === null ? null : removableParentheses(tokens);
  if (removed === null) return text;
  return unwrap(tokens.filter((_token, index) => !removed.has(index)))
    .map((token) => token.text)
    .join(" ");
};
