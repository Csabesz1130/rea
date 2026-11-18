import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { readLocal } from "../src/files.mjs";
import { features } from "../src/auth.mjs";
import { providers } from "./providers.mjs";
const fingerprint = (s) => createHash("sha256").update(s).digest("hex");
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const grantType = "urn:ietf:params:oauth:grant-type:device_code";
const scopes = features.map((f) => "rea:" + f);
const problem = (error, status = 400) => ({ status, body: { error } });

export function createIssuer(
  cfg,
  remote = providers(cfg),
  now = () => Math.floor(Date.now() / 1000),
) {
  const origin = new URL(cfg.issuer);
  if (origin.protocol !== "https:" || origin.origin !== cfg.issuer)
    throw new Error(
      "Configure the issuer as an HTTPS origin without a trailing slash",
    );
  const key = createPrivateKey(cfg.private_key);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("An Ed25519 signing key is required");
  const db = new DatabaseSync(cfg.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS devices(hash TEXT PRIMARY KEY, upstream TEXT NOT NULL, scope TEXT NOT NULL,
      expires INTEGER NOT NULL, interval INTEGER NOT NULL, next_poll INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0, subject TEXT);
    CREATE TABLE IF NOT EXISTS accounts(subject TEXT PRIMARY KEY, nonce TEXT NOT NULL, customer TEXT);
    CREATE INDEX IF NOT EXISTS expiry ON devices(expires);`);
  const one = (body) => ({ status: 200, body });
  const forget = (hash) =>
    db.prepare("DELETE FROM devices WHERE hash=?").run(hash);
  let starting = 0;
  async function handle(path, fields) {
    const t = now();
    db.prepare("DELETE FROM devices WHERE expires<=?").run(t);
    if (fields.client_id !== cfg.client_id) return problem("invalid_client");
    if (path === "/device") {
      const requested = [
        ...new Set((fields.scope ?? "").split(" ").filter(Boolean)),
      ];
      if (
        !requested.length ||
        !(
          requested.every((s) => scopes.includes(s)) ||
          requested.join(" ") === "rea:subscribe"
        )
      )
        return problem("invalid_scope");
      if (
        starting >= 16 ||
        db.prepare("SELECT COUNT(*) AS n FROM devices").get().n >= 2000
      )
        return problem("temporarily_unavailable", 503);
      starting++;
      try {
        const d = await remote.start();
        if (
          typeof d.device_code !== "string" ||
          !d.device_code ||
          typeof d.user_code !== "string" ||
          !Number.isSafeInteger(d.expires_in) ||
          d.expires_in <= 0 ||
          d.verification_uri !== "https://github.com/login/device" ||
          (d.interval !== undefined &&
            (!Number.isSafeInteger(d.interval) || d.interval < 1))
        )
          throw new Error("Invalid upstream device authorization");
        const cap = Math.min(900, d.expires_in),
          interval = Math.max(5, d.interval ?? 5),
          device = randomBytes(32).toString("base64url");
        db.prepare(
          "INSERT INTO devices(hash,upstream,scope,expires,interval,next_poll) VALUES(?,?,?,?,?,?)",
        ).run(
          fingerprint(device),
          d.device_code,
          requested.join(" "),
          t + cap,
          interval,
          t + interval,
        );
        return one({
          device_code: device,
          user_code: d.user_code,
          verification_uri: d.verification_uri,
          expires_in: cap,
          interval,
        });
      } finally {
        starting--;
      }
    }
    if (path !== "/token") return problem("not_found", 404);
    if (fields.grant_type !== grantType)
      return problem("unsupported_grant_type");
    if (
      typeof fields.device_code !== "string" ||
      fields.device_code.length !== 43
    )
      return problem("invalid_grant");
    const hash = fingerprint(fields.device_code);
    const d = db.prepare("SELECT * FROM devices WHERE hash=?").get(hash);
    if (!d || d.expires <= t) return problem("expired_token");
    if (d.lease > t) return problem("authorization_pending");
    if (t < d.next_poll) {
      db.prepare(
        "UPDATE devices SET interval=interval+5,next_poll=?+interval+5 WHERE hash=?",
      ).run(t, hash);
      return problem("slow_down");
    }
    // Compare-and-set also serializes separate issuer processes using this database.
    if (
      !db
        .prepare(
          "UPDATE devices SET lease=?,next_poll=? WHERE hash=? AND lease<=? AND next_poll<=?",
        )
        .run(t + 120, t + d.interval, hash, t, t).changes
    )
      return problem("authorization_pending");
    try {
      let subject = d.subject;
      if (!subject) {
        const g = await remote.identity(d.upstream);
        if (g.error) {
          if (g.error === "slow_down")
            db.prepare(
              "UPDATE devices SET interval=interval+5,next_poll=?+interval+5 WHERE hash=?",
            ).run(t, hash);
          else if (g.error !== "authorization_pending") forget(hash);
          return problem(
            [
              "authorization_pending",
              "slow_down",
              "access_denied",
              "expired_token",
            ].includes(g.error)
              ? g.error
              : "invalid_grant",
          );
        }
        subject = g.subject;
        if (typeof subject !== "string" || !/^\d{1,20}$/.test(subject))
          throw new Error("Invalid account identity");
        db.prepare(
          "UPDATE devices SET subject=?, upstream='' WHERE hash=?",
        ).run(subject, hash);
      }
      let account = db
        .prepare("SELECT * FROM accounts WHERE subject=?")
        .get(subject);
      const subscribe = d.scope === "rea:subscribe";
      if (subscribe && !account) {
        db.prepare(
          "INSERT OR IGNORE INTO accounts(subject,nonce) VALUES(?,?)",
        ).run(subject, randomUUID());
        account = db
          .prepare("SELECT * FROM accounts WHERE subject=?")
          .get(subject);
      }
      let customer = account?.customer;
      if (subscribe && !customer) {
        customer = await remote.customer(
          subject,
          "rea-customer-" + account.nonce,
        );
        db.prepare("UPDATE accounts SET customer=? WHERE subject=?").run(
          customer,
          subject,
        );
      }
      const active = customer && (await remote.subscribed(customer));
      if (!active && !subscribe) {
        forget(hash);
        return problem("subscription_required", 403);
      }
      if (subscribe && active) {
        forget(hash);
        return problem("already_subscribed", 409);
      }
      let body;
      if (subscribe) {
        const url = await remote.checkout(
          customer,
          subject,
          `rea-checkout-${account.nonce}-${Math.floor(t / 1800)}`,
        );
        body = { checkout_url: url };
      } else {
        const issued = now(),
          exp = issued + 3600;
        const payload =
          enc({ alg: "EdDSA", typ: "JWT" }) +
          "." +
          enc({
            iss: cfg.issuer,
            aud: "rea-pro",
            sub: "github:" + subject,
            iat: issued,
            exp,
            scope: d.scope,
          });
        body = {
          access_token:
            payload +
            "." +
            sign(null, Buffer.from(payload), key).toString("base64url"),
          token_type: "Bearer",
          expires_in: 3600,
        };
      }
      if (now() >= d.expires || !forget(hash).changes)
        return problem("expired_token");
      return one(body);
    } finally {
      db.prepare("UPDATE devices SET lease=0 WHERE hash=?").run(hash);
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "GET" && req.url === "/.well-known/rea-pro.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          issuer: cfg.issuer,
          client_id: cfg.client_id,
          public_key: createPublicKey(key).export({
            type: "spki",
            format: "pem",
          }),
          device_endpoint: cfg.issuer + "/device",
          token_endpoint: cfg.issuer + "/token",
        }),
      );
    }
    if (req.method === "GET" && ["/complete", "/cancelled"].includes(req.url)) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(
        req.url === "/complete"
          ? "Return to your terminal and run rea login."
          : "Checkout closed. Return to your terminal.",
      );
    }
    const reply = (r) => {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    };
    if (req.method !== "POST" || !["/device", "/token"].includes(req.url))
      return reply(problem("not_found", 404));
    if (
      req.headers["content-type"]?.split(";")[0] !==
      "application/x-www-form-urlencoded"
    )
      return reply(problem("invalid_request", 415));
    try {
      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > 4096) return reply(problem("invalid_request", 413));
        chunks.push(c);
      }
      reply(
        await handle(
          req.url,
          Object.fromEntries(
            new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
          ),
        ),
      );
    } catch {
      reply(problem("temporarily_unavailable", 503));
    }
  });
  server.requestTimeout = 15000;
  server.on("close", () => db.close());
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.umask(0o077);
  const cfg = JSON.parse(readLocal(process.env.REA_ISSUER_CONFIG, 65536).text);
  if (cfg.private_key_file)
    cfg.private_key = readLocal(cfg.private_key_file, 16384).text;
  for (const name of [
    "client_id",
    "github_client_id",
    "stripe_key",
    "price_id",
    "database",
    "private_key",
    "issuer",
  ])
    if (typeof cfg[name] !== "string" || !cfg[name])
      throw new Error("Missing issuer setting " + name);
  createIssuer(cfg).listen(cfg.port ?? 8787, "127.0.0.1");
}
