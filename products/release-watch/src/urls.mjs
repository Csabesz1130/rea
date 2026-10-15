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
 * A `<script src>` value as the browser resolves its host: surrounding ASCII
 * whitespace removed and protocol-relative sources read as https. Null for a
 * relative source.
 */
export const scriptSourceUrl = (source) => {
  if (typeof source !== "string") return null;
  // As a browser parses it: ASCII tab and newline removed anywhere, other
  // surrounding whitespace trimmed.
  const trimmed = source
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\f ]+|[\f ]+$/g, "");
  if (/^(data|blob|javascript):/i.test(trimmed)) return null;
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  return hostOf(absolute) === null ? null : absolute;
};

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

const MASKED = /^…?‹[0-9a-f]{4}›$/;
// A key made fresh for every run: equal values share a tag within a report,
// and a tag cannot be matched against guesses offline.
const RUN_KEY = randomBytes(32);

/**
 * A short tag that tells two masked values apart within one report without
 * revealing either. Masking a masked value returns it unchanged.
 */
export const maskTag = (value) =>
  MASKED.test(String(value))
    ? String(value)
    : `‹${createHmac("sha256", RUN_KEY).update(String(value)).digest("hex").slice(0, 4)}›`;

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

const decoded = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// A query name or value as URLSearchParams reads it: '+' is a space.
const queryValue = (raw) => new URLSearchParams(`v=${raw}`).get("v") ?? raw;

// Commit SHAs and content digests name content only when a static asset
// file follows them in the path; elsewhere a hex run may be a webhook secret.
const DIGEST = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATIC_ASSET =
  /\.(?:m?js|cjs|css|map|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/i;
// File types whose content-hashed names (name.<hash>.ext, name-<hash>.ext)
// keep the hash.
const HASHED_TYPE =
  /^(?:m?js|cjs|jsx|css|map|wasm|json|html?|txt|xml|webmanifest|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|mp3|mp4|webm|ogg|wav)$/i;
const CONTENT_HASH = /^[0-9a-f]{6,64}$/;
const EXTENSION = /^[A-Za-z0-9]{1,5}$/;
const TOKEN_RUN = /[A-Za-z0-9_\-+=~%]{20,}/g;
const JWT = /^eyJ[\w-]*\.[\w-]*(?:\.[\w-]*)?$/;

/** True when a text holds a run of 20 or more token characters mixing letters and digits. */
export const hasTokenRun = (text) =>
  (text.match(TOKEN_RUN) ?? []).some(
    (run) => /\d/.test(run) && /[A-Za-z]/.test(run),
  );

// The parts of a file name a token could hide in: a content hash in
// name.<hash>.ext or name-<hash>.ext identifies the content and is left out.
const nameParts = (value) => {
  const parts = value.split(".");
  const extension = parts.length > 1 ? parts.at(-1) : "";
  if (!EXTENSION.test(extension) && !HASHED_TYPE.test(extension)) return parts;
  const stem = parts.slice(0, -1);
  if (!HASHED_TYPE.test(extension)) return stem;
  return stem.map((part, index) =>
    index === 0
      ? part.replace(/(?<=.)-[0-9a-f]{6,64}$/, "")
      : CONTENT_HASH.test(part)
        ? ""
        : part,
  );
};

/**
 * A path segment that carries a token: a bot token, a JWT, a digest not
 * followed by a static asset file (`next`), or a long run of letters and
 * digits other than a content hash in an asset name.
 */
export const isTokenSegment = (segment, next) => {
  const value = decoded(segment);
  if (/^bot\d+:/.test(value) || JWT.test(value)) return true;
  if (DIGEST.test(value))
    return !(typeof next === "string" && STATIC_ASSET.test(decoded(next)));
  return nameParts(value).some(hasTokenRun);
};

/** A path for display: token-like segments are masked by their decoded value. */
export const displayPath = (pathname) => {
  const segments = pathname.split("/");
  return segments
    .map((segment, index) =>
      isTokenSegment(segment, segments[index + 1])
        ? maskTag(decoded(segment))
        : segment,
    )
    .join("/");
};

// URLs written in code or prose. Runs are found and split with linear scans
// so a long line costs one pass.
const ENDS_URL = /[\s"'`<>\\]/;
const BOUNDARY = /[\s"'`([=,}>]/;
const SCHEME_CHARACTER = /[A-Za-z0-9+.-]/;
const HOST_START = /[A-Za-z0-9[$]/;
const PATH_START = /[A-Za-z0-9_.~%$-]/;
const PATH_CHARACTER = /[A-Za-z0-9_.~%+/-]/;
const WEB_FILE =
  /\.(?:m?js|cjs|html?|php|aspx?|jsp|cgi|json|xml|txt|css|svg|png|gif|jpe?g|webp|ico|wasm|map)$/i;
const INTERPOLATION = 256;

// The index after a `${…}` template interpolation at `index`, or -1.
const interpolationEnd = (text, index) => {
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
const runEnd = (text, start) => {
  let index = start;
  while (index < text.length) {
    const after = interpolationEnd(text, index);
    if (after !== -1) {
      index = after;
      continue;
    }
    const character = text[index];
    if (ENDS_URL.test(character) || ")]}".includes(character)) break;
    if (",;".includes(character) && /^\s?$/.test(text[index + 1] ?? "")) break;
    index += 1;
  }
  return tailStart(text, start, index);
};

// `scheme://` runs found by their separator, so a scheme glued to other
// text still starts a URL.
const absoluteRuns = (text) => {
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
    const end = runEnd(text, marker + 3);
    runs.push({
      start: start === marker ? marker + 1 : start,
      end,
      authority: marker + 3,
    });
    from = Math.max(end, marker + 3);
  }
  return runs;
};

// A name with a query starting at `index`: sw.js?key=, api/v1?token=, and a
// bare name only after a quote, or after a space in prose.
const queriedNameAt = (text, index, prose) => {
  let end = index;
  while (
    end < text.length &&
    end - index < 512 &&
    PATH_CHARACTER.test(text[end])
  )
    end += 1;
  if (text[end] !== "?" || end === index) return false;
  const name = text.slice(index, end);
  const before = text[index - 1] ?? "";
  const bare = /["'`]/.test(before) || (prose && /^\s?$/.test(before));
  return name.includes("/") || WEB_FILE.test(name) || bare;
};

// A relative URL starting at `index`: its authority's index when it is
// protocol-relative, -1 for a path from `/`, `./` or `../` or a name with a
// query, and null for none.
const relativeAt = (text, index, prose) => {
  if (index > 0 && !BOUNDARY.test(text[index - 1])) return null;
  if (text.startsWith("//", index))
    return HOST_START.test(text[index + 2] ?? "") ? index + 2 : null;
  if (text[index] === "/")
    return PATH_START.test(text[index + 1] ?? "") ? -1 : null;
  if (text.startsWith("./", index) || text.startsWith("../", index)) return -1;
  return queriedNameAt(text, index, prose) ? -1 : null;
};

const relativeRuns = (text, absolute, prose) => {
  const runs = [];
  let taken = 0;
  for (let index = 0; index < text.length;) {
    const next = absolute[taken];
    if (next !== undefined && index >= next.start) {
      index = Math.max(index, next.end);
      taken += 1;
      continue;
    }
    const authority = relativeAt(text, index, prose);
    const end =
      authority === null
        ? index
        : Math.min(runEnd(text, index), next?.start ?? text.length);
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
 * end, authority, host }`. `prose` also reads a bare name with a query after
 * a space as a URL, as in a header value.
 */
export const urlRuns = (text, prose = false) => {
  const absolute = absoluteRuns(text);
  return [...absolute, ...relativeRuns(text, absolute, prose)]
    .sort((a, b) => a.start - b.start)
    .map((run) => ({ ...run, host: hostRange(text, run) }));
};

const segmentSpans = (text, from, to) => {
  const segments = [];
  for (let index = from; index <= to;) {
    const slash = indexOfAny(text, "/", index, to);
    segments.push({ start: index, end: slash });
    index = slash + 1;
  }
  return segments.flatMap((segment, position) => {
    const value = text.slice(segment.start, segment.end);
    const next = segments[position + 1];
    return isTokenSegment(value, next && text.slice(next.start, next.end))
      ? [{ ...segment, tag: maskTag(decoded(value)) }]
      : [];
  });
};

// A query value's literal parts, split around template interpolations,
// each tagged by its decoded value.
const valueSpans = (text, from, to) => {
  const spans = [];
  const literal = (start, end) => ({
    start,
    end,
    tag: maskTag(queryValue(text.slice(start, end))),
  });
  let chunk = from;
  for (let index = from; index < to;) {
    const after = interpolationEnd(text, index);
    if (after === -1 || after > to) {
      index += 1;
      continue;
    }
    if (index > chunk) spans.push(literal(chunk, index));
    index = after;
    chunk = after;
  }
  if (to > chunk) spans.push(literal(chunk, to));
  return spans;
};

const querySpans = (text, from, to) => {
  const spans = [];
  for (let index = from; index < to;) {
    const pair = indexOfAny(text, "&", index, to);
    const equals = indexOfAny(text, "=", index, pair);
    if (
      (equals === pair || equals + 1 === pair) &&
      hasTokenRun(text.slice(index, equals))
    )
      spans.push({
        start: index,
        end: equals,
        tag: maskTag(queryValue(text.slice(index, equals))),
      });
    if (equals < pair) spans.push(...valueSpans(text, equals + 1, pair));
    index = pair + 1;
  }
  return spans;
};

/**
 * The secret parts of one URL run, as `{ start, end, tag }` in order: user
 * info, token-like path segments, query values (and token-like names
 * without one) and the fragment, which shows as "…".
 */
export const runSpans = (text, run) => {
  const spans = [];
  if (run.host !== null && run.host.start > run.authority)
    spans.push({
      start: run.authority,
      end: run.host.start - 1,
      tag: maskTag(text.slice(run.authority, run.host.start - 1)),
    });
  const pathStart = run.host?.end ?? run.start;
  const query = indexOfAny(text, "?#", pathStart, run.end);
  spans.push(...segmentSpans(text, pathStart, query));
  const fragment =
    text[query] === "?" ? indexOfAny(text, "#", query, run.end) : query;
  if (text[query] === "?") spans.push(...querySpans(text, query + 1, fragment));
  if (fragment + 1 < run.end)
    spans.push({ start: fragment + 1, end: run.end, tag: "…" });
  return spans;
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
export const maskUrlsIn = (text, prose = false) =>
  replaceSpans(
    text,
    urlRuns(text, prose).flatMap((run) => runSpans(text, run)),
  );

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

// A parsed query for display: names decoded as URLSearchParams reads them,
// each value as a tag of its decoded form, a token-like name without a
// value masked, and a pair written as `name=` kept so.
const displayQuery = (search) => {
  const pairs = search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const name = queryValue(equals === -1 ? pair : pair.slice(0, equals));
      const value = equals === -1 ? "" : pair.slice(equals + 1);
      if (value !== "") return `${visible(name)}=${maskTag(queryValue(value))}`;
      const shown = hasTokenRun(name) ? maskTag(name) : visible(name);
      return equals === -1 ? shown : `${shown}=`;
    });
  return pairs.length ? `?${pairs.join("&")}` : "";
};

/**
 * A URL for display: user info is dropped, query values, fragments and
 * token-like path segments are masked, so credentials in URLs never reach a
 * report. A URL with nothing to mask is returned exactly as given; one WHATWG
 * cannot parse is masked by pattern instead of passed through.
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
