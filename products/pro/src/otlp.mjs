import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { openRuntimeTrace } from "./runtime.mjs";
const digest = (value) => createHash("sha256").update(value).digest();
const ns = (value) => {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Invalid timestamp");
  if (!/^\d{1,20}$/.test(value)) throw new Error("Invalid timestamp");
  const n = BigInt(value);
  if (n > 18446744073709551615n) throw new Error("Invalid timestamp");
  return n;
};
function exportSpans(body, writer) {
  const groups = body?.resourceSpans ?? [];
  if (!Array.isArray(groups)) throw new Error("Invalid resourceSpans");
  // Validate the envelope before appending any events so malformed envelopes can be retried.
  const batches = [];
  for (const group of groups) {
    if (!Array.isArray(group.scopeSpans ?? []))
      throw new Error("Invalid scopeSpans");
    for (const scope of group.scopeSpans ?? []) {
      if (!Array.isArray(scope.spans ?? [])) throw new Error("Invalid spans");
      batches.push(scope.spans ?? []);
    }
  }
  let rejected = 0;
  for (const spans of batches)
    for (const s of spans) {
      try {
        const start = ns(s.startTimeUnixNano),
          end = ns(s.endTimeUnixNano);
        if (end < start || !s.traceId || !s.spanId)
          throw new Error("Invalid span");
        const link = {};
        for (const a of s.attributes ?? []) {
          if (a.key === "rea.evidence_id")
            link.evidence_id = a.value?.stringValue;
          if (a.key === "rea.node_id") link.node_id = a.value?.stringValue;
        }
        writer.span({
          name: s.name,
          at_ms: Number(start) / 1e6,
          duration_ms: Number(end - start) / 1e6,
          trace_id: s.traceId,
          span_id: s.spanId,
          ...link,
        });
      } catch (error) {
        if (error.code) throw error;
        rejected++;
      }
    }
  return rejected
    ? {
        partialSuccess: {
          rejectedSpans: String(rejected),
          errorMessage: "Invalid span, time, name or graph reference",
        },
      }
    : {};
}
export async function startCollector(path, port, token, authorize) {
  if (typeof token !== "string" || token.length < 16)
    throw new Error(
      "Set REA_PRO_OTLP_TOKEN to a bearer secret of at least 16 characters",
    );
  const expected = digest("Bearer " + token);
  let writer,
    active = 0;
  const server = createServer(async (req, res) => {
    const reply = (status, result) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result));
    };
    if (req.method !== "POST" || req.url !== "/v1/traces")
      return reply(404, { message: "Unknown endpoint" });
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? "")))
      return reply(401, { message: "Invalid bearer" });
    if (
      req.headers["content-type"]?.split(";")[0] !== "application/json" ||
      !["identity", undefined].includes(req.headers["content-encoding"])
    )
      return reply(415, { message: "Use uncompressed OTLP/HTTP JSON" });
    if (active >= 8) return reply(429, { message: "Collector is busy" });
    try {
      authorize();
    } catch {
      return reply(403, { message: "Runtime entitlement required" });
    }
    active++;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024)
          return reply(413, { message: "Batch exceeds 1 MiB" });
        chunks.push(chunk);
      }
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid span export");
      reply(200, exportSpans(body, writer));
    } catch (error) {
      reply(error.code ? 500 : 400, {
        message: error.code
          ? "Could not persist events"
          : "Invalid span export",
      });
    } finally {
      active--;
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    writer = openRuntimeTrace(path, { timeOriginMs: 0 });
  } catch (error) {
    server.close();
    throw error;
  }
  server.once("close", () => writer.close());
  return server;
}
