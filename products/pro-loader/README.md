# REA Semantic Graph Slicer

Index exported REA Evidence on the analysis machine. An MCP client can find a definition and read a bounded neighborhood without loading the full application graph into its context. The public package includes the SQLite index, exact-name router and signed plugin loader under the repository's MIT license. The subscription plugin is distributed separately under its own license.

## Query a local build

The scoped npm release of `@realizations/rea` is pending. To use this checkout, run `npm ci && npm run build:cached` and substitute `node scripts/rea.mjs` for `rea` in the examples.

```sh
rea pro index-bundle ./notes.asar --store ./notes-graph
rea pro search toCsv --kind function --limit 1 --store ./notes-graph
rea pro stats --store ./notes-graph
rea pro slice NODE_ID --hops 1 --direction out --relation contains --budget 750 --store ./notes-graph
```

Replace `NODE_ID` with an ID from the search. To index an existing JavaScript application or native call-graph Evidence file, use `rea pro index ./evidence.json --store ./notes-graph`. Search and slice return the source Evidence ID. Pass `--evidence-id ID` to a subsequent slice to guard against a concurrent rebuild. A slice includes its provenance and truncation flag within the specified compact JSON budget using `cl100k_base`.

Indexing without an export returns aggregate measurements and preserves the query allowance. The trial includes three successful graph queries total across exact or semantic search, neighborhood slices and stats. CLI and MCP share the same allowance. Repeating a successful query consumes another use. Requesting a full Evidence export with `index-bundle --evidence-out FILE` also consumes one use.

For Studio, run `rea pro trial` to authorize the trial account. The issuer checks the remaining balance and records redemptions across installations. The graph, query, filenames and Evidence IDs stay on the analysis machine. A development checkout without a Studio profile or trial endpoint uses its local profile database. Upgrades carry forward up to three redemptions still present in the previous local daily ledger. The current lifetime allowance has no scheduled reset.

After exhaustion the tool returns `LICENSE_REQUIRED`, the upgrade command (`npx @realizations/rea login` for Studio or `rea pro login` for a self-hosted client), and four numeric-or-null fields. `indexed_nodes` counts the graph. `raw_evidence_tokens` measures the complete compact source Evidence JSON using `cl100k_base`. At build time the index measures a fixed reference slice from the first node in SQLite binary ID order, one hop in both directions, under a 750-token budget. `matched_subgraph_nodes` counts its returned nodes and `sliced_tokens_ready` counts the complete serialized slice. Those two counts stay the same for every blocked query against that build. A missing measurement, a resource limit, or a legacy index yields `null`. Reindex the Evidence to populate available measurements. The raw counter reads at most 512 MiB of input for this metric, tokenizes in bounded blocks, and can return `null` for large unordered objects or long unbroken strings. Indexing still completes.

`--mode auto` probes exact labels and node IDs first. The trial can rank unmatched queries using terms and graph neighbors. The signed plugin builds a vector index for ranked retrieval. Use `--mode exact` for exact matches or `--mode semantic` to select ranked retrieval. Reindex existing Evidence after installing Pro. Running the paid `index-bundle` command also indexes archive members and folded JavaScript expressions.

## Connect an MCP client

Set the stdio server command to `rea` with arguments `["pro","mcp","--store","/absolute/path/to/notes-graph"]`. The server exposes `graph_search`, `graph_slice` and `graph_stats`. A client can discover further tools when the separately installed extension has access to selected resources.

## Subscribe and install

The commercial npm release workflow embeds a pinned Studio issuer profile. A source checkout or a self-hosted installation can use an explicitly trusted profile from its operator. The issuer serves its public keys and endpoints at `/.well-known/rea-pro.json`. Set `REA_PRO_CONFIG` in a source checkout when supplying that profile yourself. The branded package uses its embedded pins across profiles and sessions.

```sh
# Source checkout or self-hosted issuer
export REA_PRO_CONFIG=/absolute/path/to/issuer-profile.json
rea pro subscribe --plan indie
rea pro login
rea pro status
```

Subscription setup opens GitHub device authorization and returns the selected plan’s hosted checkout URL. The Studio issuer uses Polar. After checkout, login verifies the entitlement, fetches the private compiled package from the configured issuer and verifies the release signature and digest before loading it. A local grant allows offline operation until its expiration. Use `rea pro login` to renew or `rea pro logout` to clear the local session. Run `rea pro --help` for installed commands.

## Electron fixture measured November 18, 2026

This benchmark and the recorded demo used the November 18 build and its earlier preview allowance. The Notes Electron application bundled with isomorphic-git produced 32,637 source nodes and 33,532 relations at raised analyzer limits. The compact Evidence measured **21,334,014 tokens**. Across two signed-plugin runs, locating `toCsv` in `csv.js` and verifying its one-hop neighborhood took **1,536–1,544 MCP wire tokens cold** and **933–941 warm**. The preview in that build completed this query in 1,554 cold and 943 warm tokens. Counts include the two tool calls, replies and framing. The cold count also includes initialization and tool discovery. Timing and token counts vary with build contents, Evidence identities and client setup. These counts use local tokenization and exclude model reasoning and billing.

In one run, an exact search for `toCsv` returned five matches in 352 compact JSON tokens. The installed plugin and the free client returned identical JSON. Explicit semantic mode returned ten ranked matches in 729 tokens. The demo shows the 1,536/933 run. [Watch the 40-second demo](../../website/public/examples/rea-semantic-graph-demo.mp4)

To reproduce, copy `website/public/examples/notes-electron` into a fresh directory and add the locked `node_modules/isomorphic-git/index.js` under the name `editor-git.mjs`. Then run the following commands from this checkout. Set `FIXTURE_DIR` to that copy and choose fresh output paths.

```sh
npx --no-install asar pack "$FIXTURE_DIR" notes.asar
node scripts/rea.mjs pro index-bundle notes.asar --store notes-graph --evidence-out notes.json \
  --max-semantic-nodes 150000 --max-semantic-nodes-per-file 120000 --max-heap-mb 2304
node products/pro-loader/benchmark.mjs notes.json notes-graph
```

The benchmark checks the source location and a returned ownership edge against the original Evidence.

## Publish the public package

The intended public package is `@realizations/rea`. Publication is pending. The fork’s release workflow targets the `@realizations` npm scope from the actual GitHub repository, `Csabesz1130/rea`. A maintainer must configure that trusted publisher and the Studio issuer pins. Qualification runs the graph tests, prepares the Windows runtime, verifies the live issuer identity and its independent release and entitlement verification keys, and packages the public client. The publish job verifies the tarball’s registry integrity before MCP registration. [Release workflow](../../.github/workflows/fork-release.yml)

For local package inventory, use `npm ci`, `npm run build:cached` and `npm pack --dry-run`. The archive includes the public loader, graph reader, CLI and inherited notices. The private plugin and issuer credentials are distributed separately. After publication, verify a specific version with `npx -y @realizations/rea@VERSION pro --help`.

Before the first branded publication, set the public repository variable `REALIZATIONS_ISSUER_PINS` to a JSON object containing the approved `client_id` and two independent Ed25519 public PEMs, `public_key` and `release_public_key`. Obtain their fingerprints through the operator. The release job compares them and each endpoint with production discovery, embeds the matched profile, and confirms the tarball contains the exact bytes.
