// npm packages as releases: what the registry says about a package, and
// one version of it unpacked for reading. npm does the network work and
// runs none of the package's scripts; nothing downloaded is run, and a
// tarball is unpacked only when it matches the integrity expected of it.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const NPM_TIMEOUT_MS = 5 * 60 * 1000;
const NPM_OUTPUT_BYTES = 256 * 1024 * 1024;

// npm's own rules for a package name, so that a name can go to npm as an
// argument and into a directory name as it is.
const NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Whether `name` is a package name npm accepts (at most 214 characters). */
export const isPackageName = (name) =>
  typeof name === "string" && name.length <= 214 && NAME.test(name);

/** Whether `version` is a version as the registry writes one. */
export const isVersion = (version) =>
  typeof version === "string" && version.length <= 256 && VERSION.test(version);

/** A directory name for a package: a name a scope cannot break. */
export const slugOf = (name) => name.replace(/^@/, "").replace(/\//g, "__");

/** A directory name for one version of a package. */
export const directoryName = ({ name, version }) =>
  `${slugOf(name)}-${version}`;

const failure = (reason, detail) => ({ ok: false, reason, detail });

const npm = (args, { registry, cwd } = {}) =>
  new Promise((resolve) => {
    execFile(
      "npm",
      [...args, ...(registry ? ["--registry", registry] : [])],
      {
        cwd,
        encoding: "utf8",
        timeout: NPM_TIMEOUT_MS,
        maxBuffer: NPM_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });

// What npm printed when it failed: its E-code when it gives one.
const npmFailure = ({ error, stdout, stderr }) => {
  const code = /"code":\s*"(E[A-Z0-9_]+)"/.exec(stdout)?.[1];
  if (code === "EINTEGRITY")
    return failure(
      "integrity-mismatch",
      "the tarball does not have the integrity the registry states for it",
    );
  if (code === "E404")
    return failure("not-found", "the registry has no such package or version");
  if (error?.killed)
    return failure("registry-timeout", "npm did not answer in time");
  return failure(
    "registry-error",
    code ?? stderr.trim().split("\n").filter(Boolean).at(-1) ?? "npm failed",
  );
};

const parsed = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

/**
 * What the registry says about a package: `{ ok: true, name, latest,
 * versions }`, where `latest` is the version its `latest` tag names and
 * `versions` every version with the time it was published (`{ version,
 * published }`, oldest first; a version the registry gives no time for or
 * writes in no version's form is left out). Or `{ ok: false, reason,
 * detail }`: "invalid-name", "not-found", "registry-timeout",
 * "registry-error" or "registry-answer" (an answer in no known shape).
 */
export const packageFacts = async (name, { registry } = {}) => {
  if (!isPackageName(name))
    return failure("invalid-name", "not a package name npm accepts");
  const result = await npm(["view", name, "dist-tags", "time", "--json"], {
    registry,
  });
  if (result.error) return npmFailure(result);
  const answer = parsed(result.stdout);
  const latest = answer?.["dist-tags"]?.latest;
  const time = answer?.time;
  if (!isVersion(latest) || !time || typeof time !== "object")
    return failure("registry-answer", "no latest version or publish times");
  const versions = Object.entries(time)
    .filter(
      ([version, published]) =>
        isVersion(version) && typeof published === "string",
    )
    .map(([version, published]) => ({ version, published }))
    .sort((a, b) => a.published.localeCompare(b.published));
  if (!versions.some(({ version }) => version === latest))
    return failure("registry-answer", "the latest version has no publish time");
  return { ok: true, name, latest, versions };
};

/**
 * What the registry says about one version: `{ ok: true, integrity,
 * unpackedSize, license }`, with `unpackedSize` and `license` null when the
 * registry gives none; or `{ ok: false, reason, detail }` as packageFacts.
 */
export const versionFacts = async (name, version, { registry } = {}) => {
  if (!isPackageName(name) || !isVersion(version))
    return failure(
      "invalid-name",
      "not a package name and version npm accepts",
    );
  const result = await npm(
    [
      "view",
      `${name}@${version}`,
      "dist.integrity",
      "dist.unpackedSize",
      "license",
      "--json",
    ],
    { registry },
  );
  if (result.error) return npmFailure(result);
  const answer = parsed(result.stdout);
  const integrity = answer?.["dist.integrity"];
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-"))
    return failure("registry-answer", "no sha512 integrity for this version");
  const size = answer["dist.unpackedSize"];
  return {
    ok: true,
    integrity,
    unpackedSize: Number.isFinite(size) ? size : null,
    license: typeof answer.license === "string" ? answer.license : null,
  };
};

const numbers = (version) => STABLE.exec(version)?.slice(1).map(Number) ?? null;
const lower = (a, b) => {
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] < b[index];
  return false;
};

/**
 * The stable release a version follows: among `versions` (packageFacts')
 * published before `version`, the greatest plain x.y.z below it, so a
 * maintenance release of an older line published in between is not it. For
 * a `version` that is not plain x.y.z, the version published just before
 * it. Null when there is none.
 */
export const predecessorOf = (versions, version) => {
  const target = versions.find((entry) => entry.version === version);
  if (!target) return null;
  const earlier = versions.filter(
    (entry) => entry.published < target.published,
  );
  const at = numbers(version);
  if (at === null) return earlier.at(-1)?.version ?? null;
  return (
    earlier
      .map((entry) => ({ entry, parts: numbers(entry.version) }))
      .filter(({ parts }) => parts !== null && lower(parts, at))
      .sort((a, b) => (lower(a.parts, b.parts) ? -1 : 1))
      .at(-1)?.entry.version ?? null
  );
};

/**
 * The stable release a reader most likely had on `date` (an ISO date or
 * time), given the release `latest` names now: `latest` itself when it
 * was already published by then; else the greatest plain x.y.z published
 * by then and, when `latest` is plain x.y.z too, below it, so that a
 * stray higher number published long ago is not taken for it. Null when
 * the package had no such release yet.
 */
export const stableAsOf = (versions, date, latest) => {
  const until = date.length === 10 ? `${date}T23:59:59.999Z` : date;
  const now = versions.find((entry) => entry.version === latest);
  if (now && now.published <= until) return latest;
  const below = numbers(latest ?? "");
  return (
    versions
      .filter((entry) => entry.published <= until)
      .map((entry) => ({ entry, parts: numbers(entry.version) }))
      .filter(
        ({ parts }) =>
          parts !== null && (below === null || lower(parts, below)),
      )
      .sort((a, b) => (lower(a.parts, b.parts) ? -1 : 1))
      .at(-1)?.entry.version ?? null
  );
};

/** How many of `versions` were published after `from` up to and including `to`. */
export const releasesBetween = (versions, from, to) => {
  const start = versions.find((entry) => entry.version === from)?.published;
  const end = versions.find((entry) => entry.version === to)?.published;
  if (!start || !end) return null;
  return versions.filter(
    (entry) => entry.published > start && entry.published <= end,
  ).length;
};

const integrityOf = (file) =>
  `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

// Unpacks a .tgz into `target` through tar, stopping once the archive
// holds more than `maxBytes`, so no tarball can fill the disk.
const unpack = async (file, target, maxBytes) => {
  const tar = spawn(
    "tar",
    ["-x", "-f", "-", "-C", target, "--no-same-owner", "--no-same-permissions"],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const stderr = [];
  tar.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = new Promise((resolve) => tar.on("close", resolve));
  let seen = 0;
  let tooLarge = false;
  try {
    await pipeline(
      createReadStream(file),
      createGunzip(),
      async function* (source) {
        for await (const chunk of source) {
          seen += chunk.length;
          if (seen > maxBytes) {
            tooLarge = true;
            throw new Error("too large");
          }
          yield chunk;
        }
      },
      tar.stdin,
    );
  } catch (error) {
    tar.kill("SIGKILL");
    await closed;
    return tooLarge
      ? failure(
          "too-large",
          `the tarball unpacks to more than ${maxBytes} bytes`,
        )
      : failure("unpack-failed", error.message);
  }
  const code = await closed;
  return code === 0
    ? { ok: true }
    : failure(
        "unpack-failed",
        Buffer.concat(stderr).toString("utf8").trim().split("\n").at(-1) ??
          "tar failed",
      );
};

// The first entry under `root` that is no directory and no file of its
// own: a symbolic link, a hard link, a device or a pipe. npm installs none
// of these, and reading through one could reach outside the package.
const foreignEntry = (root) => {
  for (const entry of readdirSync(root, { recursive: true })) {
    const stat = lstatSync(path.join(root, entry));
    if (stat.isDirectory()) continue;
    if (!stat.isFile() || stat.nlink > 1) return entry;
  }
  return null;
};

/**
 * One version of a package, unpacked under `root` in a directory named for
 * it: `{ ok: true, dir }`. `pkg` is `{ name, version, integrity }`; the
 * tarball npm fetches must have that sha512 integrity. A directory already
 * there from an earlier call is returned as it is. Or `{ ok: false, reason,
 * detail }`: "invalid-name", "not-found", "registry-timeout",
 * "registry-error", "integrity-mismatch", "too-large" (above `maxBytes`
 * unpacked), "unpack-failed" or "unsafe-entry" (the tarball holds a link,
 * a device or a pipe, or not exactly one top-level directory).
 */
export const fetchPackage = async (
  pkg,
  root,
  { registry, maxBytes = Infinity } = {},
) => {
  if (!isPackageName(pkg.name) || !isVersion(pkg.version))
    return failure(
      "invalid-name",
      "not a package name and version npm accepts",
    );
  const target = path.join(root, directoryName(pkg));
  if (existsSync(path.join(target, "package.json")))
    return { ok: true, dir: target };
  const download = `${target}.download`;
  rmSync(download, { recursive: true, force: true });
  mkdirSync(download, { recursive: true });
  try {
    const packed = await npm(
      [
        "pack",
        `${pkg.name}@${pkg.version}`,
        "--pack-destination",
        download,
        "--ignore-scripts",
        "--silent",
        "--json",
      ],
      { registry, cwd: download },
    );
    if (packed.error) return npmFailure(packed);
    const [tarball] = readdirSync(download).filter((file) =>
      file.endsWith(".tgz"),
    );
    if (!tarball) return failure("registry-error", "npm pack wrote no tarball");
    const file = path.join(download, tarball);
    const found = integrityOf(file);
    if (found !== pkg.integrity)
      return failure(
        "integrity-mismatch",
        `the tarball's integrity ${found} is not the expected ${pkg.integrity}`,
      );
    const unpacked = path.join(download, "unpacked");
    mkdirSync(unpacked);
    const result = await unpack(file, unpacked, maxBytes);
    if (!result.ok) return result;
    const foreign = foreignEntry(unpacked);
    if (foreign !== null)
      return failure(
        "unsafe-entry",
        `${foreign} is a link, a device or a pipe`,
      );
    // An npm tarball holds one top-level directory, usually package/.
    const [top, ...others] = readdirSync(unpacked);
    if (
      top === undefined ||
      others.length > 0 ||
      !lstatSync(path.join(unpacked, top)).isDirectory()
    )
      return failure(
        "unsafe-entry",
        "the tarball does not hold one top-level directory",
      );
    rmSync(target, { recursive: true, force: true });
    renameSync(path.join(unpacked, top), target);
    return { ok: true, dir: target };
  } finally {
    rmSync(download, { recursive: true, force: true });
  }
};
