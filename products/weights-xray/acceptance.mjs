// Live acceptance run for revision-pinned remote inspection. It reads public
// Hugging Face files only, records what each run cost, and asserts the Studio
// limit of fewer than 262,144 payload bytes in total. Not part of CI.
//   node products/weights-xray/acceptance.mjs URL...
import { inspectRemote } from "./src/inspect.mjs";
import { parseResolveUrl } from "./src/remote.mjs";

const PAYLOAD_LIMIT = 262144;
const urls = process.argv.slice(2);
if (!urls.length)
  throw new Error("Usage: node acceptance.mjs PINNED_RESOLVE_URL...");
const records = [];
let payload = 0;
for (const url of urls) {
  const { repo, commit } = parseResolveUrl(url);
  // License as the hub reports it for the pinned commit; one request outside the read budget.
  const info = await (
    await fetch(`https://huggingface.co/api/models/${repo}/revision/${commit}`)
  ).json();
  const started = new Date().toISOString();
  const report = await inspectRemote(url);
  const shards = report.shards ?? [];
  payload += report.reads.payload_bytes_read;
  records.push({
    started,
    url: report.source?.url ?? url,
    license:
      info.cardData?.license ??
      info.tags?.find((t) => t.startsWith("license:"))?.slice(8) ??
      null,
    commit,
    format: report.format,
    declared_file_size: report.file.size,
    ...(shards.length
      ? {
          shard_sizes: shards.map((s) => s.size),
          declared_total_size: report.declared_total_size,
        }
      : {}),
    validator: report.source?.validator,
    complete: report.complete,
    valid: report.valid,
    tensors: report.tensor_count,
    requests: report.remote.requests,
    redirects: report.remote.redirects,
    received_bytes: report.remote.received_bytes,
    payload_bytes_read: report.reads.payload_bytes_read,
    wall_ms: report.remote.wall_ms,
    exchanges: report.remote.exchanges,
    ...(report.incomplete ? { incomplete: report.incomplete.reason } : {}),
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      payload_bytes_total: payload,
      payload_limit: PAYLOAD_LIMIT,
      records,
    },
    null,
    1,
  ),
);
if (payload >= PAYLOAD_LIMIT || records.some((r) => !r.complete))
  process.exitCode = 1;
