#!/usr/bin/env node
// fetch.mjs <set> --work <dir>: download one set of demo packages from npm
// (packages.json), check each tarball against its pinned sha512 integrity,
// and unpack it into its own directory under <dir>/packages, named for the
// package and version so that a report names a product REA could not read.
// Prints one unpacked package directory per line. Release Feed's fetcher
// does the work: npm fetches the tarball and runs none of the package's
// scripts, a tarball that holds a link is refused, and nothing downloaded
// is executed.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fetchPackage } from "../../release-feed/src/npm.mjs";

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

const root = path.join(path.resolve(values.work), "packages");
mkdirSync(root, { recursive: true });
for (const pkg of sets[setName].packages) {
  process.stderr.write(`  ${pkg.name}@${pkg.version} (${pkg.license})\n`);
  const fetched = await fetchPackage(pkg, root);
  if (!fetched.ok)
    throw new Error(
      `${pkg.name}@${pkg.version}: ${fetched.reason}: ${fetched.detail}`,
    );
  process.stdout.write(`${fetched.dir}\n`);
}
