// URL helpers shared by facts, rules and reports. URLs here are values REA
// reported; parsing them with WHATWG URL reads no source. This module also
// owns which parts of a URL written in text are secret, so claims, header
// values and source lines mask the same parts with the same tags.
import { createHmac, randomBytes } from "node:crypto";

// An absolute URL in text, including a bracketed IPv6 host.
const URL_TEXT =
  /\b(?:https?|wss?):\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s"'`<>)\]}]*/gi;

/** True when a whole string is an absolute http(s) or ws(s) URL. */
export const isUrl = (value) =>
  typeof value === "string" && /^(https?|wss?):\/\/[^\s"'`]+$/i.test(value);

// Sentence punctuation after a URL in prose or a header value is not part of it.
const tailStart = (text, start, end) => {
  let index = end;
  while (index > start && ".,;:!?".includes(text[index - 1])) index -= 1;
  return index;
};
const splitTail = (match) => {
  const end = tailStart(match, 0, match.length);
  return [match.slice(0, end), match.slice(end)];
};

/** Every absolute URL inside a text. */
export const urlsIn = (text) =>
  typeof text === "string"
    ? (text.match(URL_TEXT) ?? []).map((match) => splitTail(match)[0])
    : [];

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

/**
 * A `<script src>` value as the browser resolves its host: ASCII tab and
 * newline removed anywhere, C0 controls and spaces trimmed at both ends, and
 * a source starting with two or more slashes or backslashes (`//host`,
 * `\\host`, `/\host`) read as protocol-relative https, as WHATWG URL reads
 * it against an https page. Null for a relative source.
 */
export const scriptSourceUrl = (source) => {
  if (typeof source !== "string") return null;
  const trimmed = source
    .replace(/[\t\n\r]/g, "")
    // oxlint-disable-next-line no-control-regex -- the URL parser trims C0 controls.
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  if (/^(data|blob|javascript):/i.test(trimmed)) return null;
  const slashes = /^[\\/]{2,}/.exec(trimmed)?.[0].length ?? 0;
  const absolute = slashes > 0 ? `https://${trimmed.slice(slashes)}` : trimmed;
  return hostOf(absolute) === null ? null : absolute;
};

/** True for a `<script src>` whose code is embedded in the URL (data:, javascript:). */
export const isEmbeddedScript = (source) =>
  typeof source === "string" &&
  // oxlint-disable-next-line no-control-regex -- the URL parser trims C0 controls.
  /^[\u0000- ]*(data|javascript):/i.test(source.replace(/[\t\n\r]/g, ""));

/** The host of a `<script src>` value, or null for a relative source. */
export const scriptHostOf = (source) => hostOf(scriptSourceUrl(source));

/** The URL scheme, lowercased, or null. */
export const schemeOf = (url) => {
  try {
    return new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return null;
  }
};

const TAGS = /‹[0-9a-f]{6,64}›/g;
const MASKED = /^…?‹[0-9a-f]{6,64}›$/;
// A key made fresh for every run: equal values share a tag within a report,
// and a tag cannot be matched against guesses offline.
const RUN_KEY = randomBytes(32);
// The value each tag of this run stands for. A tag is six hex digits of the
// value's keyed digest, two more each time another value already holds it,
// so equal values always share a tag and different values never do.
const issued = new Map();
const tagOf = (text) => {
  const digest = createHmac("sha256", RUN_KEY).update(text).digest("hex");
  for (let width = 6; width < digest.length; width += 2) {
    const tag = `‹${digest.slice(0, width)}›`;
    const holder = issued.get(tag);
    if (holder === undefined) issued.set(tag, text);
    if (holder === undefined || holder === text) return tag;
  }
  return `‹${digest}›`;
};

/**
 * A short tag that tells two masked values apart within one report without
 * revealing either. Tags already in a value are atomic: only the text
 * around them is tagged, so masking a masked text returns it unchanged.
 */
export const maskTag = (value) => {
  const text = String(value);
  if (MASKED.test(text)) return text;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(TAGS)) {
    if (match.index > cursor) result += tagOf(text.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return cursor === 0 || cursor < text.length
    ? result + tagOf(text.slice(cursor))
    : result;
};

/** C0 and C1 controls, line and paragraph separators, and bidirectional controls. */
export const CONTROL =
  // oxlint-disable-next-line no-control-regex -- matching control characters is this expression's purpose.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
// The same set with tab and line breaks, which a decoded URL never shows either.
const UNDECODABLE_SET = `[\\t\\n\\r${CONTROL.source.slice(1, -1)}]`;
const UNDECODABLE = new RegExp(UNDECODABLE_SET);
const UNDECODABLE_ALL = new RegExp(UNDECODABLE_SET, "g");

// Text decoded from a URL for display, with controls kept percent-encoded.
const visible = (text) =>
  text.replace(UNDECODABLE_ALL, (character) => encodeURIComponent(character));

// A parsed path as written: percent-encoding of characters such as { } and
// of mask tags undone for display, but never into a control.
const readable = (pathname) => {
  try {
    return visible(decodeURI(pathname));
  } catch {
    return pathname;
  }
};

// A URL part as the URL parser keeps it: ASCII tab and line breaks, which
// it drops anywhere, removed, then percent-decoding undone.
const decoded = (segment) => {
  const kept = segment.replace(/[\t\n\r]/g, "");
  try {
    return decodeURIComponent(kept);
  } catch {
    return kept;
  }
};

// A query name or value as URLSearchParams reads it: '+' is a space.
const queryValue = (raw) => {
  const kept = raw.replace(/[\t\n\r]/g, "");
  return new URLSearchParams(`v=${kept}`).get("v") ?? kept;
};

// Commit SHAs and content digests name content only when a static asset
// file follows them in the path; elsewhere a hex run may be a webhook secret.
const DIGEST = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATIC_ASSET =
  /\.(?:m?js|cjs|css|map|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/i;
// File types whose content-hashed names (name.<hash>.ext, name-<hash>.ext,
// name_<hash>.ext) keep the hash.
const HASHED_TYPE =
  /^(?:m?js|cjs|jsx|css|map|wasm|json|html?|txt|xml|webmanifest|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|mp3|mp4|webm|ogg|wav)$/i;
const HEX_HASH = "(?:[0-9a-f]{6,64}|[0-9A-F]{6,64})";
const CONTENT_HASH = new RegExp(`^${HEX_HASH}$`);
const HASH_SUFFIX = new RegExp(`(?<=.)[-_]${HEX_HASH}$`);
const EXTENSION = /^[A-Za-z0-9]{1,5}$/;
const JWT = /^eyJ[\w-]*\.[\w-]*(?:\.[\w-]*)?$/;

// Random-looking runs: 20 or more token characters, split into chunks at
// separators and each chunk into pieces at case changes and letter/digit
// boundaries. A chunk made of word-like pieces (sendAnalyticsEventV2Async,
// route-53, claude-3-5-sonnet-20241022) reads as a name; hex, UUIDs, chunks
// of short alternating pieces (base62, base64), four or more letter/digit
// switches, and 12 capitals or 10 digits run together beside other
// characters read as tokens.
const TOKEN_RUN = /[A-Za-z0-9_\-+=~%]{20,}/g;
const CHUNKS = /[^_\-+=~%]+/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX_CHUNK =
  /^(?=.*\d)(?:(?=.*[a-f])[0-9a-f]{16,}|(?=.*[A-F])[0-9A-F]{16,})$/;
const PIECES = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

const randomChunk = (chunk) => {
  if (chunk.length < 8) return false;
  if (HEX_CHUNK.test(chunk)) return true;
  const pieces = chunk.match(PIECES) ?? [];
  let switches = 0;
  for (let index = 1; index < pieces.length; index += 1)
    if (/\d/.test(pieces[index][0]) !== /\d/.test(pieces[index - 1][0]))
      switches += 1;
  return (
    switches >= 4 ||
    2 * chunk.length < 5 * pieces.length ||
    (/\d/.test(chunk) && pieces.some((piece) => /^[A-Z]{12,}$/.test(piece))) ||
    (/[A-Za-z]/.test(chunk) && pieces.some((piece) => /^\d{10,}$/.test(piece)))
  );
};

/** True when a text holds a random-looking run of 20 or more token characters. */
export const hasRandomRun = (text) =>
  (text.match(TOKEN_RUN) ?? []).some(
    (run) => UUID.test(run) || (run.match(CHUNKS) ?? []).some(randomChunk),
  );

// The parts of a file name a token could hide in: a content hash in
// name.<hash>.ext, name-<hash>.ext or name_<hash>.ext identifies the content
// and is left out, as is a static asset named only by its hash (<hash>.js).
const nameParts = (value) => {
  const parts = value.split(".");
  const extension = parts.length > 1 ? parts.at(-1) : "";
  if (!EXTENSION.test(extension) && !HASHED_TYPE.test(extension)) return parts;
  const stem = parts.slice(0, -1);
  if (!HASHED_TYPE.test(extension)) return stem;
  const asset = STATIC_ASSET.test(value);
  return stem.map((part, index) =>
    (index > 0 || asset) && CONTENT_HASH.test(part)
      ? ""
      : part.replace(HASH_SUFFIX, ""),
  );
};

/**
 * A path segment that carries a token: a bot token, a JWT, a digest not
 * followed by a static asset file (`next`), or a random-looking run other
 * than a content hash in an asset name.
 */
export const isTokenSegment = (segment, next) => {
  const value = decoded(segment);
  if (/^bot\d+:/.test(value) || JWT.test(value)) return true;
  if (DIGEST.test(value))
    return !(typeof next === "string" && STATIC_ASSET.test(decoded(next)));
  return nameParts(value).some(hasRandomRun);
};

// URLs written in code or prose. Runs are found and split with linear scans
// so a long line costs one pass. A text is read in one of three modes:
// "code" (a source line), "markup" (a line of an HTML-like file, where
// unquoted attribute values hold URLs and the URL parser drops tabs and
// line breaks inside them) or "prose" (a claim or header value, where a
// bare name or path after a space is a URL).
const ENDS_URL = /[\s"'`<>\\]/;
const ENDS_MARKUP_URL = /[ \f"'`<>\\]/;
const BOUNDARY = /[\s"'`([=,}>:{]/;
const QUOTE = /["'`]/;
const SCHEME_CHARACTER = /[A-Za-z0-9+.-]/;
const HOST_START = /[A-Za-z0-9[$]/;
const PATH_START = /[A-Za-z0-9_.~%$-]/;
const PATH_CHARACTER = /[A-Za-z0-9_.~%+/-]/;
const WEB_FILE =
  /\.(?:m?js|cjs|html?|php|aspx?|jsp|cgi|json|xml|txt|css|svg|png|gif|jpe?g|webp|ico|wasm|map)$/i;
const INTERPOLATION = 256;
// At most this many query pairs per URL are tagged one by one; the rest of
// the query is one tag.
const MAX_PAIRS = 64;

// The index after a `${…}` template interpolation at `index`, or -1.
export const interpolationEnd = (text, index) => {
  if (text[index] !== "$" || text[index + 1] !== "{") return -1;
  let depth = 0;
  const limit = Math.min(text.length, index + INTERPOLATION);
  for (let at = index + 1; at < limit; at += 1) {
    if (text[at] === "{") depth += 1;
    else if (text[at] === "}" && --depth === 0) return at + 1;
  }
  return -1;
};

// The first of `characters` in [from, to) outside interpolations, or `to`.
const indexOfAny = (text, characters, from, to) => {
  let index = from;
  while (index < to && !characters.includes(text[index])) {
    const after = interpolationEnd(text, index);
    index = after === -1 ? index + 1 : after;
  }
  return Math.min(index, to);
};

// Where a URL run starting at `start` ends: at a quote, space, angle
// bracket, backslash or closing bracket, or at `,` or `;` before a space.
// In a quoted markup attribute (`opened` by the quote before the run), tabs
// and line breaks do not end it: the URL parser drops them.
const runEnd = (text, start, { mode, opened }) => {
  const ends =
    mode === "markup" && QUOTE.test(opened ?? "") ? ENDS_MARKUP_URL : ENDS_URL;
  let index = start;
  while (index < text.length) {
    const after = interpolationEnd(text, index);
    if (after !== -1) {
      index = after;
      continue;
    }
    const character = text[index];
    if (ends.test(character) || ")]}".includes(character)) break;
    if (",;".includes(character) && /^\s?$/.test(text[index + 1] ?? "")) break;
    index += 1;
  }
  return tailStart(text, start, index);
};

// `scheme://` runs found by their separator, so a scheme glued to other
// text still starts a URL.
const absoluteRuns = (text, mode) => {
  const runs = [];
  let from = 0;
  for (
    let marker = text.indexOf("://");
    marker !== -1;
    marker = text.indexOf("://", from)
  ) {
    let start = marker;
    while (
      start > from &&
      marker - start < 32 &&
      SCHEME_CHARACTER.test(text[start - 1])
    )
      start -= 1;
    while (start < marker && !/[A-Za-z]/.test(text[start])) start += 1;
    const end = runEnd(text, marker + 3, { mode, opened: text[start - 1] });
    runs.push({
      start: start === marker ? marker + 1 : start,
      end,
      authority: marker + 3,
    });
    from = Math.max(end, marker + 3);
  }
  return runs;
};

// Whether a name that is no path from `/` starts a URL in this context: in
// code only inside a string, so `r=n/2?t=1:e` stays a ternary; in markup
// also as an unquoted attribute value; in prose after a space too.
const nameContext = (before, name, mode) => {
  if (before === "" || QUOTE.test(before) || before === "}") return true;
  if (mode === "markup") return before === "=";
  if (mode !== "prose") return false;
  return /\s/.test(before) || name.includes("/") || WEB_FILE.test(name);
};

// A name starting at `index` that a query, fragment or path parameter
// follows (sw.js?key=, api/v1?token=, sw.js#token=, csp-report;jsessionid=),
// or, in prose, a path without a leading slash (csp/r/<token>).
const namedAt = (text, index, mode) => {
  let end = index;
  while (
    end < text.length &&
    end - index < 512 &&
    PATH_CHARACTER.test(text[end])
  )
    end += 1;
  if (end === index) return false;
  const name = text.slice(index, end);
  if (!nameContext(text[index - 1] ?? "", name, mode)) return false;
  const after = text.slice(end, end + 66);
  if (/^[?#][^\s"'`]/.test(after) || /^;[\w.~-]{1,64}=/.test(after))
    return true;
  return mode === "prose" && /^[A-Za-z0-9_.~%-]+\/[^/]/.test(name);
};

// A relative URL starting at `index`: its authority's index when it is
// protocol-relative, -1 for a path from `/`, `./` or `../`, a bare query
// (`?token=`) or a named one, and null for none.
const relativeAt = (text, index, mode) => {
  if (index > 0 && !BOUNDARY.test(text[index - 1])) return null;
  if (text.startsWith("//", index))
    return HOST_START.test(text[index + 2] ?? "") ? index + 2 : null;
  if (text[index] === "/")
    return PATH_START.test(text[index + 1] ?? "") ? -1 : null;
  if (text.startsWith("./", index) || text.startsWith("../", index)) return -1;
  if (text[index] === "?")
    return /^\?[\w.~%-]{1,64}=/.test(text.slice(index, index + 66)) &&
      nameContext(text[index - 1] ?? "", "", mode)
      ? -1
      : null;
  return namedAt(text, index, mode) ? -1 : null;
};

const relativeRuns = (text, absolute, mode) => {
  const runs = [];
  let taken = 0;
  for (let index = 0; index < text.length;) {
    const next = absolute[taken];
    if (next !== undefined && index >= next.start) {
      index = Math.max(index, next.end);
      taken += 1;
      continue;
    }
    const authority = relativeAt(text, index, mode);
    const end =
      authority === null
        ? index
        : Math.min(
            runEnd(text, index, { mode, opened: text[index - 1] }),
            next?.start ?? text.length,
          );
    if (end > index) runs.push({ start: index, end, authority });
    index = Math.max(index + 1, end);
  }
  return runs;
};

// The host of a run, after any user info: `{ start, end }`, or null.
const hostRange = (text, run) => {
  if (run.authority < 0) return null;
  const end = indexOfAny(text, "/?#", run.authority, run.end);
  let start = run.authority;
  for (let index = start; index < end; index += 1)
    if (text[index] === "@") start = index + 1;
  return { start, end };
};

/**
 * Every URL written in a text, absolute or relative, in order: `{ start,
 * end, authority, host }`. `mode` is "code", "markup" or "prose".
 */
export const urlRuns = (text, mode = "code") => {
  const absolute = absoluteRuns(text, mode);
  return [...absolute, ...relativeRuns(text, absolute, mode)]
    .sort((a, b) => a.start - b.start)
    .map((run) => ({ ...run, host: hostRange(text, run) }));
};

/**
 * For each character of a text, the URL run (its index + 1, else 0) whose
 * parts these rules mask; a single label after `//`, such as `//FAKEtoken…`
 * after a comment marker, is no host and is left to other rules.
 */
export const urlOwned = (text, runs) => {
  const owned = new Int32Array(text.length);
  for (const [index, run] of runs.entries()) {
    owned.fill(index + 1, run.start, run.end);
    const host = run.host && text.slice(run.host.start, run.host.end);
    if (host !== null && !/[.:[]/.test(host))
      owned.fill(0, run.host.start, run.host.end);
  }
  return owned;
};

/**
 * Whether these rules mask a value starting at `start` of a text view
 * `{ text, runs, owned }`: one inside a URL run, or a whole URL with a
 * scheme, whose host and path stay readable.
 */
export const urlMasks = ({ text, runs, owned }, start) => {
  const run = runs?.[(owned?.[start] ?? 0) - 1];
  return (
    run !== undefined &&
    (run.start < start || (run.authority >= 0 && text[run.start] !== "/"))
  );
};

/** The non-empty literal parts of [start, end) around `${…}` interpolations, as `{ start, end }`. */
export const literalParts = (text, start, end) => {
  const parts = [];
  let chunk = start;
  for (let index = start; index < end;) {
    const after = interpolationEnd(text, index);
    if (after === -1 || after > end) {
      index += 1;
      continue;
    }
    if (index > chunk) parts.push({ start: chunk, end: index });
    index = after;
    chunk = after;
  }
  if (end > chunk) parts.push({ start: chunk, end });
  return parts;
};

// A value's literal parts, each tagged by its form after `decode`.
const valueSpans = (text, [from, to], decode, sink) => {
  for (const { start, end } of literalParts(text, from, to))
    sink.push({ start, end, tag: maskTag(decode(text.slice(start, end))) });
};

// One path segment: the segment when it carries a token, and the value of
// each path parameter (`;jsessionid=…`, `;token=…`).
const segmentSpans = (text, [start, end], next, sink) => {
  const parameters = indexOfAny(text, ";", start, end);
  const name = text.slice(start, parameters);
  if (isTokenSegment(name, next))
    sink.push({ start, end: parameters, tag: maskTag(decoded(name)) });
  for (let index = parameters + 1; index < end;) {
    const parameter = indexOfAny(text, ";", index, end);
    const equals = indexOfAny(text, "=", index, parameter);
    if (equals + 1 < parameter)
      valueSpans(text, [equals + 1, parameter], decoded, sink);
    else if (hasRandomRun(text.slice(index, equals)))
      sink.push({
        start: index,
        end: equals,
        tag: maskTag(decoded(text.slice(index, equals))),
      });
    index = parameter + 1;
  }
};

const pathSpans = (text, from, to, sink) => {
  for (let index = from; index <= to;) {
    const slash = indexOfAny(text, "/", index, to);
    const next = slash < to ? indexOfAny(text, "/", slash + 1, to) : -1;
    segmentSpans(
      text,
      [index, slash],
      next === -1 ? undefined : text.slice(slash + 1, next),
      sink,
    );
    index = slash + 1;
  }
};

// The rest of an over-long query, as one tag in text and in claims alike.
const restTag = (rest) => maskTag(decoded(rest));

const querySpans = (text, from, to, sink) => {
  for (let index = from, count = 0; index < to; count += 1) {
    if (count === MAX_PAIRS) {
      sink.push({ start: index, end: to, tag: restTag(text.slice(index, to)) });
      return;
    }
    const pair = indexOfAny(text, "&", index, to);
    const equals = indexOfAny(text, "=", index, pair);
    if (
      (equals === pair || equals + 1 === pair) &&
      hasRandomRun(text.slice(index, equals))
    )
      sink.push({
        start: index,
        end: equals,
        tag: maskTag(queryValue(text.slice(index, equals))),
      });
    if (equals < pair) valueSpans(text, [equals + 1, pair], queryValue, sink);
    index = pair + 1;
  }
};

/**
 * The secret parts of one URL run, as `{ start, end, tag }` in order, added
 * to `sink`: user info, token-like path segments and path parameter values,
 * query values (and token-like names without one) and the fragment, which
 * shows as "…".
 */
export const runSpans = (text, run, sink = []) => {
  if (run.host !== null && run.host.start > run.authority)
    sink.push({
      start: run.authority,
      end: run.host.start - 1,
      tag: maskTag(decoded(text.slice(run.authority, run.host.start - 1))),
    });
  const pathStart = run.host?.end ?? run.start;
  const query = indexOfAny(text, "?#", pathStart, run.end);
  pathSpans(text, pathStart, query, sink);
  const fragment =
    text[query] === "?" ? indexOfAny(text, "#", query, run.end) : query;
  if (text[query] === "?") querySpans(text, query + 1, fragment, sink);
  if (fragment + 1 < run.end)
    sink.push({ start: fragment + 1, end: run.end, tag: "…" });
  return sink;
};

/** A text with each `{ start, end, tag }` span, in order and disjoint, replaced by its tag. */
export const replaceSpans = (text, spans) => {
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start) + span.tag;
    cursor = span.end;
  }
  return result + text.slice(cursor);
};

/** Every URL in a text masked by pattern: relative ones, other schemes, template literals. */
export const maskUrlsIn = (text, mode = "code") => {
  const spans = [];
  for (const run of urlRuns(text, mode)) runSpans(text, run, spans);
  return replaceSpans(text, spans);
};

// Masking by pattern, for one URL WHATWG URL cannot parse (a relative
// source, a template fragment).
export const maskLoosely = (text) => {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\//.exec(text);
  const authority = scheme ? scheme[0].length : text.startsWith("//") ? 2 : -1;
  const run = { start: 0, end: text.length, authority };
  return replaceSpans(
    text,
    runSpans(text, { ...run, host: hostRange(text, run) }),
  );
};

/** A path for display: token-like segments and path parameter values are masked by their decoded value. */
export const displayPath = (pathname) => {
  const spans = [];
  pathSpans(pathname, 0, pathname.length, spans);
  return replaceSpans(pathname, spans);
};

// A parsed query for display: names decoded as URLSearchParams reads them,
// each value as a tag of its decoded form, a token-like name without a
// value masked, a pair written as `name=` kept so, and the pairs after
// MAX_PAIRS as one tag.
const displayQuery = (search) => {
  const written = search.slice(1).split("&");
  const pairs = written
    .slice(0, MAX_PAIRS)
    .filter((pair) => pair !== "")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const name = queryValue(equals === -1 ? pair : pair.slice(0, equals));
      const value = equals === -1 ? "" : pair.slice(equals + 1);
      if (value !== "") return `${visible(name)}=${maskTag(queryValue(value))}`;
      const shown = hasRandomRun(name) ? maskTag(name) : visible(name);
      return equals === -1 ? shown : `${shown}=`;
    });
  if (written.length > MAX_PAIRS)
    pairs.push(restTag(written.slice(MAX_PAIRS).join("&")));
  return pairs.length ? `?${pairs.join("&")}` : "";
};

/**
 * A URL for display: user info is dropped, query values, fragments,
 * token-like path segments and path parameter values are masked, so
 * credentials in URLs never reach a report. A URL with nothing to mask is
 * returned exactly as given; one WHATWG cannot parse is masked by pattern
 * instead of passed through.
 */
export const displayUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return maskLoosely(url);
  }
  const pathname = displayPath(parsed.pathname);
  const masked =
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    pathname !== parsed.pathname ||
    UNDECODABLE.test(url);
  if (!masked) return url;
  return `${parsed.protocol}//${parsed.host}${readable(pathname)}${displayQuery(parsed.search)}${parsed.hash === "" ? "" : "#…"}`;
};

/** A script source as a comparison key: absolute sources normalized as a browser would, relative ones trimmed. */
export const scriptKey = (source) => {
  const absolute = scriptSourceUrl(source);
  return absolute === null ? String(source).trim() : new URL(absolute).href;
};

/** A `<script src>` value for display, relative or absolute. */
export const displayScript = (source) => {
  const absolute = scriptSourceUrl(source);
  return absolute === null
    ? maskLoosely(String(source).trim())
    : displayUrl(absolute);
};

/**
 * Apply displayUrl to every URL inside a text. A template literal's URL
 * (`https://${host}/…`) is no URL WHATWG can parse faithfully; maskUrlsIn
 * masks it by pattern.
 */
export const displayUrlsIn = (text) =>
  text.replace(URL_TEXT, (match) => {
    if (match.includes("${")) return match;
    const [url, tail] = splitTail(match);
    return `${displayUrl(url)}${tail}`;
  });
