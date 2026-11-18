import { createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readLocal } from "./files.mjs";

const state = () =>
  process.env.REA_PRO_HOME ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "rea-pro");
const session = () => join(state(), "session.jwt");
export const features = ["graph", "runtime", "recovery"];
function https(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Expected an HTTPS issuer URL");
  return url.href;
}
function config() {
  const path = process.env.REA_PRO_CONFIG ?? join(state(), "issuer.json");
  let cfg;
  try {
    cfg = JSON.parse(readLocal(path, 32768).text);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "Configure an issuer and its verification key in issuer.json or REA_PRO_CONFIG",
      );
    throw error;
  }
  https(cfg.issuer);
  const key = createPublicKey(cfg.public_key);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Issuer requires an Ed25519 public key");
  return { ...cfg, key };
}
const now = () => Math.floor(Date.now() / 1000);
function verifyGrant(token, cfg) {
  if (
    typeof token !== "string" ||
    token.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw new Error("Invalid signed entitlement");
  const [header, body, sig] = token.split(".");
  if (
    !verify(
      null,
      Buffer.from(`${header}.${body}`),
      cfg.key,
      Buffer.from(sig, "base64url"),
    )
  )
    throw new Error("Invalid entitlement signature");
  const decode = (part) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  const h = decode(header),
    c = decode(body);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (
    h.alg !== "EdDSA" ||
    h.crit !== undefined ||
    c.iss !== cfg.issuer ||
    !aud.includes("rea-pro") ||
    typeof c.sub !== "string" ||
    !c.sub ||
    !Number.isSafeInteger(c.exp) ||
    c.exp <= now() ||
    (c.nbf !== undefined && (!Number.isSafeInteger(c.nbf) || c.nbf > now())) ||
    typeof c.scope !== "string"
  )
    throw new Error(
      "Entitlement is expired, inactive or for another issuer or audience",
    );
  const granted = features.filter((f) =>
    c.scope.split(" ").includes(`rea:${f}`),
  );
  if (!granted.length) throw new Error("No REA Pro features in entitlement");
  return { subject: c.sub, expires: c.exp, features: granted };
}
function save(token, cfg) {
  const account = verifyGrant(token, cfg);
  mkdirSync(state(), { recursive: true, mode: 0o700 });
  const tmp = join(state(), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, token, { flag: "wx", mode: 0o600 });
    renameSync(tmp, session());
  } finally {
    rmSync(tmp, { force: true });
  }
  return account;
}
export function account(feature) {
  let token;
  try {
    token = readLocal(session(), 16384).text;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Sign in with rea login");
    throw error;
  }
  const signed = verifyGrant(token, config());
  if (feature && !signed.features.includes(feature))
    throw new Error(`Subscription does not include ${feature}`);
  return signed;
}
export function logout() {
  rmSync(session(), { force: true });
  return { signed_in: false };
}

async function postForm(url, fields, timeoutMs, request) {
  const response = await request(https(url), {
    method: "POST",
    body: new URLSearchParams(fields),
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 15000))),
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 65536) throw new Error("Issuer response is too large");
    chunks.push(chunk);
  }
  const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok && !json.error)
    throw new Error(`Issuer returned HTTP ${response.status}`);
  return json;
}
// Device authorization is interactive only in the CLI. MCP never sees a token or an issuer URL.
export async function login({
  token,
  notify,
  subscribe = false,
  request = fetch,
  sleep = delay,
} = {}) {
  const cfg = config();
  if (token !== undefined) return save(token.trim(), cfg);
  if (!cfg.device_endpoint || !cfg.token_endpoint || !cfg.client_id)
    throw new Error(
      "Configure device_endpoint, token_endpoint and client_id, or use login --token-stdin",
    );
  const dev = await postForm(
    cfg.device_endpoint,
    {
      client_id: cfg.client_id,
      scope: subscribe
        ? "rea:subscribe"
        : features.map((f) => `rea:${f}`).join(" "),
    },
    15000,
    request,
  );
  if (
    typeof dev.device_code !== "string" ||
    !dev.device_code ||
    typeof dev.user_code !== "string" ||
    !/^[A-Za-z0-9 -]{1,64}$/.test(dev.user_code) ||
    !Number.isSafeInteger(dev.expires_in) ||
    dev.expires_in <= 0 ||
    (dev.interval !== undefined &&
      (!Number.isSafeInteger(dev.interval) || dev.interval < 1))
  )
    throw new Error("Invalid device authorization response");
  const end = Date.now() + Math.min(dev.expires_in, 3600) * 1000;
  let interval = (dev.interval ?? 5) * 1000;
  notify(`Open ${https(dev.verification_uri)} and enter ${dev.user_code}`);
  while (Date.now() + interval < end) {
    await sleep(interval);
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    let result;
    try {
      result = await postForm(
        cfg.token_endpoint,
        {
          client_id: cfg.client_id,
          device_code: dev.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        remaining,
        request,
      );
    } catch (error) {
      if (error.name !== "TimeoutError") throw error;
      interval = Math.min(60000, interval * 2);
      continue;
    }
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (result.error === "temporarily_unavailable") {
      interval = Math.min(60000, interval * 2);
      continue;
    }
    if (result.error === "subscription_required")
      throw new Error(
        "An active subscription is required. Use rea pro subscribe for hosted Checkout",
      );
    if (result.error === "already_subscribed")
      throw new Error("Subscription is active. Use rea login");
    if (result.error)
      throw new Error(
        ["access_denied", "expired_token"].includes(result.error)
          ? `Device authorization: ${result.error}`
          : "Issuer rejected device authorization",
      );
    if (subscribe) return { checkout_url: https(result.checkout_url) };
    return save(result.access_token, cfg);
  }
  throw new Error("Device authorization expired");
}
