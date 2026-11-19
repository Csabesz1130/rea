// Same representation as tokens(JSON.stringify(JSON.parse(source))), including
// key ordering, escape normalization, negative zero and ECMAScript number spelling.
import { clearMergeCache } from "gpt-tokenizer/encoding/cl100k_base";
import { tokens } from "./store.mjs";

const BLOCK = 16 * 1024;
const DIRECT_BYTES = 1024 * 1024;
const MAX_INPUT = 512 * 1024 * 1024;
const MAX_LIVE_KEYS = 1024 * 1024;
const breakAfter = /[\p{L}\p{N}](?=[^\p{L}\p{N}])/u;

class CompactCounter {
  pending = "";
  count = 0;
  sinceCacheTrim = 0;

  write(text) {
    for (let at = 0; at < text.length && this.count !== null;) {
      const take = Math.min(BLOCK - this.pending.length, text.length - at);
      this.pending += text.slice(at, at + take);
      at += take;
      if (this.pending.length !== BLOCK) continue;
      // cl100k_base pre-tokens ending in letters or digits cannot contain a
      // subsequent punctuation/space. A cut here leaves both tokenizations
      // identical. Keep a following character as proof, including at EOF.
      const start = Math.floor(BLOCK / 2);
      const last = this.pending.charCodeAt(BLOCK - 1);
      const end = last >= 0xd800 && last <= 0xdbff ? BLOCK - 1 : BLOCK;
      const match = breakAfter.exec(this.pending.slice(start, end));
      if (!match) {
        // A long unbroken string can require disproportionate BPE work.
        this.count = null;
        this.pending = "";
        return;
      }
      const cut = start + match.index + match[0].length;
      this.count += tokens(this.pending.slice(0, cut));
      this.sinceCacheTrim += cut;
      // The library otherwise retains up to 100,000 variable-length merge
      // results across calls. Bound the input accumulated in that cache.
      if (this.sinceCacheTrim >= 1024 * 1024) {
        clearMergeCache();
        this.sinceCacheTrim = 0;
      }
      this.pending = this.pending.slice(cut);
    }
  }

  finish() {
    return this.count === null ? null : this.count + tokens(this.pending);
  }
}

class StreamingJsonCount {
  counter = new CompactCounter();
  frames = [];
  liveKeys = 0;
  highSurrogate = "";

  cancel() {
    this.counter.count = null;
    this.counter.pending = "";
    this.frames.length = 0;
  }

  key(frame, key) {
    // JSON.stringify enumerates array-index keys first in increasing order.
    // On a large unordered or duplicate-key object, a full copy would be
    // needed to reorder or replace values. Leave this optional metric unknown.
    const n = Number(key);
    const indexed =
      Number.isInteger(n) && n >= 0 && n < 0xffffffff && String(n) === key;
    const cost = key.length + 32;
    if (
      this.liveKeys + cost > MAX_LIVE_KEYS ||
      frame.keys.has(key) ||
      (indexed && (frame.named || n <= frame.lastIndex))
    ) {
      this.cancel();
      return;
    }
    if (indexed) frame.lastIndex = n;
    else frame.named = true;
    if (frame.keys.size) this.counter.write(",");
    frame.keys.add(key);
    frame.cost += cost;
    this.liveKeys += cost;
    this.counter.write(JSON.stringify(key) + ":");
  }

  accept({ name, value }) {
    if (this.counter.count === null) return;
    const parent = this.frames.at(-1);
    switch (name) {
      case "keyValue":
        this.key(parent, value);
        return;
      case "stringChunk": {
        let part = this.highSurrogate + value;
        const tail = part.charCodeAt(part.length - 1);
        this.highSurrogate = "";
        if (tail >= 0xd800 && tail <= 0xdbff) {
          this.highSurrogate = part.slice(-1);
          part = part.slice(0, -1);
        }
        this.counter.write(JSON.stringify(part).slice(1, -1));
        return;
      }
      case "endString":
        this.counter.write(
          JSON.stringify(this.highSurrogate).slice(1, -1) + '"',
        );
        this.highSurrogate = "";
        return;
      case "endObject":
      case "endArray":
        this.liveKeys -= this.frames.pop().cost;
        this.counter.write(name === "endArray" ? "]" : "}");
        return;
    }
    if (parent?.array) {
      if (parent.started) this.counter.write(",");
      parent.started = true;
    }
    switch (name) {
      case "startObject":
        this.counter.write("{");
        this.frames.push({
          keys: new Set(),
          cost: 0,
          named: false,
          lastIndex: -1,
        });
        break;
      case "startArray":
        this.counter.write("[");
        this.frames.push({ array: true, cost: 0, started: false });
        break;
      case "startString":
        this.counter.write('"');
        break;
      case "numberValue":
        this.counter.write(JSON.stringify(Number(value)));
        break;
      case "nullValue":
      case "trueValue":
      case "falseValue":
        this.counter.write(JSON.stringify(value));
        break;
      default:
        this.cancel();
    }
  }
}

export function evidenceTokenMeter(inputBytes) {
  if (inputBytes > MAX_INPUT) return { finish: () => null };
  if (inputBytes <= DIRECT_BYTES) {
    const chunks = [];
    return {
      bytes: (chunk) => chunks.push(chunk),
      finish() {
        const counter = new CompactCounter();
        counter.write(
          JSON.stringify(
            JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))),
          ),
        );
        return counter.finish();
      },
    };
  }
  const stream = new StreamingJsonCount();
  return {
    token: (token) => stream.accept(token),
    finish: () => stream.counter.finish(),
  };
}
