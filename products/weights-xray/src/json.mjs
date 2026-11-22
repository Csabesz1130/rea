// Strict JSON over UTF-8 bytes. JSON.parse cannot reject duplicate keys,
// cannot keep 64-bit integers exact and cannot cite byte positions, and all
// three matter for a checkpoint header that two readers may resolve differently.
import { FormatError } from "./errors.mjs";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * Parse one JSON value from `bytes`. Integers without a fraction or exponent
 * become BigInt; other numbers become Number. Objects have a null prototype.
 * `onRootEntry(key, start, end)` receives the byte span of each member of a
 * root object, from the opening quote of the key to the end of its value.
 * Positions are reported relative to `base`.
 */
export function parseJson(
  bytes,
  { base = 0, maxDepth = 64, onRootEntry } = {},
) {
  let i = 0;
  const fail = (code, message, at = i) => {
    throw new FormatError(code, message, base + at);
  };
  const ws = () => {
    while (i < bytes.length && WS.has(bytes[i])) i++;
  };
  const string = () => {
    const start = i;
    i++; // opening quote
    let out = "";
    let run = i;
    for (;;) {
      if (i >= bytes.length) fail("JSON_SYNTAX", "Unterminated string", start);
      const c = bytes[i];
      if (c === 0x22) break;
      if (c < 0x20)
        fail("JSON_SYNTAX", "Unescaped control character in string");
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += decode(run, i);
      i++;
      const e = bytes[i];
      const simple = {
        0x22: '"',
        0x5c: "\\",
        0x2f: "/",
        0x62: "\b",
        0x66: "\f",
        0x6e: "\n",
        0x72: "\r",
        0x74: "\t",
      }[e];
      if (simple !== undefined) {
        out += simple;
        i++;
      } else if (e === 0x75) {
        let unit = hex4(i + 1);
        i += 5;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (bytes[i] !== 0x5c || bytes[i + 1] !== 0x75)
            fail("JSON_SYNTAX", "Lone surrogate in string escape");
          const low = hex4(i + 2);
          if (low < 0xdc00 || low > 0xdfff)
            fail("JSON_SYNTAX", "Lone surrogate in string escape");
          i += 6;
          out += String.fromCharCode(unit, low);
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          fail("JSON_SYNTAX", "Lone surrogate in string escape");
        } else out += String.fromCharCode(unit);
      } else fail("JSON_SYNTAX", "Invalid string escape");
      run = i;
    }
    out += decode(run, i);
    i++; // closing quote
    return out;
  };
  const decode = (from, to) => {
    if (from === to) return "";
    try {
      return utf8.decode(bytes.subarray(from, to));
    } catch {
      return fail("HEADER_NOT_UTF8", "String is not valid UTF-8", from);
    }
  };
  const hex4 = (at) => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = bytes[at + k];
      const d =
        c >= 0x30 && c <= 0x39
          ? c - 0x30
          : c >= 0x61 && c <= 0x66
            ? c - 87
            : c >= 0x41 && c <= 0x46
              ? c - 55
              : -1;
      if (d < 0) fail("JSON_SYNTAX", "Invalid unicode escape", at + k);
      v = v * 16 + d;
    }
    return v;
  };
  const number = () => {
    const start = i;
    if (bytes[i] === 0x2d) i++;
    if (bytes[i] === 0x30) i++;
    else if (bytes[i] >= 0x31 && bytes[i] <= 0x39)
      while (bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    else fail("JSON_SYNTAX", "Invalid number");
    let integer = true;
    if (bytes[i] === 0x2e) {
      integer = false;
      i++;
      if (!(bytes[i] >= 0x30 && bytes[i] <= 0x39))
        fail("JSON_SYNTAX", "Invalid number");
      while (bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    }
    if (bytes[i] === 0x65 || bytes[i] === 0x45) {
      integer = false;
      i++;
      if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;
      if (!(bytes[i] >= 0x30 && bytes[i] <= 0x39))
        fail("JSON_SYNTAX", "Invalid number");
      while (bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    }
    const text = String.fromCharCode(...bytes.subarray(start, i));
    return integer ? BigInt(text) : Number(text);
  };
  const literal = (word, value) => {
    for (let k = 0; k < word.length; k++)
      if (bytes[i + k] !== word.charCodeAt(k))
        fail("JSON_SYNTAX", "Unexpected token");
    i += word.length;
    return value;
  };
  const value = (depth) => {
    if (depth > maxDepth)
      fail("JSON_SYNTAX", "Nesting exceeds " + maxDepth + " levels");
    ws();
    const c = bytes[i];
    if (c === 0x7b) {
      const object = Object.create(null);
      i++;
      ws();
      if (bytes[i] === 0x7d) {
        i++;
        return object;
      }
      for (;;) {
        ws();
        const keyStart = i;
        if (bytes[i] !== 0x22) fail("JSON_SYNTAX", "Expected a string key");
        const key = string();
        if (Object.hasOwn(object, key))
          fail(
            "DUPLICATE_KEY",
            "Duplicate key " + JSON.stringify(key),
            keyStart,
          );
        ws();
        if (bytes[i] !== 0x3a) fail("JSON_SYNTAX", "Expected ':'");
        i++;
        object[key] = value(depth + 1);
        if (depth === 0 && onRootEntry)
          onRootEntry(key, base + keyStart, base + i);
        ws();
        if (bytes[i] === 0x2c) {
          i++;
          continue;
        }
        if (bytes[i] === 0x7d) {
          i++;
          return object;
        }
        fail("JSON_SYNTAX", "Expected ',' or '}'");
      }
    }
    if (c === 0x5b) {
      const array = [];
      i++;
      ws();
      if (bytes[i] === 0x5d) {
        i++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        ws();
        if (bytes[i] === 0x2c) {
          i++;
          continue;
        }
        if (bytes[i] === 0x5d) {
          i++;
          return array;
        }
        fail("JSON_SYNTAX", "Expected ',' or ']'");
      }
    }
    if (c === 0x22) return string();
    if (c === 0x74) return literal("true", true);
    if (c === 0x66) return literal("false", false);
    if (c === 0x6e) return literal("null", null);
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return number();
    return fail(
      "JSON_SYNTAX",
      i >= bytes.length ? "Unexpected end of JSON" : "Unexpected token",
    );
  };
  const result = value(0);
  ws();
  if (i !== bytes.length)
    fail("JSON_SYNTAX", "Unexpected data after the JSON value");
  return result;
}
