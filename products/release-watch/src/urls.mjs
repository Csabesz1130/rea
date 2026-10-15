// URL helpers shared by facts, rules and reports. URLs here are values REA
// reported; parsing them with WHATWG URL reads no source.

const URL_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>)\]}]+/gi;

/** True when a whole string is an absolute http(s) or ws(s) URL. */
export const isUrl = (value) =>
  typeof value === "string" && /^(https?|wss?):\/\/[^\s"'`]+$/i.test(value);

/** Every absolute URL inside a text. */
// Sentence punctuation after a URL in prose or a header value is not part of it.
const splitTail = (match) => /^(.*?)([.,;:!?]*)$/s.exec(match).slice(1);

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
 * A URL for display: user info is dropped, query values, fragments and
 * token-like path segments are replaced, so credentials in URLs never reach
 * a report. A URL with nothing to mask is returned exactly as given.
 */
export const displayUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pathname = displayPath(parsed.pathname);
  const names = [...parsed.searchParams.keys()];
  const masked =
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    pathname !== parsed.pathname;
  if (!masked) return url;
  const query =
    names.length === 0 ? "" : `?${names.map((name) => `${name}=…`).join("&")}`;
  return `${parsed.protocol}//${parsed.host}${pathname}${query}${parsed.hash === "" ? "" : "#…"}`;
};

/** Apply displayUrl to every URL inside a text. */
export const displayUrlsIn = (text) =>
  text.replace(URL_TEXT, (match) => {
    const [url, tail] = splitTail(match);
    return `${displayUrl(url)}${tail}`;
  });
