// URL helpers shared by facts, rules and reports. URLs here are values REA
// reported; parsing them with WHATWG URL reads no source.
import { createHash } from "node:crypto";

// An absolute URL in text, including a bracketed IPv6 host.
const URL_TEXT =
  /\b(?:https?|wss?):\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s"'`<>)\]}]*/gi;

/** True when a whole string is an absolute http(s) or ws(s) URL. */
export const isUrl = (value) =>
  typeof value === "string" && /^(https?|wss?):\/\/[^\s"'`]+$/i.test(value);

// Sentence punctuation after a URL in prose or a header value is not part of it.
const splitTail = (match) => /^(.*?)([.,;:!?]*)$/s.exec(match).slice(1);

/** Every absolute URL inside a text. */
export const urlsIn = (text) =>
  typeof text === "string"
    ? (text.match(URL_TEXT) ?? []).map((match) => splitTail(match)[0])
    : [];

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
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
  const trimmed = source.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
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

/**
 * A short tag that tells two masked values apart without revealing either.
 * Masking a masked value returns it unchanged, so a value scrubbed twice
 * keeps one tag.
 */
export const maskTag = (value) =>
  MASKED.test(String(value))
    ? String(value)
    : `‹${createHash("sha256").update(String(value)).digest("hex").slice(0, 4)}›`;

const decoded = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// Commit SHAs and content digests identify content; they are not secrets.
const DIGEST = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TOKEN_PART = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-+=~%]{20,}$/;
const EXTENSION = /^[A-Za-z0-9]{1,5}$/;

// A path segment that carries a token: a bot token, a JWT, or a long run of
// letters and digits, also between dots, other than a file extension.
const isTokenSegment = (segment) => {
  const value = decoded(segment);
  if (/^bot\d+:/.test(value) || /^eyJ[\w-]*\.[\w-]*\.?[\w-]*$/.test(value))
    return true;
  const parts = value.split(".");
  const named =
    parts.length > 1 && EXTENSION.test(parts.at(-1))
      ? parts.slice(0, -1)
      : parts;
  return named.some((part) => TOKEN_PART.test(part) && !DIGEST.test(part));
};

/** A path for display: token-like segments are masked. */
export const displayPath = (pathname) =>
  pathname
    .split("/")
    .map((segment) => (isTokenSegment(segment) ? maskTag(segment) : segment))
    .join("/");

// Masking by pattern, for text WHATWG URL cannot parse (a relative source,
// a template fragment): user info, query values and fragments.
const maskLoosely = (text) =>
  text
    .replace(/\/\/[^/@\s]*@/, "//")
    .replace(/([?&][^=&#\s]*=)([^&#\s"'`]*)/g, (_match, name, value) =>
      value === "" ? name : `${name}${maskTag(value)}`,
    )
    .replace(/#.+$/, "#…")
    .split("/")
    .map((segment) =>
      isTokenSegment(segment.split(/[?#]/)[0]) ? maskTag(segment) : segment,
    )
    .join("/");

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
    pathname !== parsed.pathname;
  if (!masked) return url;
  const query = [...parsed.searchParams].map(([name, value]) =>
    value === "" ? name : `${name}=${maskTag(value)}`,
  );
  return `${parsed.protocol}//${parsed.host}${pathname}${query.length ? `?${query.join("&")}` : ""}${parsed.hash === "" ? "" : "#…"}`;
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

/** Apply displayUrl to every URL inside a text. */
export const displayUrlsIn = (text) =>
  text.replace(URL_TEXT, (match) => {
    const [url, tail] = splitTail(match);
    return `${displayUrl(url)}${tail}`;
  });
