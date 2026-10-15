// URL helpers shared by facts, rules and reports. URLs here are values REA
// reported; parsing them with WHATWG URL reads no source.

const URL_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>)\]}]+/gi;

/** True when a whole string is an absolute http(s) or ws(s) URL. */
export const isUrl = (value) =>
  typeof value === "string" && /^(https?|wss?):\/\/[^\s"'`]+$/i.test(value);

/** Every absolute URL inside a text. */
export const urlsIn = (text) =>
  typeof text === "string" ? (text.match(URL_TEXT) ?? []) : [];

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The host of a `<script src>` value; protocol-relative sources count as https. */
export const scriptHostOf = (source) =>
  typeof source === "string"
    ? hostOf(source.startsWith("//") ? `https:${source}` : source)
    : null;

/** The URL scheme, lowercased, or null. */
export const schemeOf = (url) => {
  try {
    return new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return null;
  }
};

// A path segment that looks like a token: long, no dots (so file names stay),
// and mixing letters with digits.
const TOKEN_SEGMENT = /^(?=[^.]*\d)(?=[^.]*[A-Za-z])[^./]{20,}$/;

/** A path for display: token-like segments become "…". */
const decoded = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const displayPath = (pathname) =>
  pathname
    .split("/")
    .map((segment) =>
      TOKEN_SEGMENT.test(decoded(segment)) || /^bot\d+:/.test(segment)
        ? "…"
        : segment,
    )
    .join("/");

/**
 * A URL for display: user info is dropped, query values and token-like path
 * segments are replaced, so credentials in URLs never reach a report.
 */
export const displayUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const names = [...parsed.searchParams.keys()];
  const base = `${parsed.protocol}//${parsed.host}${displayPath(parsed.pathname)}`;
  return names.length === 0
    ? base
    : `${base}?${names.map((name) => `${name}=…`).join("&")}`;
};

/** Apply displayUrl to every URL inside a text. */
export const displayUrlsIn = (text) =>
  text.replace(URL_TEXT, (url) => displayUrl(url));
