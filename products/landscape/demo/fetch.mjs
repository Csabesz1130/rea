#!/usr/bin/env node
// fetch.mjs <set> --work <dir>: download one set of demo packages from npm
// (packages.json), check each tarball against its pinned sha512 integrity,
// and unpack it into its own directory under <dir>/packages, named for the
// package and version so that a report names a product REA could not read.
// Prints one unpacked package directory per line. npm fetches the tarball and runs none
// of the package's scripts; nothing it downloads is executed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  options: { work: { type: "string" } },
  allowPositionals: true,
});
const [setName] = positionals;
const { sets } = JSON.parse(
  readFileSync(path.join(here, "packages.json"), "utf8"),
);
if (!sets[setName] || !values.work) {
  process.stderr.write(
    `Usage: fetch.mjs <${Object.keys(sets).join("|")}> --work <dir>\n`,
  );
  process.exit(1);
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
    );
  return result.stdout;
};

const integrityOf = (file) =>
  `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

// One directory per package version: a name a scope cannot break.
const directoryName = ({ name, version }) =>
  `${name.replace(/^@/, "").replace(/\//g, "__")}-${version}`;

const fetchPackage = (pkg, root) => {
  const target = path.join(root, directoryName(pkg));
  if (existsSync(path.join(target, "package.json"))) return target;
  const download = path.join(root, `${directoryName(pkg)}.download`);
  rmSync(download, { recursive: true, force: true });
  mkdirSync(download, { recursive: true });
  run(
    "npm",
    [
      "pack",
      `${pkg.name}@${pkg.version}`,
      "--pack-destination",
      download,
      "--ignore-scripts",
      "--silent",
    ],
    download,
  );
  const [tarball] = readdirSync(download).filter((file) =>
    file.endsWith(".tgz"),
  );
  const file = path.join(download, tarball);
  const found = integrityOf(file);
  if (found !== pkg.integrity)
    throw new Error(
      `${pkg.name}@${pkg.version}: tarball integrity ${found} is not the pinned ${pkg.integrity}`,
    );
  const unpacked = path.join(download, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", file, "-C", unpacked], download);
  // An npm tarball holds one top-level directory, usually package/.
  const [top, ...others] = readdirSync(unpacked);
  if (
    top === undefined ||
    others.length > 0 ||
    !statSync(path.join(unpacked, top)).isDirectory()
  )
    throw new Error(
      `${pkg.name}@${pkg.version}: the tarball does not hold one top-level directory`,
    );
  rmSync(target, { recursive: true, force: true });
  renameSync(path.join(unpacked, top), target);
  rmSync(download, { recursive: true, force: true });
  return target;
};

const root = path.join(path.resolve(values.work), "packages");
mkdirSync(root, { recursive: true });
for (const pkg of sets[setName].packages) {
  process.stderr.write(`  ${pkg.name}@${pkg.version} (${pkg.license})\n`);
  process.stdout.write(`${fetchPackage(pkg, root)}\n`);
}
