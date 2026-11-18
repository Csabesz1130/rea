// A small npm registry for the tests: it serves the packuments and
// tarballs the tests publish to it, so the feed's own npm calls, integrity
// checks and unpacking run for real against 127.0.0.1.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A .tgz of one package directory: `files` by relative path, with
 * `links` (path → target) added as symbolic links.
 */
export const tarball = (files, links = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-feed-tarball-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, "package", file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    for (const [file, target] of Object.entries(links))
      symlinkSync(target, path.join(root, "package", file));
    execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: root });
    return readFileSync(path.join(root, "package.tgz"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const digest = (algorithm, bytes, encoding) =>
  createHash(algorithm).update(bytes).digest(encoding);

/**
 * Starts a registry on 127.0.0.1 and resolves to `{ url, publish, close }`.
 * `publish(name, version, bytes, { published, latest, integrity })` adds a
 * version (unscoped names), makes it the latest unless `latest` is false,
 * and states `integrity` in place of the tarball's own when given.
 */
export const startRegistry = async () => {
  const packages = new Map();
  const server = http.createServer((request, response) => {
    const [, name, dash, file] = decodeURIComponent(
      request.url.split("?")[0],
    ).split("/");
    const found = packages.get(name);
    if (!found) {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "Not found" }));
    }
    if (dash === "-" && found.tarballs.has(file)) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      return response.end(found.tarballs.get(file));
    }
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify(found.packument));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const publish = (
    name,
    version,
    bytes,
    { published, latest = true, integrity } = {},
  ) => {
    if (!packages.has(name))
      packages.set(name, {
        tarballs: new Map(),
        packument: { _id: name, name, "dist-tags": {}, versions: {}, time: {} },
      });
    const { tarballs, packument } = packages.get(name);
    const file = `${name}-${version}.tgz`;
    tarballs.set(file, bytes);
    packument.versions[version] = {
      name,
      version,
      license: "MIT",
      dist: {
        tarball: `${url}/${name}/-/${file}`,
        integrity: integrity ?? `sha512-${digest("sha512", bytes, "base64")}`,
        shasum: digest("sha1", bytes, "hex"),
        unpackedSize: bytes.length,
      },
    };
    packument.time[version] = published ?? new Date().toISOString();
    if (latest) packument["dist-tags"].latest = version;
  };
  return {
    url,
    publish,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
