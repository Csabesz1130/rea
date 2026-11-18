#!/usr/bin/env node
// swarm-args.mjs <report.json> <packages.txt> --claims <dir> [--batch-size <n>] [--calibrate <name>]...
//
// Proof Swarm's workflow args from a Landscape map: one package for every
// product whose "An MCP tool reaches process execution" cell is unknown,
// with the reasons Landscape gives, in batches of --batch-size (default
// 3). <packages.txt> lists the package directories the map was given, one
// per line, as products/landscape/demo/fetch.mjs prints them; a product is
// matched to its directory by the input Landscape records, and named as its
// package.json names it. Each --calibrate adds a product whose cell is
// "yes" or "no", with that answer as its calibration, which only
// `proof-swarm collect` reads. Prints `{ cli, claims, batches }`.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROW = "agent.tool-process";
const here = path.dirname(fileURLToPath(import.meta.url));

const slugOf = (name) => name.replace(/^@/, "").replace(/\//g, "__");

// The npm name and version of a package directory: its package.json's,
// else what Landscape recorded.
const identityOf = (dir, product) => {
  const file = path.join(dir, "package.json");
  const manifest = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const name = typeof manifest.name === "string" ? manifest.name : product.name;
  const version =
    typeof manifest.version === "string" ? manifest.version : product.version;
  if (!name || !version) throw new Error(`no name and version for ${dir}`);
  return { name, version };
};

/**
 * The workflow's args for a Landscape report: `report` is report.json,
 * `directories` the package directories the map read, `calibrate` npm
 * names of products to add with their known answer. Throws when the report
 * has no tool-reach row, a product's input is not one of the directories,
 * or a calibration product's answer is not known.
 */
export const swarmArgs = (
  report,
  directories,
  { claims, cli, batchSize = 3, calibrate = [] },
) => {
  const row = report.rows?.find((entry) => entry.id === ROW);
  if (!row) throw new Error(`the report has no ${ROW} row`);
  const given = new Map(directories.map((dir) => [path.resolve(dir), dir]));
  const products = report.products
    .filter((product) => product.role !== "ours")
    .map((product) => {
      const dir = given.get(path.resolve(String(product.input)));
      if (!dir) throw new Error(`${product.input} is not in the package list`);
      return { product, dir, ...identityOf(dir, product) };
    });
  const packageOf = ({ name, version, dir }, extra) => ({
    name,
    version,
    dir,
    slug: slugOf(name),
    ...extra,
  });
  const stateOf = ({ product }) => row.cells[product.id]?.state;
  const unknown = products
    .filter((entry) => stateOf(entry) === "unknown")
    .map((entry) =>
      packageOf(entry, {
        reasons: row.cells[entry.product.id].reasons ?? [],
      }),
    );
  const known = calibrate.map((name) => {
    const entry = products.find((candidate) => candidate.name === name);
    const state = entry && stateOf(entry);
    if (state !== "yes" && state !== "no")
      throw new Error(`${name} has no known answer to calibrate with`);
    return packageOf(entry, { reasons: [], calibration: state });
  });
  const packages = [...unknown, ...known];
  const batches = [];
  for (let start = 0; start < packages.length; start += batchSize)
    batches.push({
      id: batches.length + 1,
      packages: packages.slice(start, start + batchSize),
    });
  return { cli, claims, batches };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    options: {
      claims: { type: "string" },
      "batch-size": { type: "string" },
      calibrate: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  const [reportFile, packagesFile] = positionals;
  const batchSize = Number(values["batch-size"] ?? 3);
  if (
    !reportFile ||
    !packagesFile ||
    !values.claims ||
    !Number.isInteger(batchSize) ||
    batchSize < 1
  ) {
    process.stderr.write(
      "Usage: swarm-args.mjs <report.json> <packages.txt> --claims <dir> [--batch-size <n>] [--calibrate <name>]...\n",
    );
    process.exit(2);
  }
  const directories = readFileSync(packagesFile, "utf8")
    .split("\n")
    .filter(Boolean);
  const args = swarmArgs(
    JSON.parse(readFileSync(reportFile, "utf8")),
    directories,
    {
      claims: path.resolve(values.claims),
      cli: path.resolve(here, "../proof-swarm/bin/proof-swarm.mjs"),
      batchSize,
      calibrate: values.calibrate ?? [],
    },
  );
  process.stdout.write(`${JSON.stringify(args, null, 1)}\n`);
}
