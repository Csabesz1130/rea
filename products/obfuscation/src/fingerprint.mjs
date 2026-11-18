// Reads bounded windows of one file and reports, read-only, how its contents
// are shaped: whether JavaScript looks minified and which bundler produced
// it, whether a native executable carries a packer's markers, and whether a
// file is an archive another tool must open. It opens the file, reads a head
// and a tail window, and reports what it measured and the markers it found.
// It does not unpack, unminify, decompress or run anything; a packer marker
// is an observation, not a recovery of what the packer hid.
import { closeSync, openSync, readSync, statSync } from "node:fs";

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 128 * 1024;
const ENTROPY_SAMPLE = 64 * 1024;

// Reads up to `length` bytes of `fd` at `position`; the returned buffer is as
// long as what was read.
const readAt = (fd, position, length) => {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
};

// Shannon entropy of a buffer in bits per byte, 0 for empty: near 8 means
// the bytes are close to random, as compressed or packed data is.
const entropyOf = (buffer) => {
  if (buffer.length === 0) return 0;
  const counts = Array.from({ length: 256 }, () => 0);
  for (const byte of buffer) counts[byte] += 1;
  let bits = 0;
  for (const count of counts)
    if (count > 0) {
      const p = count / buffer.length;
      bits -= p * Math.log2(p);
    }
  return Math.round(bits * 100) / 100;
};

// The four-byte magic that starts the native formats the slicer's siblings
// read, and the two-byte "MZ" that starts a PE file.
const nativeFormat = (head) => {
  if (head.length < 4) return null;
  const magic = head.readUInt32BE(0);
  if (magic === 0x7f454c46) return "elf";
  if (new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]).has(magic))
    return "mach-o";
  if (magic === 0xcafebabe && head.readUInt32BE(4) <= 44) return "mach-o-fat";
  if (head.readUInt16LE(0) === 0x5a4d) return "pe";
  return null;
};

// Archives REA opens with its own tools rather than reading as one file.
const archiveFormat = (head, path) => {
  // An asar is an Electron archive; it is named by its extension, since its
  // bytes begin with a length field too ambiguous to key on.
  if (/\.asar$/i.test(path)) return "asar";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x504b0304) {
    if (/\.(apk|aab)$/i.test(path)) return "android-package";
    if (/\.jar$/i.test(path)) return "jar";
    return "zip";
  }
  // A Dalvik executable starts "dex\n" and a three-digit version.
  if (head.length >= 5 && head.subarray(0, 4).toString("latin1") === "dex\n")
    return "dex";
  return null;
};

// A packer's markers in a native file's head and tail: the pattern as a
// regular expression, the packer it names, and a note.
const PACKERS = [
  { packer: "UPX", pattern: /UPX!/, note: "the UPX magic" },
  { packer: "UPX", pattern: /\bUPX[0-2]\b/, note: "a UPX section name" },
  {
    packer: "UPX",
    pattern: /packed with the UPX/,
    note: "UPX's own banner string",
  },
  { packer: "ASPack", pattern: /\.aspack/, note: "an ASPack section name" },
  { packer: "MPRESS", pattern: /\.MPRESS[12]/, note: "an MPRESS section name" },
  { packer: "Themida", pattern: /\.themida/i, note: "a Themida section name" },
  { packer: "PECompact", pattern: /PEC2/, note: "a PECompact marker" },
];

// The bundlers and minifiers a JavaScript file's text names in its runtime.
const JS_TOOLS = [
  {
    tool: "webpack",
    pattern: /__webpack_require__|webpackChunk|__webpack_modules__/,
  },
  { tool: "esbuild", pattern: /__esm\(|__commonJS\(|__toESM\(|__toCommonJS\(/ },
  { tool: "rollup", pattern: /\bentryPoints\b.*rollup|ROLLUP_|commonjsGlobal/ },
  { tool: "parcel", pattern: /parcelRequire|@parcel\/transformer/ },
  { tool: "browserify", pattern: /_dereq_|browserify/ },
  { tool: "vite", pattern: /__vite__|__vitePreload|import\.meta\.hot/ },
  { tool: "terser", pattern: /\/\*! For license information/ },
];

// JavaScript shape from a head window of text: the line measurements and the
// bundler markers, and whether the measurements look minified. "likely" and
// its reasons rest on thresholds the report prints, not on a hidden rule.
const javascriptShape = (text, bytes) => {
  const lines = text.split("\n");
  const lengths = lines.map((line) => line.length);
  const nonEmpty = lengths.filter((length) => length > 0);
  const average =
    nonEmpty.reduce((sum, length) => sum + length, 0) / (nonEmpty.length || 1);
  const maxLine = lengths.length > 0 ? Math.max(...lengths) : 0;
  const longLineBytes = lengths
    .filter((length) => length > 2000)
    .reduce((sum, length) => sum + length, 0);
  const whitespace = (text.match(/\s/g) ?? []).length / (text.length || 1);
  const tools = JS_TOOLS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.tool,
  );
  const reasons = [];
  if (maxLine >= 5000)
    reasons.push(
      `a line of ${maxLine} characters (minified code has long lines)`,
    );
  if (whitespace < 0.08 && average > 200)
    reasons.push(
      `whitespace is ${Math.round(whitespace * 100)}% of the sample and the average line is ${Math.round(average)} characters`,
    );
  return {
    kind: "javascript",
    bundlers: tools,
    minified: {
      likely: reasons.length > 0,
      reasons,
    },
    measured: {
      sample_bytes: Math.min(bytes, text.length),
      total_bytes: bytes,
      lines: lines.length,
      average_line: Math.round(average),
      max_line: maxLine,
      long_line_ratio:
        Math.round((longLineBytes / (text.length || 1)) * 1000) / 1000,
      whitespace_ratio: Math.round(whitespace * 1000) / 1000,
    },
  };
};

// A native file's shape: its format, the packer markers found in the head and
// tail windows, and the entropy of a sample. High entropy is a hint, not a
// finding; an unpacked binary's code can be dense too.
const nativeShape = (format, { head, tail, fd, bytes }) => {
  const windows = `${head.toString("latin1")}\n${tail.toString("latin1")}`;
  const markers = PACKERS.filter((entry) => entry.pattern.test(windows)).map(
    (entry) => ({ packer: entry.packer, marker: entry.note }),
  );
  const middle = readAt(
    fd,
    Math.max(0, Math.floor(bytes / 2) - ENTROPY_SAMPLE / 2),
    ENTROPY_SAMPLE,
  );
  const packers = [...new Set(markers.map((entry) => entry.packer))];
  return {
    kind: "native",
    format,
    packer: {
      detected: packers,
      markers,
    },
    entropy: {
      bits_per_byte: entropyOf(middle),
      sample_bytes: middle.length,
      note: "near 8 suggests compressed or packed bytes; it is a hint, not a finding",
    },
  };
};

const isJavaScriptPath = (path) => /\.[cm]?jsx?$/i.test(path);

// True when the head bytes look like text (no NUL in the first kilobyte).
const looksText = (head) => !head.subarray(0, 1024).includes(0);

/**
 * Reads `path` and reports its shape: one of a javascript, native, archive or
 * unknown result, always with `{ file, bytes }`. Reads only a head and tail
 * window and an entropy sample; nothing is unpacked or run. Throws only when
 * the file cannot be opened.
 */
export const fingerprint = (path) => {
  const bytes = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const head = readAt(fd, 0, Math.min(HEAD_BYTES, bytes));
    const tail =
      bytes > HEAD_BYTES
        ? readAt(fd, Math.max(0, bytes - TAIL_BYTES), TAIL_BYTES)
        : Buffer.alloc(0);
    const base = { file: path, bytes };
    const archive = archiveFormat(head, path);
    if (archive)
      return {
        ...base,
        kind: "archive",
        format: archive,
        note: "an archive; REA's own tools (android, apktool, jeb, asar) read inside it",
      };
    const native = nativeFormat(head);
    if (native)
      return { ...base, ...nativeShape(native, { head, tail, fd, bytes }) };
    if (isJavaScriptPath(path) || looksText(head))
      return { ...base, ...javascriptShape(head.toString("utf8"), bytes) };
    return {
      ...base,
      kind: "unknown",
      note: "not a recognised text, native or archive format",
    };
  } finally {
    closeSync(fd);
  }
};
