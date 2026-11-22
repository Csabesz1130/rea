import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectFile, inspectRemote } from "../src/inspect.mjs";
import {
  RemoteError,
  isPublicAddress,
  parseResolveUrl,
} from "../src/remote.mjs";

// A loopback server whose behavior is chosen by the repository owner in the
// path: http://127.0.0.1:PORT/MODE/repo/resolve/COMMIT/FILE.
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const seen = [];
let server;
let base;
const full = Buffer.alloc(8 << 20, 7);
let fullWritten = 0;

function serve(req, res) {
  const url = new URL(req.url, "http://x");
  const [, mode, , , , ...rest] = url.pathname.split("/");
  const file = decodeURIComponent(rest.join("/"));
  seen.push({
    mode,
    file,
    range: req.headers.range,
    ifMatch: req.headers["if-match"],
    auth: req.headers.authorization,
    host: req.headers.host,
  });
  const redirect = (to) => {
    res.writeHead(302, { Location: to });
    res.end();
  };
  if (mode === "redirect")
    return redirect(
      `/ok/repo/resolve/${COMMIT}/${rest.join("/")}?signature=SECRET-SIGNATURE`,
    );
  if (mode === "crossorigin")
    return redirect(
      `http://localhost:${server.address().port}/ok/repo/resolve/${COMMIT}/${rest.join("/")}`,
    );
  if (mode === "loop") return redirect(req.url);
  if (mode === "offhost") return redirect("http://example.invalid/x");
  if (mode === "full") {
    res.writeHead(200, { "Content-Length": full.length, ETag: '"full"' });
    const pump = () => {
      while (fullWritten < full.length) {
        const ok = res.write(full.subarray(fullWritten, fullWritten + 65536));
        fullWritten += 65536;
        if (!ok) return res.once("drain", pump);
      }
      res.end();
    };
    res.on("close", () => {});
    return pump();
  }
  let bytes;
  try {
    bytes = readFileSync(join(fixtures, file));
  } catch {
    res.writeHead(404);
    return res.end();
  }
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(400);
    return res.end();
  }
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), bytes.length - 1);
  const requests = seen.filter(
    (s) => s.mode === mode && s.file === file,
  ).length;
  let etag = '"v1"';
  if (mode === "change" || mode === "change412")
    etag = requests > 1 ? '"v2"' : '"v1"';
  if (
    mode === "change412" &&
    req.headers["if-match"] &&
    req.headers["if-match"] !== etag
  ) {
    res.writeHead(412);
    return res.end();
  }
  const headers = {
    "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
    "Content-Length": end - start + 1,
  };
  if (mode !== "noetag") headers.ETag = mode === "weak" ? 'W/"v1"' : etag;
  if (mode === "badrange")
    headers["Content-Range"] = `bytes ${start + 1}-${end}/${bytes.length}`;
  if (mode === "encoded") headers["Content-Encoding"] = "gzip";
  if (mode === "short") headers["Content-Length"] = end - start + 2;
  const send = () => {
    res.writeHead(206, headers);
    res.end(bytes.subarray(start, end + 1));
  };
  if (mode === "slow") return setTimeout(send, 600);
  send();
}

before(async () => {
  server = createServer(serve);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const loopback = {
  protocols: ["http:"],
  permitHost: (h) => h === "127.0.0.1" || h === "localhost",
  publicAddressesOnly: false,
};
const url = (mode, file) => `${base}/${mode}/repo/resolve/${COMMIT}/${file}`;
const remote = (mode, file, options = {}) =>
  inspectRemote(url(mode, file), {
    ...options,
    remote: { policy: loopback, ...(options.remote ?? {}) },
  });
const strip = (r) =>
  r.tensors.map(
    ({ name, dtype, type, shape, bytes, descriptor, file_range, shard }) => ({
      name,
      dtype,
      type,
      shape,
      bytes,
      descriptor,
      file_range,
      shard,
    }),
  );

test("remote inventories equal local ones, read no payload and stay under the Studio payload cap", async () => {
  for (const file of [
    "pair-base.safetensors",
    "tiny-llama.gguf",
    "sharded/model.safetensors.index.json",
  ]) {
    const local = await inspectFile(join(fixtures, file));
    const r = await remote("ok", file);
    assert.ok(
      r.complete && r.valid,
      `${file}: ${JSON.stringify(r.incomplete ?? r.issues)}`,
    );
    assert.deepEqual(strip(r), strip(local), file);
    assert.equal(r.reads.payload_bytes_read, 0, file);
    assert.ok(r.reads.payload_bytes_read < 262144);
    assert.ok(r.remote.requests <= 256);
    assert.equal(r.source.commit, COMMIT);
    assert.equal(r.source.validator, '"v1"');
  }
  // Every range after the first is bound to the first validator.
  const later = seen.filter((s) => s.mode === "ok" && s.range !== "bytes=0-8");
  assert.ok(later.length > 0 && later.every((s) => s.ifMatch === '"v1"'));
  assert.ok(
    seen
      .filter((s) => s.mode === "ok")
      .every((s) => /^bytes=\d+-\d+$/.test(s.range)),
  );
  const largest = Math.max(
    ...seen.map((s) =>
      s.range
        ? Number(s.range.split("-")[1]) -
          Number(s.range.slice(6).split("-")[0]) +
          1
        : 0,
    ),
  );
  assert.ok(largest <= 65536, `largest range ${largest}`);
});

test("redirects are followed within limits, credentials stay with their origin and signed URLs are not reported", async () => {
  const r = await remote("redirect", "pair-base.safetensors", {
    remote: { token: "hf_secret_token" },
  });
  assert.ok(r.complete);
  assert.equal(r.remote.redirects, 1);
  assert.doesNotMatch(JSON.stringify(r), /SECRET-SIGNATURE|hf_secret_token/);
  seen.length = 0;
  const cross = await remote("crossorigin", "pair-base.safetensors", {
    remote: { token: "hf_secret_token" },
  });
  assert.ok(cross.complete);
  const first = seen.find((s) => s.mode === "crossorigin");
  const moved = seen.filter(
    (s) => s.mode === "ok" && s.host.startsWith("localhost"),
  );
  assert.equal(first.auth, "Bearer hf_secret_token");
  assert.ok(moved.length > 0 && moved.every((s) => s.auth === undefined));

  assert.equal(
    (await remote("loop", "pair-base.safetensors")).incomplete.reason,
    "TOO_MANY_REDIRECTS",
  );
  assert.equal(seen.filter((s) => s.mode === "loop").length, 4);
  assert.equal(
    (await remote("offhost", "pair-base.safetensors")).incomplete.reason,
    "HOST_NOT_PERMITTED",
  );
});

test("an ignored range is abandoned before its body is read", async () => {
  fullWritten = 0;
  const r = await remote("full", "pair-base.safetensors");
  assert.equal(r.incomplete.reason, "RANGE_IGNORED");
  assert.equal(r.remote.received_bytes, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    fullWritten < full.length,
    `server wrote ${fullWritten} of ${full.length} bytes`,
  );
});

test("missing, weak or changing validators and malformed ranges stop the inspection", async () => {
  const reason = async (mode, file = "pair-base.safetensors", options) =>
    (await remote(mode, file, options)).incomplete?.reason;
  assert.equal(await reason("noetag"), "VALIDATOR_MISSING");
  assert.equal(await reason("weak"), "VALIDATOR_WEAK");
  assert.equal(await reason("change"), "IDENTITY_CHANGED");
  assert.equal(await reason("change412"), "IDENTITY_CHANGED");
  assert.equal(await reason("badrange"), "RANGE_MISMATCH");
  assert.equal(await reason("short"), "RANGE_MISMATCH");
  assert.equal(await reason("encoded"), "ENCODED_RESPONSE");
  assert.equal(await reason("ok", "absent.safetensors"), "NOT_FOUND");
  assert.equal(
    await reason("slow", "pair-base.safetensors", {
      remote: { limits: { requestTimeoutMs: 200 } },
    }),
    "REMOTE_TIMEOUT",
  );
});

test("request and byte budgets return partial coverage with the last verified descriptor", async () => {
  const capped = await remote("ok", "tiny-llama.gguf", {
    remote: { limits: { requests: 4 } },
  });
  assert.deepEqual(
    [capped.complete, capped.incomplete.reason],
    [false, "REMOTE_REQUEST_BUDGET"],
  );
  assert.ok(capped.incomplete.last_verified);
  assert.equal(capped.remote.requests, 4);
  const bytes = await remote("ok", "pair-base.safetensors", {
    remote: { limits: { receivedBytes: 100 } },
  });
  assert.equal(bytes.incomplete.reason, "REMOTE_BYTES_BUDGET");

  const index = await remote("ok", "sharded/model.safetensors.index.json", {
    remote: { limits: { requests: 3 } },
  });
  assert.equal(index.complete, false);
});

test("only pinned Hugging Face resolve URLs over public addresses are accepted", () => {
  assert.throws(
    () =>
      parseResolveUrl(
        "https://huggingface.co/org/model/resolve/main/model.safetensors",
      ),
    (e) => e instanceof RemoteError && e.code === "REVISION_NOT_PINNED",
  );
  assert.throws(
    () =>
      parseResolveUrl(
        `https://huggingface.co/org/model/resolve/${COMMIT}/../x`,
      ),
    (e) => e.code === "URL_INVALID",
  );
  assert.throws(
    () =>
      parseResolveUrl(
        `https://user:pw@huggingface.co/org/model/resolve/${COMMIT}/x`,
      ),
    (e) => e.code === "URL_INVALID",
  );
  assert.deepEqual(
    parseResolveUrl(
      `https://huggingface.co/org/model/resolve/${COMMIT}/sub/model.gguf`,
    ),
    {
      origin: "https://huggingface.co",
      repo: "org/model",
      commit: COMMIT,
      path: "sub/model.gguf",
      url: `https://huggingface.co/org/model/resolve/${COMMIT}/sub/model.gguf`,
    },
  );
  for (const a of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
  ])
    assert.equal(isPublicAddress(a), false, a);
  for (const a of [
    "8.8.8.8",
    "52.222.136.92",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])
    assert.equal(isPublicAddress(a), true, a);
});
