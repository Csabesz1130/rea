#!/usr/bin/env node
// split.mjs <package-dir> --out <dir> [--root dist/src]: lay one large
// package out as Release Watch components, one per top-level directory under
// --root and one for the files directly in it, each a copy with a
// package.json that names it, listed in <dir>/release-watch.json. REA's node
// limits then apply to each directory rather than to the whole package; the
// cost is that imports between directories are not followed. Files named as
// tests are left out (Landscape's catalog): they ship in some packages but do
// not run with the product, and Landscape reads no trait from them.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { isTestPath } from "../src/catalog.mjs";

const SCRIPT = /\.[cm]?js$/;
const NAME = /[^A-Za-z0-9._-]/g;

const { values, positionals } = parseArgs({
  options: {
    out: { type: "string" },
    root: { type: "string", default: "dist/src" },
  },
  allowPositionals: true,
});
const [source] = positionals;
if (!source || !values.out) {
  process.stderr.write(
    "Usage: split.mjs <package-dir> --out <dir> [--root dist/src]\n",
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
const root = path.join(source, values.root);
const out = path.resolve(values.out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Script files under `directory` that run with the product, relative to root.
const scriptsIn = (directory) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SCRIPT.test(entry.name))
    .map((entry) =>
      path.relative(
        root,
        path.join(entry.parentPath ?? entry.path, entry.name),
      ),
    )
    .filter((file) => !isTestPath(file.split(path.sep).join("/")));

const component = (name, files) => {
  const directory = path.join(out, name);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(directory, file));
  }
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: `${pkg.name}/${name}`,
      version: pkg.version,
      ...(pkg.type ? { type: pkg.type } : {}),
    }),
  );
  return { name, path: name, files: files.length };
};

const entries = readdirSync(root, { withFileTypes: true });
const components = [];
for (const entry of entries.filter((item) => item.isDirectory())) {
  const files = scriptsIn(path.join(root, entry.name));
  if (files.length > 0)
    components.push(component(entry.name.replace(NAME, "_"), files));
}
const loose = entries
  .filter((entry) => entry.isFile() && SCRIPT.test(entry.name))
  .map((entry) => entry.name)
  .filter((file) => !isTestPath(file));
if (loose.length > 0) components.push(component("top-level", loose));

if (!existsSync(out) || components.length === 0) {
  process.stderr.write(`No script files under ${root}\n`);
  process.exit(1);
}
writeFileSync(
  path.join(out, "release-watch.json"),
  JSON.stringify(
    {
      product: pkg.name,
      version: pkg.version,
      components: components.map(({ name, path: where }) => ({
        name,
        path: where,
      })),
    },
    null,
    1,
  ),
);
process.stderr.write(
  `  ${pkg.name} ${pkg.version}: ${components.length} components, ${components.reduce((sum, item) => sum + item.files, 0)} script files\n`,
);
process.stdout.write(`${out}\n`);
