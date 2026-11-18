// Where a built index is kept: one directory with the index as a few JSON
// files, written so a reader sees a whole file or none of it. The index is
// read once into memory for a run of queries; it is small, so this is cheap.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const PARTS = ["meta", "nodes", "edges", "lexicon", "surface"];

const fileOf = (dir, part) => path.join(dir, `${part}.json`);

/** Writes JSON so a reader sees the old file or the new one, never half of one. */
const writeJson = (file, value) => {
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(value));
  renameSync(partial, file);
};

/** Writes an index (indexEvidence's result) to `dir`, one file per part. */
export const writeIndex = (dir, index) => {
  mkdirSync(dir, { recursive: true });
  for (const part of PARTS) writeJson(fileOf(dir, part), index[part]);
};

/**
 * Reads the index in `dir`: `{ meta, nodes, edges, lexicon, surface }`, with
 * `nodes` by id and `adjacency` by node id (each `{ out, in }` listing the
 * edges that leave and enter it). Throws when `dir` holds no index of this
 * schema.
 */
export const readIndex = (dir) => {
  const metaFile = fileOf(dir, "meta");
  if (!existsSync(metaFile))
    throw new Error(`no slicer index in ${dir} (run "index" first)`);
  const read = (part) => JSON.parse(readFileSync(fileOf(dir, part), "utf8"));
  const meta = read("meta");
  if (meta?.schema !== 1)
    throw new Error(`${metaFile} is not a slicer index of schema 1`);
  const nodeList = read("nodes");
  const edges = read("edges");
  const nodes = new Map(nodeList.map((node) => [node.id, node]));
  const adjacency = new Map();
  const side = (id) => {
    if (!adjacency.has(id)) adjacency.set(id, { out: [], in: [] });
    return adjacency.get(id);
  };
  for (const edge of edges) {
    side(edge.source).out.push(edge);
    side(edge.target).in.push(edge);
  }
  return {
    meta,
    nodes,
    edges,
    adjacency,
    lexicon: read("lexicon"),
    surface: read("surface"),
  };
};

/** The byte size on disk of the index in `dir`. */
export const indexBytes = (dir) =>
  PARTS.reduce((total, part) => {
    const file = fileOf(dir, part);
    return total + (existsSync(file) ? readFileSync(file).length : 0);
  }, 0);
