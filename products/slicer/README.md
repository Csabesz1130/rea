# Semantic Graph Slicer

This page documents the open-core JSON index. The fork also provides persistent SQLite vectors, native call graphs, exact slice budgets and a stdio MCP server. [REA Pro](../pro/README.md)

REA's `analyze_javascript_application` produces a semantic graph as one
Evidence record. For a real bundle that record is large: the right side of
one `ccstatusline` release above is a 249 MB JSON of 150,000 nodes. No model
reads 249 MB, and feeding even a tenth of it to answer one question is waste.

The slicer indexes that Evidence once into a compact local call-graph and
lexical index, then serves an agent the smallest slice that answers its
question, with the node ids and source locations that tie each slice back to
REA's Evidence. It keeps what an agent needs to reason and to find a line,
and drops the Evidence's bulk, which is the repeated identity and context
objects on every node.

It is a prototype beside [Release Watch](../release-watch/README.md),
[Landscape](../landscape/README.md),
[Proof Swarm](../proof-swarm/README.md) and
[Release Feed](../release-feed/README.md). It reads REA's Evidence and runs
nothing; it analyzes no target.

## What it is, and is not

- It is a **call-graph and lexical index**, built from REA's own semantic
  graph. It is **not a vector database**: a vector index needs an embedding
  model, which is a network or a local model the slicer does not assume, so
  there are no embeddings and no similarity search here, only exact and
  substring lookup over the words REA already recovered.
- Every token figure it prints is an **estimate**, the character length over
  four. The slicer is local and names no model, so it reports no exact token
  count. A real count needs the target model's tokenizer.
- It keeps REA's node ids and source locations, not the Evidence's bytes. A
  slice tells an agent where to read the lines, or which node to ask REA for
  in full; it is a smaller way into the same Evidence, not a replacement.

## Quick start

```bash
cd products/slicer

# Build the index once. A large Evidence is read whole, so give it a large
# Node heap; every query after is small and needs none.
NODE_OPTIONS=--max-old-space-size=8192 \
  node bin/slicer.mjs index path/to/app-right-application.json --store ./idx

node bin/slicer.mjs summary --store ./idx          # what the Evidence is about
node bin/slicer.mjs find spawn --store ./idx        # nodes matching a word
node bin/slicer.mjs slice <node-id> --store ./idx --hops 2 --budget 1500
node bin/slicer.mjs stats --store ./idx
```

`--store` is a directory of a few JSON files: the compact nodes, the edges,
the lexical index and the surface summary. Output is JSON on stdout.

The Evidence comes from REA, for example from a Release Watch run (its
`evidence/` directory holds one `*-application.json` per side) or from
`node scripts/rea.mjs analyze-javascript-application <dir> --out e.json`.

## The commands

| Command   | What it returns                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index`   | Builds the index; prints the input and index sizes and the estimated tokens of the whole Evidence and of the summary                                                                      |
| `summary` | What the Evidence is about: counts by node kind and module, and the notable nodes (requests and hosts, process executions and commands, config-file reads, literals), each with a node id |
| `find`    | The nodes whose label, module or a kept string property matches a term, each with its id and `module:line`                                                                                |
| `slice`   | One node's neighbourhood out to `--hops` edges in either direction, with the edges among the kept nodes, trimmed to a token budget                                                        |
| `stats`   | The index's size and counts                                                                                                                                                               |

`slice --budget <n>` bounds the estimated tokens of the **nodes**, added
nearest first; the whole slice adds the edges among them and a small
envelope, so `estimated_tokens` can exceed the budget by that overhead while
`nodes_tokens` stays within it. The root node is always kept.

## What an agent pays

Measured on this container (4 CPUs, 13.7 GB) against the right side of
`ccstatusline` 2.2.34's Evidence from the Release Feed run above, one run.
Tokens are the estimate (characters over four):

| Step                                             | Bytes / tokens (estimate)  |
| ------------------------------------------------ | -------------------------- |
| The whole Evidence                               | 249 MB, ~65,000,000 tokens |
| Build the index (one time, 8 GB heap)            | 6 s, index 90 MB on disk   |
| `summary` — what an agent reads first            | ~2,100 tokens              |
| `slice` of the one `spawn`, 2 hops, budget 1,500 | 7 nodes, ~780 tokens       |

So an agent asking "what new process execution did this release add" reads
the summary and then that one slice: about 3,000 estimated tokens, against a
whole Evidence no model could take. The slice points at
`dist/ccstatusline-7rv6989e.js:165`, the same `spawn` Release Watch reported
as RW-P01.

The index on disk (90 MB) is only a few times smaller than the Evidence,
because 150,000 nodes stay 150,000 nodes; the saving is not the index's size
but that the agent never loads it. It reads the summary, then the slices it
asks for, and nothing else.

## What it does not establish

- The index is built from one Evidence record and is only as complete as
  that record. When REA examined a release only in part (truncation, node
  ceilings), the graph and so the index miss what REA missed; `summary`
  prints REA's coverage status, and a slice is silent about what REA did not
  see.
- `find` matches the words REA recovered: labels, module paths, and the
  literal values, config keys, commands and hosts the index keeps. A string
  REA did not resolve to a literal (a path built at runtime) is not a word to
  find, exactly as Release Watch cannot see it.
- The estimate is characters over four. A model's real token count differs,
  more for minified identifiers and non-Latin text; the figures compare
  sizes, they are not a bill.

## Tests

```bash
cd products/slicer && npm test
```

`test/fixtures/credentials-app.evidence.json` is a real
`analyze_javascript_application` Evidence record for a four-line module that
reads three credential-store paths. The tests build the index from it and
run each query against it, so the index shape, the summary, search and the
budgeted slice are checked on a producer's own output.
