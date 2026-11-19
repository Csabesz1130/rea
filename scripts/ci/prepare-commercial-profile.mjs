import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const origin = "https://api.realizations.ai";
const routes = {
  device_endpoint: "/device/code",
  token_endpoint: "/device/token",
  trial_endpoint: "/trial",
  checkout_endpoint: "/billing/checkout",
  entitlement_endpoint: "/entitlement",
  release_endpoint: "/releases/current",
};

function publicPem(value) {
  if (
    typeof value !== "string" ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(
      value,
    )
  )
    throw new Error("Expected a public SPKI PEM");
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Expected an Ed25519 public key");
  return key.export({ type: "spki", format: "pem" });
}

export async function qualifyProfile(pins, request = fetch) {
  if (
    typeof pins.client_id !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(pins.client_id)
  )
    throw new Error("Set the approved device-flow client ID");
  const profile = {
    issuer: origin,
    client_id: pins.client_id,
    public_key: publicPem(pins.public_key),
    release_public_key: publicPem(pins.release_public_key),
  };
  if (profile.public_key === profile.release_public_key)
    throw new Error("Use independent release and entitlement keys");
  for (const [name, path] of Object.entries(routes))
    profile[name] = origin + path;
  const response = await request(origin + "/.well-known/rea-pro.json", {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { accept: "application/json" },
  });
  if (
    !response.ok ||
    !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
  )
    throw new Error("Issuer discovery must respond with JSON");
  const chunks = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > 32768) throw new Error("Discovery response exceeds 32 KiB");
    chunks.push(part);
  }
  const discovery = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  for (const [name, value] of Object.entries(profile))
    assert.equal(
      name.endsWith("_key") ? publicPem(discovery[name]) : discovery[name],
      value,
      "Mismatch for " + name,
    );
  return profile;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const profile = await qualifyProfile(
    JSON.parse(process.env.REALIZATIONS_ISSUER_PINS ?? "{}"),
  );
  const dest = new URL(
    "../../products/pro-loader/commercial-profile.json",
    import.meta.url,
  );
  await writeFile(dest, JSON.stringify(profile, null, 2) + "\n", {
    flag: "wx",
  });
}
