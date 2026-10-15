// The single redaction and escaping boundary for everything Release Watch
// prints or writes: credential-format tokens anywhere, URL query values and
// token-like path segments, and control characters.
import { credentialsIn } from "./catalog.mjs";
import { displayUrlsIn, maskTag } from "./urls.mjs";

/** Mask credentials and URL secrets in one text. */
export const scrubText = (text) => {
  if (typeof text !== "string") return text;
  let result = displayUrlsIn(text);
  for (const credential of credentialsIn(result))
    result = result.split(credential.value).join(credential.masked);
  return result;
};

// Shapes a raw source line can carry a secret in, beyond absolute URLs and
// documented key formats: query pairs in relative, template or concatenated
// URLs; Bearer and Basic tokens; values of credential-named fields; and
// escape sequences, which can hide a key from every other pattern.
const QUERY_PAIR = /([?&][A-Za-z0-9_.\-[\]]+=)([^&#\s"'`)\]}]+)/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const CREDENTIAL_FIELD =
  /((?:["'`]?)(?:authorization|proxy-authorization|x-api-key|api-key|apikey|api_key|x-goog-api-key|access_token|client_secret|secret|password|passwd|token)(?:["'`]?)\s*[:=]\s*)(["'`])([^"'`]{6,})\2/gi;
const ESCAPED_STRING =
  /(["'`])((?:[^"'`\\\n]|\\.)*\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f{]|[0-7]{1,3}|[nrt\\\n])(?:[^"'`\\\n]|\\.)*)\1/g;

/**
 * Scrub one raw source line for display. Stricter than scrubText, because
 * source can hold secrets in forms no URL parser or key format sees; a
 * masked line is still a pointer to the evidence, which keeps the original.
 */
export const scrubSource = (text) =>
  scrubText(
    String(text)
      .replace(
        ESCAPED_STRING,
        (_match, quote, body) => `${quote}${maskTag(body)}${quote}`,
      )
      .replace(
        CREDENTIAL_FIELD,
        (_match, field, quote, value) =>
          `${field}${quote}${maskTag(value)}${quote}`,
      )
      .replace(
        AUTH_SCHEME,
        (_match, scheme, space, value) => `${scheme}${space}${maskTag(value)}`,
      )
      .replace(QUERY_PAIR, (_match, name, value) =>
        value.startsWith("${") ? `${name}${value}` : `${name}${maskTag(value)}`,
      ),
  );

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
