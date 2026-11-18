# REA Semantic Graph Slicer

Index exported REA Evidence on the analysis machine. An MCP client can find a definition and read a bounded neighborhood without loading the full application graph into its context. The public package includes the SQLite index, exact-name router and signed plugin loader under the repository's MIT license. The subscription plugin is distributed separately under its own license.

## Query a local build

From a source checkout, run `npm ci && npm run build:cached`. The commands below also work as `node scripts/rea.mjs pro …` before installing the scoped npm package.

```sh
rea pro index-bundle ./notes.asar --evidence-out ./notes.json --store ./notes-graph
rea pro search toCsv --kind function --limit 1 --store ./notes-graph
rea pro stats --store ./notes-graph
rea pro slice NODE_ID --hops 1 --direction out --relation contains --budget 750 --store ./notes-graph
```

Replace `NODE_ID` with an ID from the search. To index an existing JavaScript application or native call-graph Evidence file, use `rea pro index ./evidence.json --store ./notes-graph`. Search and slice return the source Evidence ID. Pass `--evidence-id ID` to a subsequent slice to guard against a concurrent rebuild. A slice includes its provenance and truncation flag within the specified compact JSON budget using `cl100k_base`.

The free index supports unlimited case-sensitive exact labels and node IDs. Three distinct neighborhood requests per installation per UTC day are included. A failed request costs no allowance and retrying the same successful request on the same day reuses its allowance. The meter lives under `REA_PRO_HOME` on the analysis machine. The limit response includes the UTC reset time, indexed node count and login command.

`--mode auto` uses exact matches when available. The installed plugin ranks unmatched queries using its graph vectors. Use `--mode exact` to return an empty result for an unknown name or `--mode semantic` to explicitly rank related nodes. After installing the plugin, rerun the index command on existing Evidence to build the vector index. Running the paid `index-bundle` command on the original build also indexes archive members and folded JavaScript expressions.

## Connect an MCP client

Set the stdio server command to `rea` with arguments `["pro","mcp","--store","/absolute/path/to/notes-graph"]`. The server exposes `graph_search`, `graph_slice` and `graph_stats`. A client can discover further tools when the separately installed extension has access to selected resources.

## Subscribe and install

Obtain the HTTPS issuer profile from the operator. The operator distributes its verification keys and endpoints at `/.well-known/rea-pro.json`. Save the trusted profile locally and point the CLI at it.

```sh
export REA_PRO_CONFIG=/absolute/path/to/issuer-profile.json
rea pro subscribe --plan indie
rea pro login
rea pro status
```

Subscription setup opens GitHub device authorization and returns the selected plan's Stripe Checkout URL. After checkout, login verifies the entitlement, fetches the private compiled package from the configured issuer and verifies the release signature and digest before loading it. A local grant allows offline operation until its expiration. Use `rea pro login` to renew or `rea pro logout` to clear the local session. Run `rea pro --help` for installed commands.

## Measured Electron fixture

The Notes Electron application bundled with isomorphic-git produced 32,637 source nodes and 33,532 relations at raised analyzer limits. The compact Evidence measured **21,334,014 tokens**. Across two signed-plugin runs, locating `toCsv` in `csv.js` and verifying its one-hop neighborhood took **1,536–1,544 MCP wire tokens cold** and **933–941 warm**. The free preview completed this query in 1,554 cold and 943 warm tokens. Counts include the two tool calls, replies and framing. The cold count also includes initialization and tool discovery. Timing and token counts vary with build contents, Evidence identities and client setup. These counts use local tokenization and exclude model reasoning and billing.

In one run, an unrestricted exact search for `toCsv` returned five matches in 352 compact JSON tokens. The installed plugin and the free client returned identical JSON. Explicit semantic mode returned ten ranked matches in 729 tokens. The demo shows the 1,536/933 run. [Watch the 40-second demo](../../website/public/examples/rea-semantic-graph-demo.mp4)

To reproduce, copy `website/public/examples/notes-electron` into a fresh directory and add the locked `node_modules/isomorphic-git/index.js` under the name `editor-git.mjs`. Then run the following commands from this checkout. Set `FIXTURE_DIR` to that copy and choose fresh output paths.

```sh
npx --no-install asar pack "$FIXTURE_DIR" notes.asar
node scripts/rea.mjs pro index-bundle notes.asar --store notes-graph --evidence-out notes.json \
  --max-semantic-nodes 150000 --max-semantic-nodes-per-file 120000 --max-heap-mb 2304
node products/pro-loader/benchmark.mjs notes.json notes-graph
```

The benchmark checks the source location and a returned ownership edge against the original Evidence.

## Publish the public package

The package scope is `@csabesz1130/rea-pro`. Maintainers need publish access to that npm scope. From the intended public release commit, review the version and run the following commands. Prepare the verified version-matched Windows addon and manifest using the repository's native release procedure before publishing. Publish exactly the reviewed archive.

```sh
npm ci
npm run test:pro
npm run verify:windows-native:artifact
npm pack --dry-run
npm pack --json > /tmp/rea-pro-pack.json
ARCHIVE=$(node -p 'require("/tmp/rea-pro-pack.json")[0].filename')
tar -tzf "$ARCHIVE"
npm publish --dry-run "./$ARCHIVE" --access public
npm publish "./$ARCHIVE" --access public
```

The archive includes the public loader modules, bounded SQLite reader, CLI and upstream notices. Private source, issuer credentials and release tarballs belong in the separate operator repository and storage. A published scoped version can be run with `npx -y @csabesz1130/rea-pro@VERSION pro --help`.
