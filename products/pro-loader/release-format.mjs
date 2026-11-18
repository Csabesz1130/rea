// The archive has two fixed regular entries. No archive path or mode is ever
// applied to the filesystem. Authenticate the entire archive before inflating it.
import { createHash, createPublicKey, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const MAX_ARTIFACT = 32 * 1024 * 1024;
export const MAX_NOTICE = 1024 * 1024;
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const positive = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const padded = (n) => Math.ceil(n / 512) * 512;

function validContent(c) {
  return !(
    typeof c.version !== "string" ||
    typeof c.core_version !== "string" ||
    !versionPattern.test(c.version) ||
    !versionPattern.test(c.core_version) ||
    ![c.sha256, c.entry_sha256, c.notice_sha256].every(
      (s) => typeof s === "string" && digestPattern.test(s),
    ) ||
    !positive(c.bytes, MAX_ARTIFACT) ||
    !positive(c.entry_bytes, MAX_ARTIFACT) ||
    !positive(c.notice_bytes, MAX_NOTICE)
  );
}

export function verifyRelease(token, publicKey, coreVersion) {
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
  )
    throw new Error("Invalid signed plugin release");
  const [header, payload, sig] = token.split(".");
  const key =
    publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(header + "." + payload),
      key,
      Buffer.from(sig, "base64url"),
    )
  )
    throw new Error("Invalid plugin release signature");
  const decode = (s) =>
    JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  const h = decode(header),
    c = decode(payload);
  if (
    h.alg !== "EdDSA" ||
    h.typ !== "rea-release+jwt" ||
    h.crit !== undefined ||
    c.aud !== "rea-pro-plugin" ||
    c.abi !== 1 ||
    !validContent(c)
  )
    throw new Error("Invalid plugin release manifest");
  if (coreVersion !== undefined && c.core_version !== coreVersion)
    throw new Error(
      `Plugin requires core ${c.core_version}; installed core is ${coreVersion}`,
    );
  return c;
}
export function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "ascii");
  const oct = (v, at, len) =>
    h.write(v.toString(8).padStart(len - 1, "0") + "\0", at, len, "ascii");
  oct(0o644, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(0, 136, 12);
  h.fill(32, 148, 156);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  const checksum = h.reduce((sum, byte) => sum + byte, 0);
  h.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}
export function releaseTar(entry, notice) {
  const file = (name, bytes) => [
    tarHeader(name, bytes.length),
    bytes,
    Buffer.alloc(padded(bytes.length) - bytes.length),
  ];
  return Buffer.concat([
    ...file("package/cli.mjs", entry),
    ...file("package/LICENSE", notice),
    Buffer.alloc(1024),
  ]);
}
export function unpackRelease(bytes, claims) {
  if (bytes.length !== claims.bytes || digest(bytes) !== claims.sha256)
    throw new Error("Plugin archive digest mismatch");
  const size = 2048 + padded(claims.entry_bytes) + padded(claims.notice_bytes);
  const tar = gunzipSync(bytes, { maxOutputLength: size });
  if (tar.length !== size) throw new Error("Invalid plugin archive length");
  let cursor = 0;
  function read(name, length, sha) {
    if (!tar.subarray(cursor, cursor + 512).equals(tarHeader(name, length)))
      throw new Error("Unexpected plugin archive entry");
    cursor += 512;
    const data = tar.subarray(cursor, cursor + length);
    if (
      digest(data) !== sha ||
      !tar
        .subarray(cursor + length, cursor + padded(length))
        .every((v) => v === 0)
    )
      throw new Error("Invalid plugin archive contents");
    cursor += padded(length);
    return data;
  }
  const entry = read(
    "package/cli.mjs",
    claims.entry_bytes,
    claims.entry_sha256,
  );
  const notice = read(
    "package/LICENSE",
    claims.notice_bytes,
    claims.notice_sha256,
  );
  if (!tar.subarray(cursor).every((v) => v === 0))
    throw new Error("Unexpected plugin archive trailer");
  return { entry, notice };
}
