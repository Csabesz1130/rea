// Which path segments and file names carry a token: random-looking runs,
// bot tokens, JWTs and digests, but not the content hashes bundlers put in
// static asset names. The one rule claims, header values and source lines
// share (urls.mjs masks URL parts with it, redact.mjs words of source lines).

// A URL part as the URL parser keeps it: ASCII tab and line breaks, which
// it drops anywhere, removed, then percent-decoding undone.
export const decoded = (segment) => {
  const kept = segment.replace(/[\t\n\r]/g, "");
  try {
    return decodeURIComponent(kept);
  } catch {
    return kept;
  }
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

// Rollup, Vite and esbuild name a static asset `name-<hash>.js` with an
// 8-character base64url or base32 hash by default, which can hold `-` and
// `_` itself, and Vite may add a second one (`name-<hash>-<hash>.mjs`).
// The hashes are left out only when what precedes them reads as a name: a
// random-looking run with a separator 9 characters from its end is still
// tested whole.
const BUNDLER_HASH = /^[A-Za-z0-9_-]{8}$/;
const HASH_LENGTH = 9;
const withoutBundlerHash = (part) => {
  let name = part;
  while (
    name.length > HASH_LENGTH &&
    "-_".includes(name.at(-HASH_LENGTH)) &&
    BUNDLER_HASH.test(name.slice(1 - HASH_LENGTH))
  )
    name = name.slice(0, -HASH_LENGTH);
  return (name.match(CHUNKS) ?? []).some(randomChunk) ? part : name;
};

// The parts of a file name a token could hide in: a content hash in
// name.<hash>.ext, name-<hash>.ext or name_<hash>.ext identifies the content
// and is left out, as is a static asset named only by its hash (<hash>.js).
// A static asset's hash may also be a bundler's base64url or base32 one.
const nameParts = (value) => {
  const parts = value.split(".");
  const extension = parts.length > 1 ? parts.at(-1) : "";
  if (!EXTENSION.test(extension) && !HASHED_TYPE.test(extension)) return parts;
  const stem = parts.slice(0, -1);
  if (!HASHED_TYPE.test(extension)) return stem;
  const asset = STATIC_ASSET.test(value);
  return stem.map((part, index) => {
    if ((index > 0 || asset) && CONTENT_HASH.test(part)) return "";
    if (!asset) return part.replace(HASH_SUFFIX, "");
    if (index > 0 && BUNDLER_HASH.test(part)) return "";
    return withoutBundlerHash(part.replace(HASH_SUFFIX, ""));
  });
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
