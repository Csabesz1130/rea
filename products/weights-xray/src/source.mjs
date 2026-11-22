// Positional reads from one admitted regular-file descriptor, with every
// request and byte counted. Parsers read through a Cursor so the same grammar
// code can later run over bounded HTTP ranges.
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { BudgetError, FormatError } from "./errors.mjs";

let regularFile;
async function admission() {
  regularFile ??= await import("../../../dist/filesystem/RegularFile.js");
  return regularFile;
}

/** One local file opened for positional reads. */
export class LocalSource {
  static async open(path, { signal } = {}) {
    const { openRegularFile } = await admission();
    const handle = await openRegularFile(path, { symlinks: "follow", signal });
    try {
      const initial = await handle.stat({ bigint: true });
      return new LocalSource(handle, initial, basename(path), signal);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  constructor(handle, initial, name, signal) {
    this.handle = handle;
    this.initial = initial;
    this.name = name;
    this.size = Number(initial.size);
    this.signal = signal;
    this.requests = 0;
    this.bytes = 0;
    this.ranges = [];
  }

  /** Read exactly `length` bytes at `position`, or fail with TRUNCATED. */
  async read(position, length) {
    this.signal?.throwIfAborted();
    if (position + length > this.size)
      throw new FormatError(
        "TRUNCATED",
        `Read of ${length} bytes at ${position} passes the end of the file`,
        position,
      );
    const buffer = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(
        buffer,
        done,
        length - done,
        position + done,
      );
      this.requests++;
      if (bytesRead === 0)
        throw new FormatError(
          "TRUNCATED",
          "File ended during a read",
          position + done,
        );
      done += bytesRead;
    }
    this.bytes += length;
    this.ranges.push([position, position + length]);
    return buffer;
  }

  /** Confirm the descriptor still names the admitted contents before publishing. */
  async verify() {
    const { sameRegularFileState } = await admission();
    const now = await this.handle.stat({ bigint: true });
    if (!sameRegularFileState(this.initial, now))
      throw new FormatError(
        "FILE_CHANGED",
        "Selected file changed while it was being read",
        0,
      );
  }

  usage() {
    return {
      requests: this.requests,
      bytes_read: this.bytes,
      ranges: mergeRanges(this.ranges),
    };
  }

  async close() {
    await this.handle.close();
  }
}

/** Merge overlapping or adjacent [start, end) ranges for reporting. */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.length > 64
    ? { count: out.length, first: out.slice(0, 32), last: out.slice(-32) }
    : out;
}

/**
 * Sequential grammar reader over a positional source. `window` is the size of
 * each buffered read; `limit` bounds how far past `start` the parser may go.
 */
export class Cursor {
  constructor(
    source,
    {
      start = 0,
      window = 1 << 20,
      limit = Infinity,
      limitCode = "METADATA_BUDGET",
    } = {},
  ) {
    this.source = source;
    this.pos = start;
    this.start = start;
    this.window = window;
    this.end = Math.min(source.size, start + limit);
    this.limited = start + limit < source.size;
    this.limitCode = limitCode;
    this.buffer = Buffer.alloc(0);
    this.bufferAt = start;
    this.taps = new Set();
  }

  check(n) {
    if (this.pos + n <= this.end) return;
    if (this.limited && this.pos + n <= this.source.size)
      throw new BudgetError(
        this.limitCode,
        "Descriptor budget reached",
        this.pos,
      );
    throw new FormatError(
      "TRUNCATED",
      "Declared structure passes the end of the file",
      this.pos,
    );
  }

  async need(n) {
    this.check(n);
    const offset = this.pos - this.bufferAt;
    if (offset >= 0 && offset + n <= this.buffer.length) return;
    // `reserve()` is a lower bound on the encoded size of structure still to
    // be parsed. Reading ahead no further than that never enters the payload.
    const ahead = this.reserve ? this.reserve() : Infinity;
    const length = Math.min(
      Math.max(n, Math.min(this.window, n + ahead)),
      this.end - this.pos,
    );
    this.buffer = await this.source.read(this.pos, length);
    this.bufferAt = this.pos;
  }

  async bytes(n) {
    let out;
    if (n > this.window) {
      this.check(n);
      out = await this.source.read(this.pos, n);
    } else {
      await this.need(n);
      const offset = this.pos - this.bufferAt;
      out = this.buffer.subarray(offset, offset + n);
    }
    this.pos += n;
    for (const tap of this.taps) tap.update(out);
    return out;
  }

  /** Advance without reading. Bytes already buffered are not reread. */
  skip(n) {
    this.check(n);
    this.pos += n;
  }

  async u8() {
    return (await this.bytes(1))[0];
  }
  async u32() {
    return (await this.bytes(4)).readUInt32LE(0);
  }
  async i32() {
    return (await this.bytes(4)).readInt32LE(0);
  }
  async u64() {
    return (await this.bytes(8)).readBigUInt64LE(0);
  }
}

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
