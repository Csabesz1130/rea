// The single redaction and escaping boundary for everything Release Watch
// prints or writes: credential-format tokens anywhere, URL query values and
// token-like path segments, and control characters. It also owns the rules
// that find secrets written in free text, which source lines and prompt
// previews mask (source-line.mjs reads the text and applies them).
import { credentialsIn } from "./catalog.mjs";
import {
  CONTROL,
  displayUrlsIn,
  hasTokenRun,
  isTokenSegment,
  maskTag,
  maskUrlsIn,
  runSpans,
} from "./urls.mjs";

/**
 * Mask credentials and URL secrets in one text: absolute http(s) and ws(s)
 * URLs as displayUrl shows them, then every URL written in the text by
 * pattern, including relative ones in a header value (sw.js?key=,
 * report-uri /csp/<token>) and other schemes' user info.
 */
export const scrubText = (text) => {
  if (typeof text !== "string") return text;
  let result = maskUrlsIn(displayUrlsIn(text), true);
  for (const credential of credentialsIn(result))
    result = result.split(credential.value).join(credential.masked);
  return result;
};

/** Scrub every string inside a JSON-like value. */
export const scrubDeep = (value) => {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubDeep(entry)]),
    );
  return value;
};

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
// rank }` over a view `{ text, kinds }`, where equal kinds mean two
// characters were written the same way: a quote written as `\"` does not
// close one written as `"`. No rule depends on reading the text's syntax
// correctly, and every scan is linear in the text.

const QUOTES = "\"'`";
const MAX_VALUE = 512;

const tagged = (text, start, end, rank) => ({
  start,
  end,
  tag: maskTag(text.slice(start, end)),
  rank,
});

const sameWriting = ({ text, kinds }, at, other) =>
  text[at] === text[other] && kinds?.[at] === kinds?.[other];

// Documented credential formats, shown in their masked form.
const credentialSpans = ({ text }) => {
  const spans = [];
  for (const { value, masked } of new Map(
    credentialsIn(text).map((found) => [found.value, found]),
  ).values())
    for (
      let at = text.indexOf(value);
      at !== -1;
      at = text.indexOf(value, at + value.length)
    )
      spans.push({
        start: at,
        end: at + value.length,
        tag: masked,
        rank: "credential",
      });
  return spans;
};

// User info, token segments, query values and fragments of every URL, with
// the tags urls.mjs gives the same parts of a claim.
const urlSpans = ({ text }, runs) =>
  runs.flatMap((run) =>
    runSpans(text, run).map((part) => ({ ...part, rank: "url" })),
  );

const WORD = /[A-Za-z0-9_+/.-]/;
const RANDOM = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{8,64}$/;

// Hosts stay readable, as they do in claims; a single label such as
// `//FAKEtoken…` after a comment marker is not a host.
const hostCharacters = (text, runs) => {
  const hosts = new Uint8Array(text.length);
  for (const { host } of runs)
    if (host !== null && /[.:[]/.test(text.slice(host.start, host.end)))
      hosts.fill(1, host.start, host.end);
  return hosts;
};

// The token parts of one '/'-separated segment of a word, as urls.mjs
// decides for a path: a dotted segment keeps its readable parts.
const segmentTokens = (segments, index, offset) => {
  const segment = segments[index];
  if (!isTokenSegment(segment, segments[index + 1])) return [];
  if (!segment.includes(".")) return [[offset, offset + segment.length]];
  const parts = [];
  let at = offset;
  for (const part of segment.split(".")) {
    if (hasTokenRun(part)) parts.push([at, at + part.length]);
    at += part.length + 1;
  }
  return parts;
};

// Base64 with '/' is one value: it has '+' or '=' padding, or a short
// random-looking piece beside a token-like one.
const isBase64 = (word, segments) =>
  !word.includes(".") &&
  hasTokenRun(word.replaceAll("/", "")) &&
  (/\+|=$/.test(word) ||
    segments.some((segment) => RANDOM.test(segment) && !hasTokenRun(segment)));

// The ranges to mask in one run of word characters.
const wordTokens = (word) => {
  const segments = word.split("/");
  if (isBase64(word, segments)) return [[0, word.length]];
  const ranges = [];
  let offset = 0;
  for (let index = 0; index < segments.length; index += 1) {
    ranges.push(...segmentTokens(segments, index, offset));
    offset += segments[index].length + 1;
  }
  return ranges;
};

// Long token-like runs anywhere: code, strings and comments alike. '/'
// separates path segments, so a readable path stays readable.
const wordSpans = ({ text }, runs) => {
  const hosts = hostCharacters(text, runs);
  const word = (at) => !hosts[at] && WORD.test(text[at]);
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

const skipSpaces = (text, index, step) => {
  let at = index;
  while (Math.abs(at - index) < 16 && /[ \t]/.test(text[at] ?? "")) at += step;
  return at;
};

// The body of the quoted string opening at `open`: it closes at the same
// quote written the same way, or, unclosed, at the end of its first word.
const quotedBody = (view, open) => {
  const limit = Math.min(view.text.length, open + 1 + MAX_VALUE);
  for (let index = open + 1; index < limit; index += 1)
    if (sameWriting(view, index, open)) return { start: open + 1, end: index };
  let end = open + 1;
  while (end < limit && !/[\s,;)}\]]/.test(view.text[end])) end += 1;
  return { start: open + 1, end };
};

// A string concatenated after the one closing at `close`: `"…key=" + "v"`.
const concatenated = (view, close) => {
  const plus = skipSpaces(view.text, close + 1, 1);
  if (view.text[plus] !== "+") return null;
  const open = skipSpaces(view.text, plus + 1, 1);
  return QUOTES.includes(view.text[open] ?? "") ? quotedBody(view, open) : null;
};

const credentialShaped = (value) =>
  value.length >= 16 ||
  (value.length >= 6 &&
    (/[\d+/=_.~-]/.test(value) ||
      (/[a-z]/.test(value) && /[A-Z]/.test(value))));

// Bearer, Basic and Token values, also in a concatenated string.
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
  return spans;
};

const CREDENTIAL_WORDS =
  /key|token|secret|auth|pass|pwd|signature|credential|subscription|session|cookie/i;
const NAME = /[A-Za-z0-9_$-]/;

// The credential-like name that ends just before a separator, quoted or
// not: `{ start, quoted, opener }`, `opener` being the character before it.
const nameBefore = (view, separator) => {
  const { text } = view;
  let index = skipSpaces(text, separator - 1, -1);
  const quote = QUOTES.includes(text[index] ?? "") ? index : -1;
  if (quote !== -1) index -= 1;
  const end = index + 1;
  while (index >= 0 && end - index <= 64 && NAME.test(text[index])) index -= 1;
  const name = text.slice(index + 1, end);
  if (NAME.test(text[index] ?? "") || !CREDENTIAL_WORDS.test(name)) return null;
  if (quote === -1)
    return { start: index + 1, quoted: false, opener: text[index] ?? "" };
  return sameWriting(view, index, quote)
    ? { start: index, quoted: true, opener: text[index - 1] ?? "" }
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

// The value after `name=`: quoted, a query or form pair, or a string
// concatenated after the one the pair ends.
const equalsValue = (view, separator, name) => {
  const start = skipSpaces(view.text, separator + 1, 1);
  const pair =
    start === separator + 1 &&
    (/[?&;"'`]/.test(name.opener) || name.start === 0);
  if (!QUOTES.includes(view.text[start] ?? ""))
    return pair ? pairValue(view.text, start) : null;
  return pair && !name.quoted
    ? concatenated(view, start)
    : quotedBody(view, start);
};

// The value after `name:`: quoted, or the rest of a header line written in
// one string ("x-api-key: v").
const colonValue = (view, separator, name) => {
  const { text } = view;
  const start = skipSpaces(text, separator + 1, 1);
  if (QUOTES.includes(text[start] ?? "")) return quotedBody(view, start);
  if (name.quoted || !QUOTES.includes(name.opener)) return null;
  let end = start;
  while (
    end - start < MAX_VALUE &&
    end < text.length &&
    text[end] !== name.opener
  )
    end += 1;
  return text[end] === name.opener ? { start, end } : pairValue(text, start);
};

// The value after `("name", `: a call or array argument.
const commaValue = (view, separator, name) => {
  if (!name.quoted) return null;
  const before = skipSpaces(view.text, name.start - 1, -1);
  const start = skipSpaces(view.text, separator + 1, 1);
  return "([".includes(view.text[before] ?? "") &&
    QUOTES.includes(view.text[start] ?? "")
    ? quotedBody(view, start)
    : null;
};

const SEPARATORS = { ":": colonValue, "=": equalsValue, ",": commaValue };

// Values written after a credential-like name: `name: "v"`, `"name":"v"`,
// `name="v"`, `?name=v`, `("name", "v")`. Code that reads a secret, such as
// `apiKey: process.env.KEY`, writes no value, and "Bearer " before a
// concatenated variable is no secret.
const fieldSpans = (view) => {
  const spans = [];
  for (let index = 0; index < view.text.length; index += 1) {
    const valueOf = SEPARATORS[view.text[index]];
    if (valueOf === undefined || view.text[index + 1] === "=") continue;
    const name = nameBefore(view, index);
    const value = name === null ? null : valueOf(view, index, name);
    const written = value && view.text.slice(value.start, value.end);
    if (value && !/^\s*(?:(?:Bearer|Basic|Token)\s*)?$/i.test(written))
      spans.push(tagged(view.text, value.start, value.end, "quoted"));
  }
  return spans;
};

/**
 * Spans of secrets written anywhere in a text, in no order and possibly
 * overlapping: credential formats, the secret parts of `runs` (urls.mjs
 * urlRuns of the text), long token-like runs, JWTs, Bearer/Basic/Token
 * values and values written after a credential-like name. `rank` names
 * the rule: "url", "credential", "pattern", "quoted" (a value read up to a
 * quote) or "word".
 */
export const secretSpans = (view, runs) => [
  ...credentialSpans(view),
  ...urlSpans(view, runs),
  ...wordSpans(view, runs),
  ...jwtSpans(view),
  ...schemeSpans(view),
  ...fieldSpans(view),
];
