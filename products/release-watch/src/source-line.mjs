// One source line for display next to an evidence item. Masking does not
// depend on reading the line's syntax correctly: every rule finds spans on a
// bounded slice around the cited column, never widened to whole tokens; the
// spans are merged and replaced by tags, and the cited column is mapped
// through them. Every scan is linear in the slice. Display only: the saved
// Evidence keeps the original.
import { printable, secretSpans } from "./redact.mjs";
import {
  interpolationEnd,
  literalParts,
  maskTag,
  replaceSpans,
  urlOwned,
  urlRuns,
} from "./urls.mjs";

const MAX_LINE = 180;
const LEAD = 60;
const MARGIN = 2000;
// Text this close to a cut slice edge may belong to a value whose context
// was cut off, so it is never shown, nor is the rest of the run it is in.
const EDGE = 200;
const RUN_BOUNDARY = /[\s"'`<>\\)\]}]/;
// Files whose lines are markup, where character references are decoded.
const MARKUP_FILE = /\.(?:html?|xhtml|svg|xml)$/i;

// How each view character was written in the source.
const LITERAL = 0;
const REFERENCE = 1;
const ESCAPE = 2;
const CODE_ESCAPE = 3;

// Named references that write URL syntax, quotes or line breaks.
const NAMED_REFERENCES = {
  amp: "&",
  AMP: "&",
  quot: '"',
  QUOT: '"',
  apos: "'",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  equals: "=",
  quest: "?",
  num: "#",
  sol: "/",
  bsol: "\\",
  colon: ":",
  semi: ";",
  commat: "@",
  percnt: "%",
  plus: "+",
  period: ".",
  Tab: "\t",
  NewLine: "\n",
};
const SIMPLE_ESCAPES = { n: "\n", r: "\r", t: "\t" };

const codePoint = (code) =>
  code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? "\ufffd"
    : String.fromCodePoint(code);

// An HTML character reference at `index`: `{ value, end, kind }` or null.
const referenceAt = (text, index) => {
  const numeric = /^&#(?:[xX]([0-9a-fA-F]{1,6})|(\d{1,7}));?/.exec(
    text.slice(index, index + 12),
  );
  const named = /^&([A-Za-z]{2,7});/.exec(text.slice(index, index + 10));
  const value = numeric
    ? codePoint(numeric[1] ? parseInt(numeric[1], 16) : Number(numeric[2]))
    : named && Object.hasOwn(NAMED_REFERENCES, named[1])
      ? NAMED_REFERENCES[named[1]]
      : null;
  const length = (numeric ?? named)?.[0].length;
  return value === null
    ? null
    : { value, end: index + length, kind: REFERENCE };
};

// A JavaScript escape at `index`: `{ value, end, kind }` or null.
const escapeAt = (text, index) => {
  const next = text[index + 1] ?? "";
  if ("nrt\\/\"'`".includes(next) && next !== "")
    return {
      value: SIMPLE_ESCAPES[next] ?? next,
      end: index + 2,
      kind: ESCAPE,
    };
  const code =
    /^\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\})/.exec(
      text.slice(index, index + 10),
    );
  return code
    ? {
        value: codePoint(parseInt(code[1] ?? code[2] ?? code[3], 16)),
        end: index + code[0].length,
        kind: CODE_ESCAPE,
      }
    : null;
};

/**
 * The slice as the rules read it: JavaScript escapes decoded, and in markup
 * HTML character references too, with each view character's source range
 * and kind, so a key written as `\x41…` or a query behind `&#x26;` is still
 * found; `&amp;` in a script is code, not a reference.
 */
const viewOf = (source, markup) => {
  let text = "";
  const starts = [];
  const ends = [];
  const kinds = [];
  for (let index = 0; index < source.length;) {
    const decoded =
      source[index] === "&" && markup
        ? referenceAt(source, index)
        : source[index] === "\\"
          ? escapeAt(source, index)
          : null;
    const value = decoded?.value ?? source[index];
    const end = decoded?.end ?? index + 1;
    for (let unit = 0; unit < value.length; unit += 1) {
      starts.push(index);
      ends.push(end);
      kinds.push(decoded?.kind ?? LITERAL);
    }
    text += value;
    index = end;
  }
  const runs = urlRuns(text, markup ? "markup" : "code");
  return { text, starts, ends, kinds, runs, owned: urlOwned(text, runs) };
};

// Which tag a range keeps when two rules mask exactly it: a URL part keeps
// the tag its claim shows.
const RANK = {
  string: 0,
  word: 1,
  quoted: 2,
  pattern: 3,
  credential: 4,
  url: 5,
  decoded: 6,
};
const QUOTES = "\"'`";

const tagged = (text, start, end, rank) => ({
  start,
  end,
  tag: maskTag(text.slice(start, end)),
  rank,
});

// Word runs outside URLs written partly as `\x..` or `\u....` escapes,
// which can hide a key.
const escapeSpans = ({ text, kinds, owned }) => {
  const spans = [];
  for (let index = 0; index < text.length;) {
    let end = index;
    let escaped = false;
    while (
      end < text.length &&
      !owned[end] &&
      /[A-Za-z0-9_+/=.-]/.test(text[end])
    ) {
      escaped ||= kinds[end] === CODE_ESCAPE;
      end += 1;
    }
    if (escaped && end - index >= 8)
      spans.push(tagged(text, index, end, "pattern"));
    index = Math.max(end, index + 1);
  }
  return spans;
};

const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|typeof|case|void|in|of|delete|throw|yield|await|else|do)$/;

// Whether a quote at `index` can open a string: after an operator,
// punctuation or keyword, never after a word or `/` (a regex literal).
const opensString = (text, index) => {
  let before = index - 1;
  while (before >= 0 && index - before < 16 && /[ \t]/.test(text[before]))
    before -= 1;
  if (before < 0) return true;
  if (text[index] === "`" && /[\w$)]/.test(text[before])) return true;
  if (/[(,=:[{;!&|?+\-*%<>~^}]/.test(text[before])) return true;
  return KEYWORD_BEFORE.test(text.slice(Math.max(0, before - 8), before + 1));
};

// Whether a quote at `index` can close a string: before an operator,
// punctuation, a space or `in`/`of`, never inside a word such as "Don't"
// or before `/`, as in the regex literal /'/.
const closesString = (text, index) => {
  const after = text[index + 1];
  if (after === undefined || /[\s),;:\]}.+=!?&|<>*%-]/.test(after)) return true;
  return /^(?:in|of|instanceof)\b/.test(text.slice(index + 1, index + 12));
};

const sameQuote = ({ text, kinds }, index, quote) =>
  text[index] === text[quote] && kinds[index] === kinds[quote];

// An unclosed string shows as code after its first word.
const wordEnd = (text, from) => {
  let end = from;
  while (end < text.length && end - from < 512 && !/[\s,;)}\]]/.test(text[end]))
    end += 1;
  return end;
};

// The closing quote of a string opening at `open`, before `to`: a template
// closes after its interpolations.
const closeOf = (view, open, to) => {
  let close = open + 1;
  while (close < to && !sameQuote(view, close, open)) {
    const after =
      view.text[open] === "`" ? interpolationEnd(view.text, close) : -1;
    close = after === -1 ? close + 1 : after;
  }
  return close;
};

// Short strings that name protocol parts rather than carry values: HTTP
// methods, header-like names (`x-api-key`, `Content-Type`) and single words.
const KEYWORD =
  /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$|^[A-Za-z][a-z]*(?:-[A-Za-z][a-z]*)*$/;
const keywordLike = (written) =>
  written.trim().length <= 24 && KEYWORD.test(written.trim());

// The parts of [start, end) outside URL runs, which the URL rules mask.
const outsideUrls = ({ text, owned }, start, end, spans) => {
  for (let index = start; index < end;) {
    if (owned[index]) {
      index += 1;
      continue;
    }
    let stop = index;
    while (stop < end && !owned[stop]) stop += 1;
    if (/\S/.test(text.slice(index, stop)))
      spans.push(tagged(text, index, stop, "string"));
    index = stop;
  }
};

// A string body on a sensitive line: URLs keep their readable parts and a
// keyword-like string stays; a template's literal parts are masked and the
// strings inside its interpolations are read as code.
const bodySpans = (view, { start, end, template }, spans, depth) => {
  const { text } = view;
  const parts = template ? literalParts(text, start, end) : [{ start, end }];
  let cursor = start;
  for (const part of [...parts, { start: end, end }]) {
    if (part.start > cursor && depth < 2)
      forwardStrings(view, [cursor + 2, part.start - 1], spans, depth + 1);
    cursor = part.end;
  }
  const written = parts.map((part) => text.slice(part.start, part.end));
  if (keywordLike(written.join(""))) return;
  for (const part of parts) outsideUrls(view, part.start, part.end, spans);
};

// Strings opening in [from, to), paired forward.
const forwardStrings = (view, [from, to], spans, depth = 0) => {
  const { text } = view;
  for (let index = from; index < to; index += 1) {
    if (!QUOTES.includes(text[index]) || !opensString(text, index)) continue;
    const close = closeOf(view, index, to);
    const end = close < to ? close : wordEnd(text, index + 1);
    const template = text[index] === "`";
    bodySpans(view, { start: index + 1, end, template }, spans, depth);
    index = end;
  }
};

// On a line REA marked sensitive, every string body but URLs' readable
// parts and keyword-like strings. The cited column is code, so strings are
// paired forward from it and backward from it, and a misread quote
// elsewhere cannot carry a string across the cited call.
const stringSpans = (view, anchor) => {
  const { text } = view;
  const spans = [];
  forwardStrings(view, [anchor, text.length], spans);
  for (let index = anchor - 1; index >= 0; index -= 1) {
    if (!QUOTES.includes(text[index]) || !closesString(text, index)) continue;
    let open = index - 1;
    while (open >= 0 && !sameQuote(view, open, index)) open -= 1;
    const template = text[index] === "`";
    bodySpans(view, { start: open + 1, end: index, template }, spans, 0);
    index = open;
  }
  return spans;
};

// On a sensitive line, shorter words outside URLs that mix letters and
// digits.
const shortWordSpans = ({ text, owned }) =>
  [...text.matchAll(/[A-Za-z0-9_+=-]{8,}/g)]
    .filter(
      ({ index, 0: word }) =>
        !owned[index] && /\d/.test(word) && /[A-Za-z]/.test(word),
    )
    .map(({ index, 0: word }) =>
      tagged(text, index, index + word.length, "string"),
    );

// A value read up to a quote never runs across the cited column, which is
// code: a misread quote before the call cannot hide it.
const clip = (spans, anchor) =>
  spans.map((item) =>
    item.rank === "quoted" && item.start < anchor && anchor < item.end
      ? { ...item, end: anchor }
      : item,
  );

// Merge overlapping spans: a span inside another takes the outer one's tag
// (equal ranges keep the highest rank); partly overlapping ones are joined.
const merge = (spans, text) => {
  const merged = [];
  const sorted = spans
    .filter((item) => item.end > item.start)
    .sort(
      (a, b) =>
        a.start - b.start || b.end - a.end || RANK[b.rank] - RANK[a.rank],
    );
  for (const item of sorted) {
    const last = merged.at(-1);
    if (last === undefined || item.start >= last.end) merged.push({ ...item });
    else if (item.end > last.end) {
      last.end = item.end;
      last.tag = maskTag(text.slice(last.start, last.end));
    }
  }
  return merged;
};

// A URL written with character references (`&#x26;key=`) or escapes
// (`\x26`, `\/`) is shown decoded, with its masks, so it reads as its claim
// does and later scrubbing cannot read an escape as part of a value.
const decodedRuns = ({ text, kinds, runs }, spans) => {
  const result = [];
  let next = 0;
  for (const run of runs) {
    if (run.end - run.start > 300) continue;
    if (!kinds.slice(run.start, run.end).some((kind) => kind !== LITERAL))
      continue;
    if (run.start < (result.at(-1)?.end ?? 0)) continue;
    while (next < spans.length && spans[next].end <= run.start)
      result.push(spans[next++]);
    let { start, end } = run;
    const inner = [];
    while (next < spans.length && spans[next].start < end) {
      inner.push(spans[next]);
      start = Math.min(start, spans[next].start);
      end = Math.max(end, spans[next++].end);
    }
    const local = inner.map((item) => ({
      ...item,
      start: item.start - start,
      end: item.end - start,
    }));
    const tag = printable(replaceSpans(text.slice(start, end), local));
    result.push({ start, end, tag, rank: "decoded" });
  }
  return [...result, ...spans.slice(next)];
};

/** Masked spans of a slice in source coordinates, ordered and disjoint. */
const maskSpans = (source, anchor, { sensitive, markup }) => {
  const view = viewOf(source, markup);
  let viewAnchor = 0;
  while (viewAnchor < view.starts.length && view.starts[viewAnchor] < anchor)
    viewAnchor += 1;
  const spans = [
    ...secretSpans(view),
    ...escapeSpans(view),
    ...(sensitive
      ? [...stringSpans(view, viewAnchor), ...shortWordSpans(view)]
      : []),
  ];
  const merged = merge(clip(spans, viewAnchor), view.text);
  return decodedRuns(view, merged).map((item) => ({
    ...item,
    start: view.starts[item.start],
    end: view.ends[item.end - 1],
  }));
};

/** The slice as printed pieces, `{ from, to, raw, shown, at, tag }`, in order. */
const render = (source, spans) => {
  const pieces = [];
  let cursor = 0;
  let at = 0;
  const add = (from, to, tag) => {
    const raw = source.slice(from, to);
    const shown = tag ?? printable(raw);
    pieces.push({ from, to, raw, shown, at, tag: tag !== null });
    at += shown.length;
  };
  for (const item of spans) {
    if (item.start > cursor) add(cursor, item.start, null);
    add(item.start, item.end, item.tag);
    cursor = item.end;
  }
  if (cursor < source.length) add(cursor, source.length, null);
  return pieces;
};

// The printed position of a source index; inside a tag, the tag's start.
const positionOf = (pieces, index) => {
  const piece = pieces.find((item) => index < item.to) ?? pieces.at(-1);
  if (piece === undefined) return 0;
  if (piece.tag) return piece.at;
  return piece.at + printable(piece.raw.slice(0, index - piece.from)).length;
};

// Widen a window so it never cuts a tag in two, unless that would cross a
// bound; then narrow it.
const snap = (pieces, [first, last], [low, high]) => {
  const tagAt = (position) =>
    pieces.find(
      (item) =>
        item.tag &&
        item.at < position &&
        position < item.at + item.shown.length,
    );
  const head = tagAt(first);
  const tail = tagAt(last);
  const headEnd = head && head.at + head.shown.length;
  const tailEnd = tail && tail.at + tail.shown.length;
  return [
    head === undefined ? first : head.at >= low ? head.at : headEnd,
    tail === undefined ? last : tailEnd <= high ? tailEnd : tail.at,
  ];
};

// Where shown text starts after a cut slice start, and ends before a cut
// slice end: past EDGE characters and the rest of the run they fall in,
// such as user info whose `scheme://` or `@host` was cut off, but never
// past the cited column.
const shownFrom = (source, cited) => {
  let at = Math.min(EDGE, cited);
  while (at < cited && !RUN_BOUNDARY.test(source[at])) at += 1;
  return at;
};
const shownTo = (source, cited) => {
  let at = Math.max(source.length - EDGE, cited);
  while (at > cited && !RUN_BOUNDARY.test(source[at - 1])) at -= 1;
  return at;
};

const excerpt = ({ line, column, width, ...reading }) => {
  const cited = Math.min(Math.max(0, Number(column) || 0), line.length);
  const from = Math.max(0, cited - LEAD - MARGIN);
  const to = Math.min(line.length, cited + width + MARGIN);
  const source = line.slice(from, to);
  const pieces = render(source, maskSpans(source, cited - from, reading));
  const shown = pieces.map((piece) => piece.shown).join("");
  if (from === 0 && to === line.length && shown.length <= width)
    return shown.trim();
  const low =
    from > 0 ? positionOf(pieces, shownFrom(source, cited - from)) : 0;
  const high =
    to < line.length
      ? positionOf(pieces, shownTo(source, cited - from))
      : shown.length;
  const position = positionOf(pieces, cited - from);
  const first = Math.max(low, Math.min(position - LEAD, high - width));
  const window = [first, Math.min(high, first + width)];
  const [start, end] = snap(pieces, window, [low, high]);
  const head = from > 0 || start > 0 ? "…" : "";
  const tail = to < line.length || end < shown.length ? "…" : "";
  return `${head}${shown.slice(start, end).trim()}${tail}`;
};

/**
 * A source line for display, at most MAX_LINE characters around `column`.
 * `sensitive` also masks every string but URLs' readable parts and
 * keyword-like strings, and shorter token-like words: a line where REA
 * reported a key. `file` decides whether the line is markup, whose
 * character references are decoded.
 */
export const sourceLine = (
  text,
  column = 0,
  { sensitive = false, file = "" } = {},
) =>
  excerpt({
    line: String(text),
    column,
    sensitive,
    markup: MARKUP_FILE.test(String(file)),
    width: MAX_LINE,
  });

/**
 * How a line hands its expression to the next one: `escaped` when it ends
 * with an odd run of backslashes, inside a string continued on the next
 * line; `template` when it ends inside a template literal (`opened` says
 * whether it started inside one); `operand` when it ends with `+`, `,`, `[`
 * or `(`, so the next line carries on the value.
 */
export const continuation = (line, opened = false) => {
  let template = opened;
  for (let index = 0; index < line.length; index += 1)
    if (line[index] === "\\") index += 1;
    else if (line[index] === "`") template = !template;
  let backslashes = 0;
  while (line[line.length - 1 - backslashes] === "\\") backslashes += 1;
  const last = line.trimEnd().at(-1) ?? "";
  return {
    escaped: backslashes % 2 === 1,
    template,
    operand: last !== "" && "+,[(".includes(last),
  };
};

/** The start of a text for display, at most `width` characters, masked as a source line is. */
export const textPreview = (text, width) =>
  excerpt({
    line: String(text),
    column: 0,
    sensitive: false,
    markup: false,
    width,
  });
