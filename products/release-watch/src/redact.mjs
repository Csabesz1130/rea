// The single redaction and escaping boundary for everything Release Watch
// prints or writes: credential-format tokens anywhere, URL query values and
// token-like path segments, and control characters.
import { credentialsIn } from "./catalog.mjs";
import { displayUrlsIn, maskLoosely } from "./urls.mjs";

// A relative or protocol-relative URL with a query, inside prose or a
// header value (a CSP report-uri, a script source).
const RELATIVE_URL =
  /(^|[\s"'(=,;])((?:\/\/|\/)[^\s"'`<>;,()]*\?[^\s"'`<>;,()]*)/g;

/** Mask credentials and URL secrets in one text. */
export const scrubText = (text) => {
  if (typeof text !== "string") return text;
  let result = displayUrlsIn(text).replace(
    RELATIVE_URL,
    (_match, lead, url) => `${lead}${maskLoosely(url)}`,
  );
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

// C0 and C1 controls, line and paragraph separators, and bidirectional overrides.
const CONTROL =
  // oxlint-disable-next-line no-control-regex -- matching control characters is this expression's purpose.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

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
