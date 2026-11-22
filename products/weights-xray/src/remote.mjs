// Revision-pinned model files read with bounded HTTPS byte ranges. Each
// response must be a 206 for exactly the requested range of one strong
// validator; anything else aborts before its body is read.
// https://www.rfc-editor.org/rfc/rfc9110.html
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { BudgetError, FormatError } from "./errors.mjs";
import { mergeRanges } from "./source.mjs";

export const REMOTE_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  requests: 256,
  receivedBytes: 16 * 1024 * 1024,
  requestTimeoutMs: 10_000,
  wallClockMs: 60_000,
  redirects: 3,
});

const hfHost = (host) =>
  host === "huggingface.co" ||
  host.endsWith(".huggingface.co") ||
  host === "hf.co" ||
  host.endsWith(".hf.co");
/** Hugging Face and its CDN hosts over HTTPS, resolving to public addresses only. */
export const HUGGING_FACE = Object.freeze({
  protocols: ["https:"],
  permitHost: hfHost,
  publicAddressesOnly: true,
});

/** A failed remote read, with the HTTP status when there was one. */
export class RemoteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// Separate lists: a BlockList checks IPv4 addresses against IPv4-mapped IPv6
// rules too, so one list holding ::ffff:0:0/96 would reject every IPv4 address.
const nonPublic4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  nonPublic4.addSubnet(net, prefix, "ipv4");
const nonPublic6 = new BlockList();
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
])
  nonPublic6.addSubnet(net, prefix, "ipv6");

/** True when an address is globally routable unicast. IPv4-mapped forms are checked as IPv4. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !nonPublic4.check(mapped[1], "ipv4");
  return family === 4
    ? !nonPublic4.check(address, "ipv4")
    : !nonPublic6.check(address, "ipv6");
}

// Validate the addresses the connection will use, at connection time, so a
// name cannot resolve to a public address for the check and a private one after.
const lookupFor = (policy) => (hostname, options, callback) =>
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (policy.publicAddressesOnly) {
      const bad = addresses.find((a) => !isPublicAddress(a.address));
      if (bad)
        return callback(
          new RemoteError(
            "ADDRESS_NOT_PUBLIC",
            `${hostname} resolves to ${bad.address}, which is not a public address`,
          ),
        );
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });

/** Parse https://huggingface.co/OWNER/REPO/resolve/COMMIT/PATH, requiring a full commit. */
export function parseResolveUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RemoteError("URL_INVALID", "Not a URL");
  }
  const m =
    /^\/((?:datasets\/)?[\w.-]+\/[\w.-]+)\/resolve\/([^/]+)\/(.+)$/.exec(
      url.pathname,
    );
  if (!m)
    throw new RemoteError(
      "URL_INVALID",
      "Expected https://huggingface.co/OWNER/REPO/resolve/COMMIT/PATH",
    );
  if (!/^[0-9a-f]{40}$/.test(m[2]))
    throw new RemoteError(
      "REVISION_NOT_PINNED",
      `Revision ${JSON.stringify(m[2])} is not a 40-character commit; pin the commit so every read names the same files`,
    );
  if (url.search || url.hash || url.username || url.password)
    throw new RemoteError(
      "URL_INVALID",
      "Remove credentials, query and fragment from the URL",
    );
  const path = decodeURIComponent(m[3]);
  if (path.split("/").some((p) => !p || p === "." || p === ".."))
    throw new RemoteError(
      "URL_INVALID",
      "Model path has an empty, '.' or '..' segment",
    );
  return { origin: url.origin, repo: m[1], commit: m[2], path, url: url.href };
}

/** Shared request, byte and time budgets for one remote inspection, across shards. */
export class RemoteSession {
  constructor({
    limits = REMOTE_LIMITS,
    policy = HUGGING_FACE,
    token,
    signal,
  } = {}) {
    this.limits = { ...REMOTE_LIMITS, ...limits };
    this.policy = policy;
    this.token = token;
    this.signal = signal;
    this.started = Date.now();
    this.requests = 0;
    this.received = 0;
    this.redirects = 0;
    // [requested start, requested end, returned start, returned end], no URLs.
    this.exchanges = [];
    this.lookup = lookupFor(policy);
  }

  permitted(url) {
    if (!this.policy.protocols.includes(url.protocol))
      throw new RemoteError(
        "PROTOCOL_NOT_PERMITTED",
        `${url.protocol} is not permitted`,
      );
    if (!this.policy.permitHost(url.hostname))
      throw new RemoteError(
        "HOST_NOT_PERMITTED",
        `${url.hostname} is not a permitted host`,
      );
  }

  budget(length) {
    const elapsed = Date.now() - this.started;
    if (this.requests >= this.limits.requests)
      throw new BudgetError(
        "REMOTE_REQUEST_BUDGET",
        `Reached ${this.limits.requests} requests`,
      );
    if (this.received + length > this.limits.receivedBytes)
      throw new BudgetError(
        "REMOTE_BYTES_BUDGET",
        `Reading ${length} more bytes would pass ${this.limits.receivedBytes}`,
      );
    if (elapsed >= this.limits.wallClockMs)
      throw new BudgetError(
        "REMOTE_TIME_BUDGET",
        `Reached the ${this.limits.wallClockMs} ms budget`,
      );
    return this.limits.wallClockMs - elapsed;
  }

  /**
   * GET one range, following up to `redirects` permitted redirects. Returns
   * the body, the validated range and the URL that served it.
   */
  async range(url, start, end, { origin, ifMatch }) {
    let target = new URL(url);
    for (let hop = 0; ; hop++) {
      this.permitted(target);
      const remaining = this.budget(end - start + 1);
      this.requests++;
      const timeout = Math.min(this.limits.requestTimeoutMs, remaining);
      const response = await this.get(target, start, end, {
        ifMatch,
        timeout,
        auth: this.token && target.origin === origin,
      });
      if (response.redirect) {
        if (hop >= this.limits.redirects)
          throw new RemoteError(
            "TOO_MANY_REDIRECTS",
            `More than ${this.limits.redirects} redirects`,
          );
        this.redirects++;
        target = new URL(response.redirect, target);
        continue;
      }
      this.exchanges.push([start, end, response.start, response.end]);
      return { ...response, url: target.href };
    }
  }

  get(target, start, end, { ifMatch, timeout, auth }) {
    const signals = [
      AbortSignal.timeout(timeout),
      ...(this.signal ? [this.signal] : []),
    ];
    const signal = AbortSignal.any(signals);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = {
      Range: `bytes=${start}-${end}`,
      "Accept-Encoding": "identity",
      "User-Agent": "rea-weights-xray",
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
      ...(auth ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        req.destroy();
        reject(error);
      };
      const req = send(
        target,
        { method: "GET", headers, lookup: this.lookup, signal },
        (res) => {
          const status = res.statusCode;
          const header = (name) => res.headers[name];
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = header("location");
            res.destroy();
            if (!location)
              return reject(
                new RemoteError(
                  "REDIRECT_INVALID",
                  "Redirect without a Location",
                  status,
                ),
              );
            return resolve({ redirect: location });
          }
          // Reject before reading a body that is not exactly the requested range.
          if (status === 200)
            return fail(
              new RemoteError(
                "RANGE_IGNORED",
                "The server ignored the Range request and began a full response",
                status,
              ),
            );
          if (status === 412)
            return fail(
              new RemoteError(
                "IDENTITY_CHANGED",
                "The file changed since the first range (If-Match failed)",
                status,
              ),
            );
          if (status === 416)
            return fail(
              new RemoteError(
                "RANGE_NOT_SATISFIABLE",
                "The server cannot satisfy the requested range",
                status,
              ),
            );
          if (status !== 206)
            return fail(
              new RemoteError(
                status === 404 ? "NOT_FOUND" : "HTTP_STATUS",
                `HTTP ${status}`,
                status,
              ),
            );
          const encoding = header("content-encoding");
          if (encoding && encoding !== "identity")
            return fail(
              new RemoteError(
                "ENCODED_RESPONSE",
                `Content-Encoding ${encoding}`,
                status,
              ),
            );
          const etag = header("etag");
          if (!etag)
            return fail(
              new RemoteError(
                "VALIDATOR_MISSING",
                "The response has no ETag to bind later ranges to",
                status,
              ),
            );
          if (etag.startsWith("W/"))
            return fail(
              new RemoteError(
                "VALIDATOR_WEAK",
                "The response has only a weak ETag",
                status,
              ),
            );
          const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            header("content-range") ?? "",
          );
          if (!m)
            return fail(
              new RemoteError(
                "RANGE_MISMATCH",
                "Missing or unparsable Content-Range",
                status,
              ),
            );
          const [s, e, total] = m.slice(1).map(Number);
          const length = Number(header("content-length"));
          if (
            s !== start ||
            (e !== end && !(e === total - 1 && end > e)) ||
            length !== e - s + 1
          )
            return fail(
              new RemoteError(
                "RANGE_MISMATCH",
                `Asked for ${start}-${end}; got ${header("content-range")} with length ${header("content-length")}`,
                status,
              ),
            );
          const chunks = [];
          let received = 0;
          res.on("data", (chunk) => {
            received += chunk.length;
            this.received += chunk.length;
            if (received > length)
              fail(
                new RemoteError(
                  "RANGE_MISMATCH",
                  "Body is longer than its Content-Length",
                  status,
                ),
              );
            else chunks.push(chunk);
          });
          res.on("end", () => {
            if (received !== length)
              return reject(
                new RemoteError(
                  "RANGE_MISMATCH",
                  "Body ended before its Content-Length",
                  status,
                ),
              );
            resolve({
              body: Buffer.concat(chunks),
              start: s,
              end: e,
              total,
              etag,
            });
          });
          res.on("error", reject);
        },
      );
      req.on("error", (error) =>
        reject(
          error.name === "AbortError" || error.code === "ABORT_ERR"
            ? this.signal?.aborted
              ? error
              : new RemoteError(
                  "REMOTE_TIMEOUT",
                  `No complete response within ${timeout} ms`,
                )
            : error,
        ),
      );
      req.end();
    });
  }

  usage() {
    return {
      requests: this.requests,
      received_bytes: this.received,
      redirects: this.redirects,
      wall_ms: Date.now() - this.started,
      exchanges: this.exchanges,
    };
  }
}

/** A remote file with the positional-read interface the format readers use. */
export class RemoteSource {
  /** Open with a first request for the 9 bytes that identify every supported format. */
  static async open(session, url) {
    const target = parseResolveUrl(url);
    const source = new RemoteSource(session, target);
    const first = await session.range(target.url, 0, 8, {
      origin: target.origin,
    });
    source.size = first.total;
    source.etag = first.etag;
    source.served = first.url;
    source.cache = { at: 0, bytes: first.body };
    source.record(0, first.body.length);
    return source;
  }

  constructor(session, target) {
    this.session = session;
    this.target = target;
    this.name = target.path.split("/").at(-1);
    this.ranges = [];
    this.requests = 0;
    this.bytes = 0;
  }

  record(start, length) {
    this.requests++;
    this.bytes += length;
    this.ranges.push([start, start + length]);
  }

  async read(position, length) {
    if (position + length > this.size)
      throw new FormatError(
        "TRUNCATED",
        `Read of ${length} bytes at ${position} passes the end of the file`,
        position,
      );
    const { at, bytes } = this.cache;
    if (position >= at && position + length <= at + bytes.length)
      return bytes.subarray(position - at, position - at + length);
    const parts = [];
    for (let done = 0; done < length;) {
      const n = Math.min(this.session.limits.requestBytes, length - done);
      const start = position + done;
      // Later ranges go to the URL that served the first one, bound to its validator.
      const r = await this.session.range(this.served, start, start + n - 1, {
        origin: this.target.origin,
        ifMatch: this.etag,
      });
      if (r.etag !== this.etag)
        throw new RemoteError(
          "IDENTITY_CHANGED",
          "The validator changed between ranges",
        );
      if (r.total !== this.size)
        throw new RemoteError(
          "IDENTITY_CHANGED",
          "The file length changed between ranges",
        );
      this.record(start, n);
      parts.push(r.body);
      done += n;
    }
    const out = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    this.cache = { at: position, bytes: out };
    return out;
  }

  /** Every range was bound to the first validator with If-Match; nothing else to check. */
  async verify() {}

  usage() {
    return {
      requests: this.requests,
      bytes_read: this.bytes,
      ranges: mergeRanges(this.ranges),
    };
  }

  /** The identity a report may cite: never the signed CDN URL or a token. */
  provenance() {
    return {
      url: `${this.target.origin}/${this.target.repo}/resolve/${this.target.commit}/${this.target.path.split("/").map(encodeURIComponent).join("/")}`,
      repo: this.target.repo,
      commit: this.target.commit,
      path: this.target.path,
      validator: this.etag,
    };
  }

  sibling(name) {
    const dir = this.target.path.includes("/")
      ? this.target.path.slice(0, this.target.path.lastIndexOf("/") + 1)
      : "";
    return `${this.target.origin}/${this.target.repo}/resolve/${this.target.commit}/${(dir + name).split("/").map(encodeURIComponent).join("/")}`;
  }

  async close() {}
}
