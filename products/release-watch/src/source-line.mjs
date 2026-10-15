// One source line for display next to an evidence item. The line is split
// into code and string literals in a single pass, so each string can be
// scrubbed by its context and the cited column can be followed into the
// scrubbed text. Display only: the saved Evidence keeps the original.
import { printable, scrubText } from "./redact.mjs";
import { isTokenSegment, maskTag } from "./urls.mjs";

const MAX_LINE = 180;
const LEAD = 60;
const MARGIN = 2000;

/** Code and string tokens of one line: `{ kind, start, end }`, in order. */
const tokenize = (text) => {
  const tokens = [];
  let code = 0;
  let index = 0;
  const flush = (end) => {
    if (end > code) tokens.push({ kind: "code", start: code, end });
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") break;
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (char !== '"' && char !== "'" && char !== "`") {
      index += 1;
      continue;
    }
    flush(index);
    let end = index + 1;
    let depth = 0;
    while (end < text.length) {
      const next = text[end];
      if (next === "\\") end += 2;
      else if (char === "`" && next === "$" && text[end + 1] === "{") {
        depth += 1;
        end += 2;
      } else if (depth > 0 && next === "}") {
        depth -= 1;
        end += 1;
      } else if (depth === 0 && next === char) break;
      else end += 1;
    }
    end = Math.min(end + 1, text.length);
    tokens.push({ kind: "string", start: index, end });
    index = end;
    code = end;
  }
  tokens.push({ kind: "code", start: code, end: text.length });
  return tokens.filter((token) => token.end > token.start);
};

const CREDENTIAL_NAME =
  /[\w-]*(?:key|token|secret|auth|password|passwd|signature|credential|subscription)[\w-]*/i;
const FIELD_BEFORE = new RegExp(
  `(?:^|[\\s{,(])["'\`]?(${CREDENTIAL_NAME.source})["'\`]?\\s*[:=]\\s*$`,
  "i",
);
const AUTH_SCHEME = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const QUERY_PAIR = /([?&][\w.[\]-]+=)([^&#\s"'`]+)/g;
const USER_INFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'`]*@/gi;
const WORD = /[A-Za-z0-9_+/=-]{20,}/g;
const ENTITIES = {
  "&amp;": "&",
  "&#38;": "&",
  "&#61;": "=",
  "&#x3d;": "=",
  "&#x3D;": "=",
};

// A run of letters and digits long enough to be a token, checked without
// lookahead so long runs stay linear.
const maskWords = (text) =>
  text.replace(WORD, (word) =>
    /\d/.test(word) && /[A-Za-z]/.test(word) ? maskTag(word) : word,
  );

// Token-like segments of a URL or path inside a string.
const maskPathTokens = (text) =>
  /:\/\/|^\//.test(text)
    ? text
        .split("/")
        .map((segment) =>
          isTokenSegment(segment.split(/[?#]/)[0]) ? maskTag(segment) : segment,
        )
        .join("/")
    : text;

// One literal string part, with no surrounding context.
const scrubLiteral = (body) =>
  scrubText(
    maskWords(
      maskPathTokens(
        body
          .replace(
            /&(?:amp|#38|#61|#x3[dD]);/g,
            (entity) => ENTITIES[entity] ?? entity,
          )
          .replace(
            USER_INFO,
            (_match, scheme) => `${scheme}${maskTag("userinfo")}@`,
          )
          .replace(
            AUTH_SCHEME,
            (_match, scheme, space, value) =>
              `${scheme}${space}${maskTag(value)}`,
          )
          .replace(
            QUERY_PAIR,
            (_match, name, value) => `${name}${maskTag(value)}`,
          ),
      ),
    ),
  );

// Whether a string's context marks its whole value as secret: a
// credential-named field before it, a "Bearer " or "key=" string just
// before it in a concatenation, or an escape that can hide a key.
const secretByContext = ({ body, before, previous, sensitive }) =>
  sensitive ||
  body.includes("\\") ||
  FIELD_BEFORE.test(before.slice(-80)) ||
  (previous !== null &&
    /^\s*[:+]\s*$|^\s*\$\{\s*$/.test(before.slice(previous.end)) &&
    (CREDENTIAL_NAME.test(previous.body) ||
      /(Bearer|Basic|Token)\s*$|[?&=]\s*$/i.test(previous.body)));

// A template literal: literal parts scrubbed, interpolations scrubbed as code.
const scrubTemplate = (body, sensitive) =>
  body.replace(/\$\{([^}]*)\}|([^$]+|\$)/g, (_match, expression, literal) =>
    expression !== undefined
      ? `\${${scrubCode(expression, sensitive)}}`
      : scrubLiteral(literal),
  );

/** One code fragment: each string scrubbed in context, code itself only for key formats. */
const scrubCode = (text, sensitive) => {
  let output = "";
  let previous = null;
  for (const token of tokenize(text)) {
    const raw = text.slice(token.start, token.end);
    if (token.kind === "code") {
      output += sensitive ? maskWords(scrubText(raw)) : scrubText(raw);
      continue;
    }
    const quote = raw[0];
    const closed = raw.length > 1 && raw.at(-1) === quote;
    const body = raw.slice(1, closed ? -1 : undefined);
    const secret = secretByContext({
      body,
      before: text.slice(0, token.start),
      previous,
      sensitive,
    });
    const shown = secret
      ? maskTag(body)
      : quote === "`"
        ? scrubTemplate(body, sensitive)
        : scrubLiteral(body);
    output += `${quote}${shown}${closed ? quote : ""}`;
    previous = { body, end: token.end };
  }
  return output;
};

/**
 * A source line for display, at most MAX_LINE characters around `column`.
 * `sensitive` masks every string and token-like word: a line where REA
 * reported a key.
 */
export const sourceLine = (text, column = 0, sensitive = false) => {
  const line = String(text);
  const from = Math.max(0, column - LEAD - MARGIN);
  const to = Math.min(line.length, column + MAX_LINE + MARGIN);
  // Widen the slice to whole tokens, so no string is cut in half.
  const tokens = tokenize(line);
  const start = Math.min(
    from,
    ...tokens
      .filter((token) => token.end > from && token.start < from)
      .map((token) => token.start),
  );
  const end = Math.max(
    to,
    ...tokens
      .filter((token) => token.start < to && token.end > to)
      .map((token) => token.end),
  );
  const before = scrubCode(
    line.slice(start, Math.max(start, Math.min(column, end))),
    sensitive,
  );
  const shown = printable(scrubCode(line.slice(start, end), sensitive));
  if (shown.length <= MAX_LINE && start === 0 && end === line.length)
    return shown.trim();
  const position = Math.min(before.length, shown.length);
  const first = Math.max(0, Math.min(position - LEAD, shown.length - MAX_LINE));
  const head = start > 0 || first > 0 ? "…" : "";
  const tail = end < line.length || first + MAX_LINE < shown.length ? "…" : "";
  return `${head}${shown.slice(first, first + MAX_LINE).trim()}${tail}`;
};
