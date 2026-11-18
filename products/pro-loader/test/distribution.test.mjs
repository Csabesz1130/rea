import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import hostPackage from "../../../package.json" with { type: "json" };
import { installRelease, installedPlugin } from "../install.mjs";
import { login } from "../auth.mjs";
import { digest, releaseTar, verifyRelease } from "../release-format.mjs";

const origin = "https://issuer.example.test",
  accountKeys = generateKeyPairSync("ed25519"),
  releaseKeys = generateKeyPairSync("ed25519");
const pem = (key) => key.export({ format: "pem", type: "spki" });
function jwt(type, claims, key) {
  const encoded = [{ alg: "EdDSA", typ: type }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    encoded + "." + sign(null, Buffer.from(encoded), key).toString("base64url")
  );
}
const grant = (aud, scope) =>
  jwt(
    "JWT",
    {
      iss: origin,
      sub: "github:42",
      aud,
      scope,
      exp: Math.floor(Date.now() / 1000) + 900,
    },
    accountKeys.privateKey,
  );
function release(transform = (tar) => tar, changes = {}) {
  const entry = Buffer.from(
    'import {features} from "rea-core:products/pro-loader/auth.mjs";export function runPro(){return features;}',
  );
  const notice = Buffer.from("Example fixture license");
  const bytes = gzipSync(transform(releaseTar(entry, notice)));
  const claims = {
    aud: "rea-pro-plugin",
    abi: 1,
    core_version: hostPackage.version,
    version: "1.0.0",
    sha256: digest(bytes),
    bytes: bytes.length,
    entry_sha256: digest(entry),
    entry_bytes: entry.length,
    notice_sha256: digest(notice),
    notice_bytes: notice.length,
    ...changes,
  };
  const manifest = jwt("rea-release+jwt", claims, releaseKeys.privateKey);
  return {
    bytes,
    claims,
    record: {
      manifest,
      download_url: origin + "/releases/" + claims.sha256 + ".tgz",
    },
  };
}
async function profile(t) {
  const dir = await mkdtemp(join(tmpdir(), "rea-loader-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = process.env.REA_PRO_HOME,
    oldConfig = process.env.REA_PRO_CONFIG;
  t.after(() => {
    if (old === undefined) delete process.env.REA_PRO_HOME;
    else process.env.REA_PRO_HOME = old;
    if (oldConfig === undefined) delete process.env.REA_PRO_CONFIG;
    else process.env.REA_PRO_CONFIG = oldConfig;
  });
  process.env.REA_PRO_HOME = dir;
  process.env.REA_PRO_CONFIG = join(dir, "issuer.json");
  await writeFile(
    process.env.REA_PRO_CONFIG,
    JSON.stringify({
      issuer: origin,
      public_key: pem(accountKeys.publicKey),
      release_public_key: pem(releaseKeys.publicKey),
      device_endpoint: origin + "/device/code",
      token_endpoint: origin + "/device/token",
      checkout_endpoint: origin + "/billing/checkout",
      client_id: "cli",
    }),
  );
  return dir;
}

test("install authenticates release, restricts download, and preserves the previous executable after rejected updates", async (t) => {
  const dir = await profile(t);
  const token = grant("rea-pro", "rea:graph");
  await assert.rejects(installRelease(), /Sign in/);
  await login({ token });
  const valid = release();
  function transport(data, record = data.record, bytes = data.bytes) {
    const calls = [];
    return {
      calls,
      async request(url, opts) {
        calls.push(url);
        assert.equal(opts.headers.Authorization, "Bearer " + token);
        assert.equal(opts.redirect, "error");
        if (url === origin + "/releases/current") return Response.json(record);
        assert.equal(url, data.record.download_url);
        return new Response(bytes);
      },
    };
  }
  const good = transport(valid);
  const result = await installRelease(good);
  assert.equal(result.sha256, valid.claims.sha256);
  assert.equal(good.calls.length, 2);
  assert.deepEqual((await installedPlugin()).runPro(), [
    "graph",
    "runtime",
    "recovery",
  ]);
  const grantIssuerOnly = jwt(
    "rea-release+jwt",
    valid.claims,
    accountKeys.privateKey,
  );
  const wrongKey = transport(valid, {
    ...valid.record,
    manifest: grantIssuerOnly,
  });
  await assert.rejects(installRelease(wrongKey), /signature/);
  assert.equal(wrongKey.calls.length, 1);
  const changed = transport(valid, {
    ...valid.record,
    download_url: "https://another.example/a",
  });
  await assert.rejects(installRelease(changed), /issuer origin/);
  assert.equal(changed.calls.length, 1);
  const foreignCore = release(undefined, { core_version: "0.0.0" });
  await assert.rejects(installRelease(transport(foreignCore)), /requires core/);
  const broken = Buffer.from(valid.bytes);
  broken[broken.length - 1] ^= 3;
  await assert.rejects(
    installRelease(transport(valid, valid.record, broken)),
    /digest mismatch/,
  );
  // Even an authentic release cannot introduce filesystem links or traversal entries.
  const wrongHeader = release((tar) => {
    tar.write("../outside.txt", 0);
    return tar;
  });
  await assert.rejects(installRelease(transport(wrongHeader)), /archive entry/);
  const wrongType = release((tar) => {
    tar[156] = 50;
    return tar;
  });
  await assert.rejects(installRelease(transport(wrongType)), /archive entry/);
  assert.equal(
    await readFile(join(dir, "plugins/current.jwt"), "utf8"),
    valid.record.manifest,
  );
  const local = join(dir, "release");
  await mkdir(local);
  await writeFile(join(local, "current.jwt"), valid.record.manifest);
  await writeFile(join(local, valid.claims.sha256 + ".tgz"), valid.bytes);
  await installRelease({ from: local });
  const module = join(dir, "plugins", valid.claims.sha256 + ".mjs");
  const mutated = await readFile(module);
  mutated[0] ^= 1;
  await writeFile(module, mutated);
  await assert.rejects(installedPlugin(), /digest mismatch/);

  assert.equal(
    verifyRelease(valid.record.manifest, pem(releaseKeys.publicKey)).aud,
    "rea-pro-plugin",
  );
});

test("team checkout obtains a separate account grant and sends the selected plan", async (t) => {
  const dir = await profile(t);
  const token = grant("rea-pro", "rea:graph");
  await login({ token });
  const accountToken = grant("rea-account", "rea:account");
  let calls = 0;
  const result = await login({
    subscribe: true,
    plan: "team",
    notify: () => {},
    sleep: async () => {},
    request: async (url, opts) => {
      calls++;
      if (url.endsWith("/code")) {
        assert.equal(opts.body.get("scope"), "rea:account");
        return Response.json({
          device_code: "device",
          user_code: "TEST",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        });
      }
      if (url.endsWith("/token"))
        return Response.json({ access_token: accountToken });
      assert.equal(url, origin + "/billing/checkout");
      assert.equal(opts.headers.Authorization, "Bearer " + accountToken);
      assert.deepEqual(JSON.parse(opts.body), { plan: "team" });
      return Response.json({
        checkout_url: "https://checkout.stripe.com/example",
      });
    },
  });
  assert.deepEqual(result, {
    checkout_url: "https://checkout.stripe.com/example",
  });
  assert.equal(calls, 3);
  assert.equal(await readFile(join(dir, "session.jwt"), "utf8"), token);
});
