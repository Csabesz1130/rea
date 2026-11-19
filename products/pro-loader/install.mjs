import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPluginSource } from "./worker-host.mjs";
import { config, credentials, state } from "./auth.mjs";
import { digest, unpackRelease, verifyRelease } from "./release-format.mjs";
import hostPackage from "../../package.json" with { type: "json" };

const host = new URL("../../", import.meta.url);
const cache = () => join(state(), "plugins");
const keyOf = (cfg) => cfg.release_public_key ?? cfg.key;
const validate = (manifest, cfg) =>
  verifyRelease(manifest, keyOf(cfg), hostPackage.version);

async function readBounded(path, limit) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size < 1 || st.size > limit)
      throw new Error("Invalid plugin file size");
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Plugin file changed while reading");
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

async function replace(dir, name, bytes) {
  const tmp = join(dir, "." + randomUUID() + ".tmp");
  try {
    await writeFile(tmp, bytes, { flag: "wx", mode: 0o600 });
    await rename(tmp, join(dir, name));
  } finally {
    await rm(tmp, { force: true });
  }
}

function issuerURL(raw, cfg) {
  const url = new URL(raw, cfg.issuer);
  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(cfg.issuer).origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error(
      "Plugin download must use HTTPS on the configured issuer origin",
    );
  return url.href;
}

async function receive(url, token, max, { timeout, request }) {
  const res = await request(url, {
    headers: { Authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok || !res.body || Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel();
    throw new Error("Plugin download failed (HTTP " + res.status + ")");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error("Plugin download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function installRelease({ from, request = fetch } = {}) {
  const { token } = credentials();
  const cfg = config();
  let manifest, claims, archive;
  if (from) {
    manifest = (await readBounded(join(from, "current.jwt"), 8192))
      .toString()
      .trim();
    claims = validate(manifest, cfg);
    archive = await readBounded(
      join(from, claims.sha256 + ".tgz"),
      claims.bytes,
    );
  } else {
    const url = issuerURL(cfg.release_endpoint ?? "/releases/current", cfg);
    const record = JSON.parse(
      (await receive(url, token, 16384, { timeout: 15000, request })).toString(
        "utf8",
      ),
    );
    manifest = record.manifest;
    claims = validate(manifest, cfg);
    if (typeof record.download_url !== "string")
      throw new Error("Missing plugin download URL");
    const download = issuerURL(record.download_url, cfg);
    if (new URL(download).pathname !== "/releases/" + claims.sha256 + ".tgz")
      throw new Error("Plugin download URL does not match signed digest");
    archive = await receive(download, token, claims.bytes, {
      timeout: 120000,
      request,
    });
  }
  const { entry, notice } = unpackRelease(archive, claims);
  const dir = cache();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await replace(dir, claims.sha256 + ".mjs", entry);
  await replace(dir, claims.sha256 + ".LICENSE", notice);
  // The pointer is the commit record. A failed update leaves the old release usable.
  await replace(dir, "current.jwt", manifest);
  return {
    version: claims.version,
    core_version: claims.core_version,
    sha256: claims.sha256,
  };
}

// All private code is in one signed ESM chunk. Resolve its public ABI imports
// against the running REA installation, including when invoked through npx.
export async function installedPlugin() {
  let manifest;
  try {
    manifest = (await readBounded(join(cache(), "current.jwt"), 8192))
      .toString()
      .trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return loadPlugin(manifest);
}

export async function loadPlugin(manifest) {
  const claims = validate(manifest, config());
  const path = join(cache(), claims.sha256 + ".mjs");
  const entry = await readBounded(path, claims.entry_bytes);
  if (
    entry.length !== claims.entry_bytes ||
    digest(entry) !== claims.entry_sha256
  )
    throw new Error("Installed plugin digest mismatch. Run rea pro install");
  const url = pathToFileURL(path).href;
  registerPluginSource(url, manifest);
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL !== url) return next(specifier, context);
      if (specifier.startsWith("rea-core:")) {
        const subpath = specifier.slice("rea-core:".length);
        if (
          !/^(dist|products\/(slicer|pro-loader))\/[a-zA-Z0-9._/-]+$/.test(
            subpath,
          ) ||
          subpath
            .split("/")
            .some((part) => !part || part === "." || part === "..")
        )
          throw new Error("Invalid plugin host import");
        return { url: new URL(subpath, host).href, shortCircuit: true };
      }
      return next(specifier, {
        ...context,
        parentURL: new URL("scripts/rea.mjs", host).href,
      });
    },
    load(specifier, context, next) {
      return specifier === url
        ? { format: "module", source: entry, shortCircuit: true }
        : next(specifier, context);
    },
  });
  return import(url);
}
