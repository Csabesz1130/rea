// App-owned trace producer and read-only incremental consumer. Each open creates a
// new run. Byte cursors are meaningful only within that run and file identity.
import { randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
} from "node:fs";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
const WINDOW = 256 * 1024,
  LINE = 8192;
const decode = (bytes) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const label = (s) =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 240 &&
  !/[\u0000-\u001f\u007f]/.test(s);
const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;

function event(row) {
  if (!integer(row?.seq) || !finite(row.at_ms) || !label(row.name))
    throw new Error("Invalid trace event");
  const out = {
    seq: row.seq,
    at_ms: row.at_ms,
    name: row.name,
    type: row.type,
  };
  switch (row.type) {
    case "mark":
      break;
    case "measure":
      if (!finite(row.duration_ms)) throw new Error("Invalid duration");
      out.duration_ms = row.duration_ms;
      break;
    case "resources":
      for (const k of ["user_cpu_us", "system_cpu_us", "rss_bytes"]) {
        if (!integer(row[k]))
          throw new Error("Invalid process resource measurement");
        out[k] = row[k];
      }
      break;
    default:
      throw new Error("Unknown trace event");
  }
  if (row.evidence_id != null || row.node_id != null) {
    if (!label(row.evidence_id) || !label(row.node_id))
      throw new Error("Invalid graph reference");
    out.evidence_id = row.evidence_id;
    out.node_id = row.node_id;
  }
  if (row.trace_id !== undefined || row.span_id !== undefined) {
    if (
      typeof row.trace_id !== "string" ||
      typeof row.span_id !== "string" ||
      !/^[a-f0-9]{32}$/i.test(row.trace_id) ||
      /^0+$/.test(row.trace_id) ||
      !/^[a-f0-9]{16}$/i.test(row.span_id) ||
      /^0+$/.test(row.span_id)
    )
      throw new Error("Invalid span identity");
    out.trace_id = row.trace_id;
    out.span_id = row.span_id;
  }
  return out;
}
function writeRow(fd, value) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
export function openRuntimeTrace(
  path,
  { timeOriginMs = performance.timeOrigin } = {},
) {
  const fd = openSync(path, "wx", 0o600);
  let seq = 0,
    closed = false;
  const observers = new Set();
  try {
    writeRow(fd, {
      format: "rea-runtime-v1",
      session: randomUUID(),
      time_origin_ms: timeOriginMs,
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  function emit(fields) {
    if (closed) throw new Error("Trace is closed");
    writeRow(
      fd,
      event({
        ...fields,
        seq,
        at_ms:
          fields.at_ms ??
          performance.timeOrigin + performance.now() - timeOriginMs,
      }),
    );
    seq++;
  }
  return {
    mark: (name, link) =>
      emit({
        type: "mark",
        name,
        evidence_id: link?.evidence_id,
        node_id: link?.node_id,
      }),
    measure: (name, duration_ms, link) =>
      emit({
        type: "measure",
        name,
        duration_ms,
        evidence_id: link?.evidence_id,
        node_id: link?.node_id,
      }),
    span({
      name,
      at_ms,
      duration_ms,
      trace_id,
      span_id,
      evidence_id,
      node_id,
    }) {
      emit({
        type: "measure",
        name,
        at_ms,
        duration_ms,
        trace_id,
        span_id,
        evidence_id,
        node_id,
      });
    },
    sample() {
      const cpu = process.cpuUsage();
      emit({
        type: "resources",
        name: "process",
        user_cpu_us: cpu.user,
        system_cpu_us: cpu.system,
        rss_bytes: process.memoryUsage.rss(),
      });
    },
    observePerformance() {
      if (closed) throw new Error("Trace is closed");
      const record = (entries) => {
        for (const e of entries)
          if (label(e.name))
            emit({
              type: e.entryType,
              name: e.name,
              at_ms: e.startTime + performance.timeOrigin - timeOriginMs,
              duration_ms: e.duration,
            });
      };
      const observer = new PerformanceObserver((list) =>
        record(list.getEntries()),
      );
      observer.observe({ entryTypes: ["mark", "measure"] });
      const stop = () => {
        if (observers.delete(stop)) {
          record(observer.takeRecords());
          observer.disconnect();
        }
      };
      observers.add(stop);
      return stop;
    },
    close() {
      if (closed) return;
      try {
        for (const stop of observers) stop();
      } finally {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof c.identity === "string" && integer(c.offset)) return c;
  } catch {}
  throw new Error("Invalid trace cursor");
}
function readPage(path, cursor, limit) {
  const prev = parseCursor(cursor);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Expected a regular trace file");
    const size = Number(info.size);
    const read = (offset, len) => {
      const b = Buffer.alloc(Math.min(len, Math.max(0, size - offset)));
      return b.subarray(0, readSync(fd, b, 0, b.length, offset));
    };
    const start = read(0, LINE),
      end = start.indexOf(10);
    if (end < 0) throw new Error("Incomplete trace header");
    const h = JSON.parse(decode(start.subarray(0, end)));
    if (
      h.format !== "rea-runtime-v1" ||
      !/^[0-9a-f-]{36}$/i.test(h.session) ||
      !finite(h.time_origin_ms)
    )
      throw new Error("Invalid trace header");
    const identity = `${info.dev}/${info.ino}/${h.session}`;
    const reset = Boolean(
      prev && (identity !== prev.identity || prev.offset > size),
    );
    let offset = prev && !reset ? prev.offset : end + 1;
    if (offset < end + 1 || read(offset - 1, 1)[0] !== 10)
      throw new Error("Cursor must point to a line boundary");
    const bytes = read(offset, WINDOW),
      events = [];
    let begin = 0,
      invalid = 0,
      partial = false;
    while (begin < bytes.length && events.length < limit) {
      const nl = bytes.indexOf(10, begin);
      if (nl < 0) {
        if (bytes.length - begin >= LINE)
          throw new Error("Trace row exceeds 8192 bytes");
        partial = offset + bytes.length === size;
        break;
      }
      if (nl - begin >= LINE) throw new Error("Trace row exceeds 8192 bytes");
      try {
        events.push(event(JSON.parse(decode(bytes.subarray(begin, nl)))));
      } catch {
        invalid++;
      }
      begin = nl + 1;
    }
    offset += begin;
    const next = Buffer.from(JSON.stringify({ identity, offset })).toString(
      "base64url",
    );
    return {
      session: h.session,
      time_origin_ms: h.time_origin_ms,
      events,
      cursor: next,
      reset,
      invalid,
      partial,
      more: offset < size && !partial,
    };
  } finally {
    closeSync(fd);
  }
}
export async function runtimeEvents(path, { cursor, limit, wait_ms }, signal) {
  const deadline = performance.now() + wait_ms;
  for (;;) {
    signal?.throwIfAborted();
    const page = readPage(path, cursor, limit);
    const left = deadline - performance.now();
    if (page.events.length || page.invalid || page.reset || left <= 0)
      return page;
    cursor = page.cursor;
    await delay(Math.min(100, left), undefined, { signal });
  }
}
