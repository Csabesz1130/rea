// The single redaction and escaping boundary for everything Release Watch
// prints or writes: credential-format tokens and JWTs anywhere, URL query
// values, fragments, user info and token-like path segments, and control
// characters. It also owns the rules that find secrets written in free
// text, which source lines and prompt previews mask (source-line.mjs reads
// the text and applies them).
import { credentialsIn } from "./catalog.mjs";
import {
  CONTROL,
  displayUrlsIn,
  hasRandomRun,
  isTokenSegment,
  literalParts,
  maskTag,
  maskUrlsIn,
  replaceSpans,
  runSpans,
  urlMasks,
} from "./urls.mjs";

const QUOTES = "\"'`";
const MAX_VALUE = 512;
const TOKEN_CHARACTERS = /[A-Za-z0-9_-]+/g;

const tagged = (text, start, end, rank) => ({
  start,
  end,
  tag: maskTag(text.slice(start, end)),
  rank,
});

// Spans in order and disjoint: of overlapping spans the first, longest wins.
const disjoint = (spans) => {
  const kept = [];
  for (const span of spans.toSorted(
    (a, b) => a.start - b.start || b.end - a.end,
  ))
    if (span.end > span.start && span.start >= (kept.at(-1)?.end ?? 0))
      kept.push(span);
  return kept;
};

/**
 * Documented credential formats in a text, shown in their masked form, as
 * `{ start, end, tag, rank }`. catalog.mjs matches a credential only where
 * no token character touches it, so each match is a whole run of token
 * characters and one scan of those runs finds it; a value that scan finds
 * fewer times than catalog.mjs matched it is found by search.
 */
const credentialSpans = (text) => {
  const found = credentialsIn(text);
  if (found.length === 0) return [];
  const expected = new Map();
  for (const { value, masked } of found)
    expected.set(value, {
      masked,
      count: (expected.get(value)?.count ?? 0) + 1,
      seen: 0,
    });
  const spans = [];
  const add = (start, value, { masked }) =>
    spans.push({
      start,
      end: start + value.length,
      tag: masked,
      rank: "credential",
    });
  for (const { 0: value, index } of text.matchAll(TOKEN_CHARACTERS)) {
    const entry = expected.get(value);
    if (entry === undefined) continue;
    entry.seen += 1;
    add(index, value, entry);
  }
  for (const [value, entry] of expected)
    for (
      let at = entry.seen < entry.count ? text.indexOf(value) : -1;
      at !== -1;
    ) {
      add(at, value, entry);
      at = text.indexOf(value, at + value.length);
    }
  return spans;
};

// JSON Web Tokens, found from their `eyJ` header.
const jwtSpans = ({ text }) => {
  const spans = [];
  const part = (from) => {
    let end = from;
    while (end < text.length && /[\w-]/.test(text[end])) end += 1;
    return end;
  };
  for (let at = text.indexOf("eyJ"); at !== -1;) {
    const header = part(at);
    const payload = text[header] === "." ? part(header + 1) : header;
    const signature = text[payload] === "." ? part(payload + 1) : payload;
    if (!/[\w-]/.test(text[at - 1] ?? "") && payload - header > 2)
      spans.push(tagged(text, at, signature, "pattern"));
    at = text.indexOf("eyJ", Math.max(header, at + 3));
  }
  return spans;
};

// Control and bidirectional characters written as `\uXXXX`, so report.json
// cannot reorder or hide what a reader of it sees.
const encodeControls = (text) =>
  text.replace(
    CONTROL,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );

// Credential formats and JWTs, masked in one pass from their offsets.
const maskTokens = (text) =>
  replaceSpans(
    text,
    disjoint([...credentialSpans(text), ...jwtSpans({ text })]),
  );

/**
 * Mask credentials and URL secrets in one text: absolute http(s) and ws(s)
 * URLs as displayUrl shows them, then every URL written in the text by
 * pattern, including relative ones in a header value (sw.js?key=,
 * report-uri csp/r/<token>, ?token=, ;jsessionid=) and other schemes' user
 * info, then credential formats and JWTs; controls are encoded.
 */
export const scrubText = (text) =>
  typeof text === "string"
    ? encodeControls(maskTokens(maskUrlsIn(displayUrlsIn(text), "prose")))
    : text;

/**
 * A caller-selected local path, such as an input or an Evidence file:
 * credential formats and JWTs masked and controls encoded, nothing else.
 */
export const scrubPath = (text) =>
  typeof text === "string" ? encodeControls(maskTokens(text)) : text;

// A source line sourceLine masked, scrubbed again as code: a ternary such
// as `a?b=1:c` is no query there.
const scrubCode = (text) =>
  encodeControls(maskTokens(maskUrlsIn(displayUrlsIn(text), "code")));

// An absolute local path, or a relative one with a directory, in error and
// coverage text: no scheme, query or fragment, trailing punctuation left out.
const LOCAL_PATH =
  /(?<=^|[\s"'`([=])(?:[A-Za-z]:[\\/]|\\\\|\/(?![/\\])|\.{1,2}\/|[\w.-]+[\\/])[^\s"'`<>|?#@:]*(?<![.,;!])/g;

/** Text that names local files, such as an error or a coverage note: its paths as scrubPath keeps them, the rest as scrubText. */
export const scrubLocalText = (text) => {
  if (typeof text !== "string") return text;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(LOCAL_PATH)) {
    result += scrubText(text.slice(cursor, match.index)) + scrubPath(match[0]);
    cursor = match.index + match[0].length;
  }
  return result + scrubText(text.slice(cursor));
};

// A report value scrubbed by its own rule rather than as text.
class Scrubbed {
  constructor(value, scrub) {
    this.value = value;
    this.scrub = scrub;
  }
}

/** Mark a caller-selected local path (an input, an Evidence or output file) for scrubDeep. */
export const localPath = (value) =>
  typeof value === "string" ? new Scrubbed(value, scrubPath) : value;

/** Mark a source line shown next to evidence for scrubDeep, which reads it as code. */
export const sourceText = (value) =>
  typeof value === "string" ? new Scrubbed(value, scrubCode) : value;

// A JSON-like value with each string and marked value replaced by `map`.
const mapDeep = (value, map) => {
  if (typeof value === "string" || value instanceof Scrubbed) return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapDeep(entry, map));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapDeep(entry, map)]),
  );
};

/** Mark every string in a value as text that names local files (errors, coverage) for scrubDeep. */
export const localText = (value) =>
  mapDeep(value, (text) =>
    typeof text === "string" ? new Scrubbed(text, scrubLocalText) : text,
  );

// What a field shows when scrubbing it failed: never the unscrubbed value.
const WITHHELD = "‹withheld: masking failed›";
const guarded = (scrub, text) => {
  try {
    return scrub(text);
  } catch {
    return WITHHELD;
  }
};

/**
 * Scrub every string inside a JSON-like value: marked values by their own
 * rule, other strings by `scrubString`. A field whose scrubbing fails is
 * withheld, so a report is always written and never unscrubbed.
 */
export const scrubDeep = (value, scrubString = scrubText) =>
  mapDeep(value, (item) =>
    item instanceof Scrubbed
      ? guarded(item.scrub, item.value)
      : guarded(scrubString, item),
  );

/** One printable line for a terminal: controls become spaces. */
export const printable = (text) =>
  String(text ?? "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CONTROL, " ");

/**
 * Text safe inside Markdown and HTML-aware renderers such as pull-request
 * comments: no HTML, no emphasis, links, tables or code, and no block marker
 * at the start of a line.
 */
export const markdownText = (text) =>
  printable(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]|~])/g, "\\$1")
    .replace(/^(\s*)([#+-])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/, "$1\\$2");

/** Text for a Markdown code span: no backticks or line breaks. */
export const markdownCode = (text) => printable(text).replace(/`/g, "'");

// Secrets written in text. Each rule returns spans `{ start, end, tag,
// rank }` over a view `{ text, kinds, runs, owned }`: equal kinds mean two
// characters were written the same way (a quote written as `\"` does not
// close one written as `"`), `runs` are the text's urls.mjs URL runs and
// `owned` marks the characters whose masking the URL rules decide. No rule
// depends on reading the text's syntax correctly, and every scan is linear
// in the text.

const sameWriting = ({ text, kinds }, at, other) =>
  text[at] === text[other] && kinds?.[at] === kinds?.[other];

// User info, token segments, query values and fragments of every URL, with
// the tags urls.mjs gives the same parts of a claim.
const urlSpans = ({ text, runs }) => {
  const spans = [];
  for (const run of runs) runSpans(text, run, spans);
  return spans.map((part) => ({ ...part, rank: "url" }));
};

const WORD = /[A-Za-z0-9_+/.-]/;
const RANDOM = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{8,64}$/;

// The token parts of one '/'-separated segment of a word, as urls.mjs
// decides for a path: a dotted segment keeps its readable parts.
const segmentTokens = (segments, index, offset, ranges) => {
  const segment = segments[index];
  if (!isTokenSegment(segment, segments[index + 1])) return;
  if (!segment.includes(".")) {
    ranges.push([offset, offset + segment.length]);
    return;
  }
  let at = offset;
  for (const part of segment.split(".")) {
    if (hasRandomRun(part)) ranges.push([at, at + part.length]);
    at += part.length + 1;
  }
};

// Base64 with '/' is one value: it has '+' or '=' padding, or a short
// random-looking piece beside a token-like one.
const isBase64 = (word, segments) =>
  !word.includes(".") &&
  hasRandomRun(word.replaceAll("/", "")) &&
  (/\+|=$/.test(word) ||
    segments.some((segment) => RANDOM.test(segment) && !hasRandomRun(segment)));

// The ranges to mask in one run of word characters.
const wordTokens = (word) => {
  const segments = word.split("/");
  if (isBase64(word, segments)) return [[0, word.length]];
  const ranges = [];
  let offset = 0;
  for (let index = 0; index < segments.length; index += 1) {
    segmentTokens(segments, index, offset, ranges);
    offset += segments[index].length + 1;
  }
  return ranges;
};

// Random-looking runs outside URLs: code, strings and comments alike. '/'
// separates path segments, so a readable path stays readable.
const wordSpans = ({ text, owned }) => {
  const word = (at) => !owned[at] && WORD.test(text[at]);
  const spans = [];
  for (let index = 0; index < text.length;) {
    if (!word(index)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && word(end)) end += 1;
    while (end < text.length && end - index < 4096 && text[end] === "=")
      end += 1;
    for (const [from, to] of wordTokens(text.slice(index, end)))
      spans.push(tagged(text, index + from, index + to, "word"));
    index = end;
  }
  return spans;
};

const skipSpaces = (text, index, step) => {
  let at = index;
  while (Math.abs(at - index) < 16 && /[ \t]/.test(text[at] ?? "")) at += step;
  return at;
};

// The body of the quoted string opening at `open`: it closes at the same
// quote written the same way, or, unclosed, at the end of its first word.
// A template's body is its literal parts: interpolations are code.
const quotedBody = (view, open) => {
  const limit = Math.min(view.text.length, open + 1 + MAX_VALUE);
  for (let index = open + 1; index < limit; index += 1)
    if (sameWriting(view, index, open))
      return { start: open + 1, end: index, closed: true };
  let end = open + 1;
  while (end < limit && !/[\s,;)}\]]/.test(view.text[end])) end += 1;
  return { start: open + 1, end, closed: false };
};

// A string concatenated after the one closing at `close`: `"…key=" + "v"`.
const concatenated = (view, close) => {
  const plus = skipSpaces(view.text, close + 1, 1);
  if (view.text[plus] !== "+") return null;
  const open = skipSpaces(view.text, plus + 1, 1);
  return QUOTES.includes(view.text[open] ?? "") ? quotedBody(view, open) : null;
};

// A quoted value and up to three strings concatenated after it.
const chained = (view, value) => {
  const values = [value];
  for (let next = value; values.length < 4 && next?.closed;) {
    next = concatenated(view, next.end);
    if (next !== null) values.push(next);
  }
  return values;
};

const credentialShaped = (value) =>
  value.length >= 16 ||
  (value.length >= 6 &&
    (/[\d+/=_.~-]/.test(value) ||
      (/[a-z]/.test(value) && /[A-Z]/.test(value))));

// Bearer, Basic and Token values, also in a concatenated string, and the
// `user:password` that `btoa("…")` encodes for a Basic header.
const schemeSpans = (view) => {
  const { text } = view;
  const spans = [];
  for (const match of text.matchAll(/\b(?:Bearer|Basic|Token)[ \t]{1,8}/gi)) {
    const start = match.index + match[0].length;
    let end = start;
    while (end - start < 2048 && /[A-Za-z0-9._~+/=-]/.test(text[end] ?? ""))
      end += 1;
    if (credentialShaped(text.slice(start, end)))
      spans.push(tagged(text, start, end, "pattern"));
    const next =
      end === start && QUOTES.includes(text[end] ?? "")
        ? concatenated(view, end)
        : null;
    if (next !== null) spans.push(tagged(text, next.start, next.end, "quoted"));
  }
  for (const match of text.matchAll(/\bbtoa\([ \t]*/g)) {
    const open = match.index + match[0].length;
    if (!QUOTES.includes(text[open] ?? "")) continue;
    const body = quotedBody(view, open);
    if (text.slice(body.start, body.end).includes(":"))
      spans.push(tagged(text, body.start, body.end, "quoted"));
  }
  return spans;
};

// The `user:password` of curl's `-u`/`--user` (`-U`/`--proxy-user`) option
// in a text that names curl: HTTP Basic credentials on a command line.
const CURL_USER =
  /(?<![\w-])(?:-u|-U|--user|--proxy-user)(?:=|[ \t]{0,8})(["']?)([^\s"'`:]{0,256}:[^\s"'`]{1,512})\1/g;
const curlUserSpans = ({ text }) => {
  const curl = text.search(/\bcurl\b/);
  if (curl === -1) return [];
  const spans = [];
  for (const match of text.slice(curl).matchAll(CURL_USER)) {
    const end = curl + match.index + match[0].length - match[1].length;
    spans.push(tagged(text, end - match[2].length, end, "pattern"));
  }
  return spans;
};

const CREDENTIAL_WORDS =
  /key|token|secret|auth|pass|pwd|signature|credential|subscription|session|cookie|appid|client_?id/i;
const NAME = /[A-Za-z0-9_$-]/;
const NAME_PIECES = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

const credentialName = (name) =>
  CREDENTIAL_WORDS.test(name) ||
  (name.match(NAME_PIECES) ?? []).some((piece) => /^sig$/i.test(piece));

// The credential-like name that ends just before a separator, quoted or
// not, also as a bracketed key (`h["x-api-key"] =`): `{ start, name,
// quoted, opener }`, `opener` being the character before it.
const nameBefore = (view, separator) => {
  const { text } = view;
  let index = skipSpaces(text, separator - 1, -1);
  const bracket = text[index] === "]";
  if (bracket) index = skipSpaces(text, index - 1, -1);
  const quote = QUOTES.includes(text[index] ?? "") ? index : -1;
  if (quote !== -1) index -= 1;
  else if (bracket) return null;
  const end = index + 1;
  while (index >= 0 && end - index <= 64 && NAME.test(text[index])) index -= 1;
  const name = text.slice(index + 1, end);
  if (NAME.test(text[index] ?? "") || !credentialName(name)) return null;
  if (quote === -1)
    return { start: index + 1, name, quoted: false, opener: text[index] ?? "" };
  return sameWriting(view, index, quote)
    ? { start: index, name, quoted: true, opener: text[index - 1] ?? "" }
    : null;
};

// An unquoted query or form value: `?token=v`, `&key=v`, "token=v".
const pairValue = (text, from) => {
  let end = from;
  while (
    end - from < MAX_VALUE &&
    end < text.length &&
    !/[&#\s"'`<>;\\]/.test(text[end]) &&
    !text.startsWith("${", end)
  )
    end += 1;
  return { start: from, end };
};

// An unquoted value that is a value rather than code: in a comment or in
// template text any word, elsewhere only a literal mixing letters and
// digits, so `token: getToken()` stays readable.
const bareValue = (view, start) => {
  const { text } = view;
  let end = start;
  while (
    end - start < MAX_VALUE &&
    end < text.length &&
    !/[\s,;)}\]"'`<>&]/.test(text[end]) &&
    !text.startsWith("${", end) &&
    !text.startsWith("*/", end)
  )
    end += 1;
  const written = text.slice(start, end);
  if (end === start) return null;
  if (view.free[start]) return { start, end };
  return /^[A-Za-z0-9_+/=~-]+$/.test(written) &&
    /\d/.test(written) &&
    /[A-Za-z]/.test(written)
    ? { start, end }
    : null;
};

// Strings an expression falls back to after `||`, `??` or a ternary's `?`
// and `:`: `process.env.API_KEY || "dev-…"`. The expression ends at `;`,
// `,` or a closing bracket outside brackets.
const fallbackValues = (view, from) => {
  const { text } = view;
  const values = [];
  let depth = 0;
  for (let index = from; index < text.length && index - from < 256;) {
    const character = text[index];
    if (QUOTES.includes(character)) {
      const body = quotedBody(view, index);
      const before = text.slice(Math.max(from, index - 18), index).trimEnd();
      if (depth === 0 && /(?:\|\||\?\?|[?:])$/.test(before)) values.push(body);
      index = body.end + 1;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character) && --depth < 0) break;
    else if (depth === 0 && ";,".includes(character)) break;
    index += 1;
  }
  return values;
};

// The value after `name=`: quoted, a query or form pair, a string
// concatenated after the one the pair ends, an unquoted value or the
// strings an expression falls back to.
const equalsValue = (view, separator, name) => {
  const start = skipSpaces(view.text, separator + 1, 1);
  const pair =
    start === separator + 1 &&
    (/[?&;"'`]/.test(name.opener) || name.start === 0);
  if (!QUOTES.includes(view.text[start] ?? ""))
    return pair
      ? [pairValue(view.text, start)]
      : [bareValue(view, start) ?? fallbackValues(view, start)].flat();
  return pair && !name.quoted
    ? [concatenated(view, start)]
    : chained(view, quotedBody(view, start));
};

// The value after `name:`: quoted, the rest of a header line written in one
// string ("x-api-key: v"), an unquoted value or fallback strings.
const colonValue = (view, separator, name) => {
  const { text } = view;
  const start = skipSpaces(text, separator + 1, 1);
  if (QUOTES.includes(text[start] ?? ""))
    return chained(view, quotedBody(view, start));
  if (name.quoted || !QUOTES.includes(name.opener))
    return [bareValue(view, start) ?? fallbackValues(view, start)].flat();
  let end = start;
  while (
    end - start < MAX_VALUE &&
    end < text.length &&
    text[end] !== name.opener
  )
    end += 1;
  return [text[end] === name.opener ? { start, end } : pairValue(text, start)];
};

// The value after `("name", `: a call or array argument.
const commaValue = (view, separator, name) => {
  if (!name.quoted) return [];
  const before = skipSpaces(view.text, name.start - 1, -1);
  const start = skipSpaces(view.text, separator + 1, 1);
  return "([".includes(view.text[before] ?? "") &&
    QUOTES.includes(view.text[start] ?? "")
    ? chained(view, quotedBody(view, start))
    : [];
};

// The argument of a credential setter: `setPassword("v")`.
const callValue = (view, separator, name) => {
  const start = skipSpaces(view.text, separator + 1, 1);
  return !name.quoted &&
    /^set[A-Z_]/.test(name.name) &&
    QUOTES.includes(view.text[start] ?? "")
    ? chained(view, quotedBody(view, start))
    : [];
};

const SEPARATORS = {
  ":": colonValue,
  "=": equalsValue,
  ",": commaValue,
  "(": callValue,
};

// Where a text is comment or template text, from a light scan: after `//`
// or inside `/* … */` where a comment can start, and between backticks
// written as backticks. It decides only how much of an unquoted value is
// masked.
const freeText = ({ text, kinds }) => {
  const free = new Uint8Array(text.length);
  let ticks = 0;
  let comment = "";
  for (let index = 0; index < text.length; index += 1) {
    const next = text[index + 1];
    if (comment === "*" && text[index] === "*" && next === "/") comment = "";
    else if (
      comment === "" &&
      text[index] === "/" &&
      (next === "/" || next === "*") &&
      /[\s;,(){}]/.test(text[index - 1] ?? " ")
    )
      comment = next;
    if (text[index] === "`" && !kinds?.[index]) ticks += 1;
    free[index] = comment !== "" || ticks % 2 === 1 ? 1 : 0;
  }
  return free;
};

// Values written after a credential-like name: `name: "v"`, `"name":"v"`,
// `name="v"`, `?name=v`, `("name", "v")`, `h["name"] = "v"`,
// `setName("v")`, fallbacks and unquoted values. Code that reads a secret,
// such as `apiKey: process.env.KEY`, writes no value; "Bearer " before a
// variable is no secret, and only a template's literal parts are values.
// A value inside a URL is the URL rules' to mask.
const fieldSpans = (view) => {
  const spans = [];
  const scope = { ...view, free: freeText(view) };
  for (let index = 0; index < view.text.length; index += 1) {
    const valueOf = SEPARATORS[view.text[index]];
    if (valueOf === undefined || "=>".includes(view.text[index + 1] ?? "_"))
      continue;
    const name = nameBefore(view, index);
    const values = name === null ? [] : valueOf(scope, index, name);
    const literal = values
      .filter((value) => value && !urlMasks(view, value.start))
      .flatMap((value) => literalParts(view.text, value.start, value.end));
    const written = literal
      .map((part) => view.text.slice(part.start, part.end))
      .join("");
    if (/^[\s=&?#:;,]*$|^\s*(?:Bearer|Basic|Token)\s*$/i.test(written))
      continue;
    for (const part of literal)
      spans.push(tagged(view.text, part.start, part.end, "quoted"));
  }
  return spans;
};

// Strings written as pieces of one value: `"…?key=".concat("v")`,
// `["…?token=", "v"].join("")`, `.concat("api_key", "=", "v")`. A string
// after pieces that end with `name=` is a query or form value, and one
// concatenated after code that ends user info with `@` holds a password
// (`"https://" + u + ":pw@host"`).
const pieceSpans = (view) => {
  const { text } = view;
  const spans = [];
  let joined = "";
  let close = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (!QUOTES.includes(text[index])) continue;
    const body = quotedBody(view, index);
    if (!body.closed) continue;
    const between = close === -1 ? null : text.slice(close + 1, index);
    const value = text.slice(body.start, body.end);
    const adjacent =
      between !== null && /^\s*(?:,|\+|\)?\.concat\()\s*$/.test(between);
    if (adjacent && /[\w.~%-]=$/.test(joined) && value !== "")
      spans.push(tagged(text, body.start, body.end, "quoted"));
    const userinfo = /^(:?)([^\s/?#@]+)@/.exec(value);
    if (userinfo && /\+\s*$/.test(text.slice(Math.max(0, index - 64), index)))
      spans.push(
        tagged(
          text,
          body.start + userinfo[1].length,
          body.start + userinfo[1].length + userinfo[2].length,
          "quoted",
        ),
      );
    joined = adjacent ? `${joined}${value}`.slice(-256) : value;
    close = body.end;
    index = body.end;
  }
  return spans;
};

/**
 * Spans of secrets written anywhere in a text view, in no order and
 * possibly overlapping: credential formats, the secret parts of its URL
 * runs, random-looking runs outside URLs, JWTs, Bearer/Basic/Token values,
 * curl's `-u user:password`, and values written after a credential-like
 * name or as pieces of a query value or user info. `rank` names the rule: "url", "credential",
 * "pattern", "quoted" (a value read up to a quote) or "word".
 */
export const secretSpans = (view) => [
  ...credentialSpans(view.text),
  ...urlSpans(view),
  ...wordSpans(view),
  ...jwtSpans(view),
  ...schemeSpans(view),
  ...curlUserSpans(view),
  ...fieldSpans(view),
  ...pieceSpans(view),
];
