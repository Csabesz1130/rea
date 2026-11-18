import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js";
import { providers } from "../issuer/providers.mjs";
import { createIssuer } from "../issuer/server.mjs";
import { login, account } from "../src/auth.mjs";
import { startCollector } from "../src/otlp.mjs";
import { runtimeEvents } from "../src/runtime.mjs";
import { extractMember } from "../src/archive.mjs";
const tmp = mkdtempSync(join(tmpdir(), "rea-pro-services-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("device approval, hosted Checkout, live subscription gating, signed login and one-time exchange", async () => {
  const keys = generateKeyPairSync("ed25519"),
    origin = "https://issuer.test",
    client_id = "rea-cli";
  let time = Math.floor(Date.now() / 1000),
    active = false,
    pending = false,
    created = 0,
    checkout = 0;
  const cfg = {
    issuer: origin,
    client_id,
    database: join(tmp, "issuer.sqlite"),
    private_key: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
  };
  const remote = {
    start: async () => ({
      device_code: "upstream-secret",
      user_code: "TEST-1234",
      verification_uri: "https://github.com/login/device",
      interval: 5,
      expires_in: 600,
    }),
    identity: async (code) => {
      assert.equal(code, "upstream-secret");
      if (pending) {
        pending = false;
        return { error: "authorization_pending" };
      }
      return { subject: "12345" };
    },
    customer: async (subject, key) => {
      assert.equal(subject, "12345");
      assert.match(key, /^rea-customer-/);
      created++;
      return "cus_demo";
    },
    subscribed: async (c) => {
      assert.equal(c, "cus_demo");
      return active;
    },
    checkout: async (c, sub, key) => {
      assert.equal(c, "cus_demo");
      assert.equal(sub, "12345");
      assert.match(key, /^rea-checkout-/);
      checkout++;
      return "https://checkout.stripe.com/c/test-session";
    },
  };
  const server = createIssuer(cfg, remote, () => time);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  let lastPoll, device;
  process.env.REA_PRO_HOME = join(tmp, "profile");
  process.env.REA_PRO_CONFIG = join(tmp, "issuer.json");
  writeFileSync(
    process.env.REA_PRO_CONFIG,
    JSON.stringify({
      issuer: origin,
      public_key: keys.publicKey.export({ format: "pem", type: "spki" }),
      client_id,
      device_endpoint: origin + "/device",
      token_endpoint: origin + "/token",
    }),
  );
  const options = {
    request: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/token") lastPoll = init;
      const response = await fetch(base + path, init);
      if (path === "/device") device = await response.clone().json();
      return response;
    },
    sleep: async (ms) => {
      time += ms / 1000;
    },
    notify: (s) => {
      assert.match(s, /TEST-1234/);
      assert.doesNotMatch(s, /upstream-secret/);
    },
  };
  try {
    const advertised = await (
      await fetch(base + "/.well-known/rea-pro.json")
    ).json();
    assert.ok(advertised.public_key.includes("BEGIN PUBLIC KEY"));
    assert.equal(advertised.issuer, origin);
    await assert.rejects(login(options), /active subscription/);
    assert.equal(created, 0);
    assert.equal(checkout, 0);
    assert.deepEqual(await login({ ...options, subscribe: true }), {
      checkout_url: "https://checkout.stripe.com/c/test-session",
    });
    assert.notEqual(device.device_code, "upstream-secret");
    assert.equal(checkout, 1);
    active = true;
    pending = true;
    assert.deepEqual((await login(options)).features, [
      "graph",
      "runtime",
      "recovery",
    ]);
    assert.equal(account("runtime").subject, "github:12345");
    assert.equal(
      (await (await fetch(base + "/token", lastPoll)).json()).error,
      "expired_token",
    );
    await assert.rejects(
      login({ ...options, subscribe: true }),
      /Subscription is active/,
    );
    assert.equal(checkout, 1);
    const form = (path, params) =>
      fetch(base + path, {
        method: "POST",
        body: new URLSearchParams(params),
      }).then((r) => r.json());
    assert.equal(
      (await form("/device", { client_id, scope: "admin" })).error,
      "invalid_scope",
    );
    const initial = await form("/device", { client_id, scope: "rea:graph" });
    const req = {
      client_id,
      device_code: initial.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    };
    assert.equal((await form("/token", req)).error, "slow_down");
    time += 700;
    assert.equal((await form("/token", req)).error, "expired_token");
  } finally {
    await close(server);
  }
});

test("OTLP/HTTP collector appends validated spans with exact durations and no payload attributes", async () => {
  const file = join(tmp, "otel.ndjson"),
    secret = "selected-app-only-test";
  const server = await startCollector(file, 0, secret, () => {});
  const url = "http://127.0.0.1:" + server.address().port + "/v1/traces";
  const span = {
    traceId: "12".repeat(16),
    spanId: "34".repeat(8),
    name: "editor.paint",
    startTimeUnixNano: "1710000000000000000",
    endTimeUnixNano: "1710000000012500000",
    attributes: [
      { key: "unused", value: { stringValue: "discarded-field" } },
      { key: "rea.evidence_id", value: { stringValue: "example" } },
      { key: "rea.node_id", value: { stringValue: "n1" } },
    ],
  };
  const send = (token, body) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await send("other", {})).status, 401);
    const response = await send(secret, {
      resourceSpans: [
        {
          scopeSpans: [{ spans: [span, { ...span, traceId: "0".repeat(32) }] }],
        },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).partialSuccess.rejectedSpans, "1");
    const page = await runtimeEvents(file, { limit: 5, wait_ms: 0 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].duration_ms, 12.5);
    assert.equal(page.events[0].trace_id, span.traceId);
    assert.equal(page.events[0].node_id, "n1");
    assert.equal(page.time_origin_ms + page.events[0].at_ms, 1710000000000);
    assert.doesNotMatch(readFileSync(file, "utf8"), /discarded-field/);
    assert.equal((await send(secret, { resourceSpans: {} })).status, 400);
  } finally {
    await close(server);
  }
});
test("ordinary ZIP member extraction preserves bytes and existing outputs", async () => {
  const zip = join(tmp, "build.apk"),
    out = join(tmp, "mapped.txt");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("assets/build.txt", new TextReader("first-party build"));
  writeFileSync(zip, await writer.close());
  const r = await extractMember(zip, "assets/build.txt", out);
  assert.equal(r.bytes, 17);
  assert.equal(readFileSync(out, "utf8"), "first-party build");
  await assert.rejects(extractMember(zip, "assets/build.txt", out), /EEXIST/);
});

test("provider requests bind the GitHub identity, Stripe customer and configured recurring price", async () => {
  const seen = [];
  const request = async (url, init) => {
    seen.push({ url: new URL(url), ...init });
    const u = new URL(url);
    if (u.pathname === "/login/device/code")
      return Response.json({ user_code: "ABCD" });
    if (u.pathname === "/login/oauth/access_token")
      return Response.json({ access_token: "github-test-token" });
    if (u.pathname === "/user") return Response.json({ id: 42 });
    if (u.pathname === "/v1/customers") return Response.json({ id: "cus_xyz" });
    if (u.pathname === "/v1/subscriptions")
      return Response.json({
        data: u.searchParams.get("status") === "trialing" ? [{}] : [],
      });
    if (u.pathname === "/v1/checkout/sessions")
      return Response.json({ url: "https://checkout.stripe.com/c/session" });
    throw new Error("unexpected provider request");
  };
  const p = providers(
    {
      github_client_id: "gh-app",
      stripe_key: "stripe-test",
      price_id: "price_123",
      issuer: "https://issuer.test",
    },
    request,
  );
  await p.start();
  assert.deepEqual(await p.identity("device-code"), { subject: "42" });
  assert.equal(await p.customer("42", "stable-customer"), "cus_xyz");
  assert.ok(await p.subscribed("cus_xyz"));
  await p.checkout("cus_xyz", "42", "stable-checkout");
  assert.equal(seen[0].body.get("client_id"), "gh-app");
  assert.equal(seen[1].body.get("device_code"), "device-code");
  assert.equal(seen[2].headers.Authorization, "Bearer github-test-token");
  assert.equal(seen[3].headers["Idempotency-Key"], "stable-customer");
  for (const h of seen.slice(3)) {
    assert.equal(h.url.hostname, "api.stripe.com");
    assert.equal(h.headers.Authorization, "Bearer stripe-test");
    assert.equal(h.redirect, "error");
  }
  for (const h of seen.filter((r) => r.url.pathname === "/v1/subscriptions")) {
    assert.equal(h.url.searchParams.get("customer"), "cus_xyz");
    assert.equal(h.url.searchParams.get("price"), "price_123");
  }
  assert.equal(seen.at(-1).body.get("line_items[0][price]"), "price_123");
  assert.equal(seen.at(-1).body.get("client_reference_id"), "42");
});
