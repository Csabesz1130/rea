import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { qualifyProfile } from "../../../scripts/ci/prepare-commercial-profile.mjs";
import { login, logout } from "../auth.mjs";
import { remoteTrial, upgradeCommand } from "../trial-authority.mjs";

const origin = "https://api.realizations.ai";
const key = generateKeyPairSync("ed25519");
const release = generateKeyPairSync("ed25519");
const pem = (k) => k.publicKey.export({ type: "spki", format: "pem" });
const pins = {
  public_key: pem(key),
  release_public_key: pem(release),
  client_id: "rea-cli",
};
const discovery = {
  ...pins,
  issuer: origin,
  device_endpoint: origin + "/device/code",
  token_endpoint: origin + "/device/token",
  trial_endpoint: origin + "/trial",
  checkout_endpoint: origin + "/billing/checkout",
  entitlement_endpoint: origin + "/entitlement",
  release_endpoint: origin + "/releases/current",
};
function accountToken(subject, aud = "rea-account") {
  const claims = {
    iss: origin,
    aud,
    sub: subject,
    scope: "rea:account",
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const message = [{ alg: "EdDSA" }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    message +
    "." +
    sign(null, Buffer.from(message), key.privateKey).toString("base64url")
  );
}

test("commercial packaging pins both keys and every endpoint before accepting discovery", async () => {
  const profile = await qualifyProfile(pins, async (url, options) => {
    assert.equal(url, origin + "/.well-known/rea-pro.json");
    assert.equal(options.redirect, "error");
    return Response.json({ ...discovery, unknown: "ignored" });
  });
  assert.deepEqual(profile, discovery);
  for (const response of [
    new Response("<html>Domain for sale</html>"),
    Response.json({
      ...discovery,
      trial_endpoint: "https://example.com/trial",
    }),
    Response.json({ ...discovery, public_key: pem(release) }),
    Response.json({ ...discovery, release_public_key: pem(key) }),
  ])
    await assert.rejects(qualifyProfile(pins, async () => response));
  await assert.rejects(
    qualifyProfile({
      ...pins,
      release_public_key: key.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    }),
  );
});

test("account trial authenticates both operations and fails closed without sending graph data", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "rea-auth-trial-"));
  const prev = Object.fromEntries(
    ["REA_PRO_HOME", "REA_PRO_CONFIG"].map((k) => [k, process.env[k]]),
  );
  t.after(async () => {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(temp, { recursive: true, force: true });
  });
  process.env.REA_PRO_CONFIG = join(temp, "profile.json");
  await writeFile(process.env.REA_PRO_CONFIG, JSON.stringify(discovery));
  let used = 0;
  const jwt = accountToken("github:123");
  const ids = new Set();
  const authority = remoteTrial(async (endpoint, options) => {
    assert.equal(endpoint.href, origin + "/trial");
    assert.equal(options.headers.authorization, "Bearer " + jwt);
    assert.equal(options.redirect, "error");
    if (options.method === "GET") {
      assert.equal(options.body, undefined);
      return Response.json({ remaining: 3 - used });
    }
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ["request_id"]);
    assert.match(body.request_id, /^[0-9a-f-]{36}$/);
    assert.ok(!ids.has(body.request_id));
    ids.add(body.request_id);
    if (used >= 3) return Response.json({ granted: false }, { status: 403 });
    used++;
    return Response.json({ granted: true });
  });
  for (let i = 0; i < 4; i++) {
    process.env.REA_PRO_HOME = join(temp, String(i));
    await mkdir(process.env.REA_PRO_HOME);
    assert.equal(await authority.available(), false);
    await login({ trial: true, token: jwt });
    assert.equal(await authority.available(), i < 3);
    assert.equal(await authority.spend(), i < 3);
  }
  assert.equal(upgradeCommand(), "npx @realizations/rea login");
  assert.equal(
    await remoteTrial(async () => {
      throw new Error("offline");
    }).available(),
    false,
  );
  await assert.rejects(
    login({ trial: true, token: accountToken("github:123", "rea-pro") }),
  );
  const fake = { ...discovery, trial_endpoint: "https://other.example/trial" };
  await writeFile(process.env.REA_PRO_CONFIG, JSON.stringify(fake));
  let sent = false;
  assert.equal(
    await remoteTrial(async () => {
      sent = true;
    }).spend(),
    false,
  );
  assert.equal(sent, false);
  logout();
});

test("packaged issuer pins survive stale local overrides and reject malformed bundled trust", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rea-bundled-issuer-"));
  const override = process.env.REA_PRO_CONFIG;
  t.after(async () => {
    if (override === undefined) delete process.env.REA_PRO_CONFIG;
    else process.env.REA_PRO_CONFIG = override;
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of ["auth.mjs", "files.mjs"])
    await copyFile(new URL("../" + name, import.meta.url), join(dir, name));
  process.env.REA_PRO_CONFIG = join(dir, "override.json");
  await writeFile(
    process.env.REA_PRO_CONFIG,
    JSON.stringify({ ...pins, issuer: "https://dev.example" }),
  );
  const { config } = await import(pathToFileURL(join(dir, "auth.mjs")).href);
  assert.equal(config().issuer, "https://dev.example");
  await writeFile(
    join(dir, "commercial-profile.json"),
    JSON.stringify(discovery),
  );
  assert.equal(config().issuer, origin);
  await writeFile(join(dir, "commercial-profile.json"), "{}");
  assert.throws(() => config({ optional: true }));
});
