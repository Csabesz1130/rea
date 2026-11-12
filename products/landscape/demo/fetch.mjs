#!/usr/bin/env node
// fetch.mjs <set> --work <dir>: download one set of demo packages from npm
// (packages.json), check each tarball against its pinned sha512 integrity,
// and unpack it into its own directory under <dir>/packages, named for the
// package and version so that a report names a product REA could not read.
// A package (or its set) that names a `root` is large: it is laid out as one
// component per directory under that root (split.mjs), without the
// directories it lists under `skip`. Prints one directory per line for
// Landscape to read: the unpacked package, or its split. Release Feed's
// fetcher does the work: npm fetches the tarball and runs none of the
// package's scripts, a tarball that holds a link is refused, and nothing
// downloaded is executed.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fetchPackage } from "../../release-feed/src/npm.mjs";
import { describe, split } from "./split.mjs";

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

const work = path.resolve(values.work);
const root = path.join(work, "packages");
mkdirSync(root, { recursive: true });
const set = sets[setName];
for (const pkg of set.packages) {
  process.stderr.write(`  ${pkg.name}@${pkg.version} (${pkg.license})\n`);
  const fetched = await fetchPackage(pkg, root);
  if (!fetched.ok)
    throw new Error(
      `${pkg.name}@${pkg.version}: ${fetched.reason}: ${fetched.detail}`,
    );
  const under = pkg.root ?? set.root;
  if (under === undefined) {
    process.stdout.write(`${fetched.dir}\n`);
    continue;
  }
  const made = split(
    fetched.dir,
    path.join(work, "split", path.basename(fetched.dir)),
    { root: under, skip: pkg.skip ?? [] },
  );
  if (!made)
    throw new Error(
      `${pkg.name}@${pkg.version}: no script files under ${under}`,
    );
  process.stderr.write(describe(made));
  process.stdout.write(`${made.out}\n`);
}
