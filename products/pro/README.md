# REA Pro

This fork adds a local SQLite graph slicer, an application telemetry bridge, and build-artifact recovery. The `rea pro` CLI and a separate stdio MCP server share query handlers. The account service issues short-lived entitlements after checking a subscription. Artifact bytes and application traces stay on the analysis machine.

Build the fork with `npm ci && npm run build:cached`. The examples below use `rea` for the checkout's `node scripts/rea.mjs`. Run `rea pro --help` for command syntax and `npm run test:pro` for the integration tests.

## Sign in

Obtain the issuer profile from your operator. Set `REA_PRO_CONFIG` to its local JSON path. By default REA reads `issuer.json` under `REA_PRO_HOME`, or under `$XDG_CONFIG_HOME/rea-pro` (falling back to `~/.config/rea-pro`).

```sh
rea login
rea pro status
```

The terminal prints a verification URL and a code. With the included issuer, the user enters the code on GitHub. An active or trialing subscription to the configured Stripe price grants a one-hour token. `rea pro subscribe` starts a separate device flow and returns a Stripe-hosted Checkout URL for the customer to open. After payment, run `rea login`. Operators can also deliver a signed entitlement through `rea login --token-stdin`. `rea pro logout` removes the saved session.

The CLI and each MCP query verify the signature, issuer, audience, expiry and feature scope against the local issuer profile. Renew an expired grant with `rea login`. The client keeps the token in a user-private session file. The service checks subscription state at issuance. A previously issued token can be used offline until expiry. This branch contains the client and plugin source. The commercial service controls the signing key and subscription issuance.

## Graph queries

```sh
rea pro index-bundle ./notes.asar --store ./notes-index --evidence-out ./notes-evidence.json
rea pro search toCsv --kind function --limit 1 --store ./notes-index
rea pro slice NODE_ID --direction out --relation contains --hops 1 --budget 750 --store ./notes-index
rea pro stats --store ./notes-index
```

`index-bundle` runs REA's static directory/ASAR analyzer and publishes its complete Evidence to a fresh output file. The output is retained if a subsequent indexing attempt fails. Use `rea pro index notes-evidence.json --store ./notes-index` to resume. Pass `--max-semantic-nodes`, `--max-semantic-nodes-per-file` or `--max-heap-mb` to configure the underlying analyzer. Its coverage and omissions travel with the index.

`index` also accepts exported native `get_call_graph` Evidence. Backward caller observations are normalized to caller-to-callee direction. An address retains its provider-reported error or relationship coverage. Native analysis requires a REA provider that produces that Evidence.

Each store holds one Evidence record. Reindexing replaces its SQLite contents in a transaction. The importer streams graph rows and hashes the input file. Search uses sparse TF-IDF vectors with cosine similarity. Weighted terms come from labels, kinds, module paths and selected properties. Up to four distinctive terms per neighbor contribute up to twelve lower-weight dimensions per node. Query terms use the same Unicode and identifier segmentation. The index operates locally without an embedding service or model download.

The graph retains provider relations and their resolution. JavaScript function containment comes from REA's `function_node_id`. A `calls-function` edge links a caller and callee when REA identified the call site, its owner and a function target. Each derived call includes the call-site ID and original relation ID. Results carry Evidence identity and source locations. Supply the search result's `--evidence-id` on a subsequent slice to detect intervening reindexing.

The budget covers the entire compact JSON slice in the named `cl100k_base` encoding, including nodes, edges, provenance and truncation. An oversized root can be returned by identity. A budget below the minimum needed for identity and provenance returns an error. Use relation and direction filters on high-degree nodes. MCP framing, tool definitions and other messages have separate costs. The benchmark below counts those too.

## Runtime observations

A cooperating Node or Electron app can record its own marks, measures and aggregate CPU/RSS samples. Use a new path for each run.

```js
import { openRuntimeTrace } from "./products/pro/src/runtime.mjs";

const trace = openRuntimeTrace("./editor-run.ndjson");
const stop = trace.observePerformance();
performance.mark("editor.open");
// Render the editor, then record its first paint.
performance.measure("editor.first-paint", "editor.open");
trace.sample();
stop();
trace.close();
```

`trace.mark(name, {evidence_id, node_id})` and `trace.measure(name, durationMs, link)` associate app events with graph nodes. The caller supplies that association. A second process can read events as the app writes them.

```sh
rea pro trace --trace ./editor-run.ndjson --limit 25
rea pro trace --trace ./editor-run.ndjson --cursor PREVIOUS_CURSOR --wait-ms 3000
```

The reader resumes at complete UTF-8 lines, reports malformed rows, and signals rotation or truncation with `reset`. A page includes the session and time origin. Runtime observations come from explicit application instrumentation.

Applications using OpenTelemetry can send uncompressed OTLP/HTTP JSON spans to the loopback collector. Set `REA_PRO_OTLP_TOKEN` to an operator-generated secret of at least 16 characters. Configure the application's exporter for `POST /v1/traces`, JSON, and `Authorization: Bearer <token>`. The collector writes span identity, name, start time, duration and the two optional REA link attributes. Accepted spans become available immediately to the same cursor reader.

```sh
rea pro collect --trace ./otel-run.ndjson --port 4318
```

The collector accepts up to 1 MiB per batch and reports rejected spans in its OTLP response. Hardware integration depends on the app's exporter and connectivity to the loopback collector. Linux verification covered a stdio MCP client and an HTTP listener. An additional run sent an `editor.save` span through the OpenTelemetry JavaScript SDK 2.1.0 and OTLP/HTTP exporter 0.205.0 and verified its trace ID at the CLI.

## Static build artifacts

| Command                                                               | Input and result                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rea pro explain-js --script dist/app.js`                             | Babel parses the bundle. Literal arithmetic, comparisons, conditionals and untagged template expressions yield observed source ranges and derived values. Calls, bindings and runtime-dependent expressions stay unresolved. Page by UTF-16 offset.           |
| `rea pro source-position --map dist/app.js.map --line 1 --column 110` | REA's bounded source-map decoder returns original positions and short excerpts from embedded source. It preserves duplicate candidates and indexed map sections. Lines are one-based and columns are zero-based UTF-16 units.                                 |
| `rea pro r8-symbol a.b --mapping mapping.txt --method c --line 21`    | Look up the build's own R8/ProGuard class and method mappings. Results retain overloads, inline owner names, declared line ranges and mapping-file line numbers. This is a mapping-row lookup. Full Android retrace metadata processing is outside its scope. |
| `rea pro extract app.asar dist/main.js --out ./main-copy.js`          | Extract one unencrypted regular member from an ASAR, ZIP, APK or JAR. REA reads the container, checks size and declared SHA-256 when present, then creates the caller-selected output exclusively.                                                            |

`extract` accepts embedded members up to 64 MiB. The existing open-core `products/obfuscation` scanner identifies native packer markers such as UPX. Build-map lookup, constant folding and ordinary archive extraction are the recovery capabilities provided here.

## Connect an MCP client

Register a stdio server in your client using the absolute checkout path. Select only the resources this agent should see. The example index exposes graph search, slice and stats. A trace adds the live event reader. Options `--map`, `--mapping` and `--script` enable the corresponding build-analysis tools.

```json
{
  "mcpServers": {
    "rea-pro": {
      "command": "node",
      "args": [
        "/absolute/rea/scripts/rea.mjs",
        "pro",
        "mcp",
        "--store",
        "/absolute/notes-index",
        "--trace",
        "/absolute/editor-run.ndjson"
      ],
      "env": { "REA_PRO_CONFIG": "/absolute/issuer.json" }
    }
  }
}
```

MCP tools can query only the paths selected when starting the server. Index creation, file extraction, collector startup and account operations run from the CLI.

## Operate the subscription issuer

The checkout includes a standalone issuer at `products/pro/issuer/server.mjs`. Configure a GitHub OAuth app with device flow enabled, a recurring Stripe Price, a Stripe secret with the necessary customer, checkout and subscription permissions, an Ed25519 private key, a private persistent SQLite directory and an HTTPS origin. Use a TLS reverse proxy for the loopback HTTP listener. The public CLI client ID and the GitHub OAuth app client ID serve different roles.

```json
{
  "issuer": "https://pro.example.com",
  "client_id": "rea-cli",
  "github_client_id": "YOUR_GITHUB_OAUTH_APP_CLIENT_ID",
  "stripe_key": "YOUR_STRIPE_SECRET",
  "price_id": "YOUR_RECURRING_PRICE_ID",
  "private_key_file": "/absolute/private/rea-ed25519.pem",
  "database": "/absolute/private/issuer.sqlite",
  "port": 8787
}
```

```sh
umask 077
openssl genpkey -algorithm Ed25519 -out /absolute/private/rea-ed25519.pem
REA_ISSUER_CONFIG=/absolute/private/issuer.json node products/pro/issuer/server.mjs
```

Distribute the public profile served by `/.well-known/rea-pro.json` over the issuer's HTTPS origin. Keep the issuer configuration and signing key on the server. The service associates Stripe customers with GitHub's numeric account ID, checks the selected price and status at login, and consumes approved device codes once. Only an explicit subscribe operation creates a hosted payment session. GitHub and Stripe errors do not produce a grant. The integration tests exercise the actual issuer and CLI grant consumer with simulated provider responses.

## Measurements

One Linux run per case on Node 24.22.3 produced the following counts.

| ASAR and analyzer settings                | Source nodes | Source relations | Full Evidence tokens | Fresh MCP tokens | Warm MCP tokens |
| ----------------------------------------- | -----------: | ---------------: | -------------------: | ---------------: | --------------: |
| Notes                                     |          183 |              110 |              146,793 |            1,518 |             932 |
| Notes with trace-mapping                  |        2,291 |            2,110 |            1,487,869 |            1,526 |             940 |
| Notes with isomorphic-git, default limits |       20,183 |           18,317 |           13,497,265 |            1,538 |             952 |
| Notes with isomorphic-git, raised limits  |       32,637 |           33,532 |           21,334,000 |            1,524 |             938 |

| ASAR and analyzer settings                | Index wall / CPU (ms) | Index peak RSS (MiB) | Fresh query wall / CPU (ms) | Fresh peak RSS (MiB) | Warm query wall / CPU (ms) | Warm peak RSS (MiB) |
| ----------------------------------------- | --------------------: | -------------------: | --------------------------: | -------------------: | -------------------------: | ------------------: |
| Notes                                     |             644 / 857 |                 89.8 |                   824 / 940 |                100.7 |                    14 / 10 |               101.4 |
| Notes with trace-mapping                  |         1,031 / 1,407 |                118.8 |                   730 / 860 |                101.4 |                      9 / 0 |               102.2 |
| Notes with isomorphic-git, default limits |         4,667 / 5,303 |                164.5 |                   495 / 580 |                103.2 |                    11 / 10 |               103.2 |
| Notes with isomorphic-git, raised limits  |       11,277 / 12,275 |                164.9 |                   525 / 640 |                102.8 |                    18 / 10 |               102.8 |

The default analyzer reported truncation for the largest bundle. Raising the total node limit to 150,000, the per-file limit to 120,000 and the analyzer heap to 2,304 MiB removed that truncation flag. REA still reports unknown overall semantic coverage. Index peak RSS comes from the operating system. Query RSS samples the MCP server every 10 ms and at phase boundaries. CPU readings use 10 ms OS ticks. Timings exclude offline baseline tokenization and initial application analysis.

For a narrower name-only lookup on Notes, the open-core slicer returned the function in a 373-token compact reply. An unrestricted ten-result Pro search used 717 tokens on the same query. Use a kind filter and a small limit when the question already identifies a function. The percentage reduction against full Evidence does not quantify an improvement over the existing lexical lookup.

Each run locates the `toCsv` definition in the shipped Notes app and verifies that one returned neighbor belongs to the function in the original Evidence. A fresh MCP connection includes initialization, tool discovery, requests, replies and JSON-RPC framing. The warm connection repeats the two queries. The baseline counts the entire compact Evidence document. The counts use local `cl100k_base` tokenization. Model reasoning, output generation, provider billing and other client-specific prompts are unmeasured.

To reproduce, package `website/public/examples/notes-electron` with the locked `@electron/asar`, run `index-bundle`, then run `node products/pro/benchmark.mjs EVIDENCE STORE` after login. For the second fixture copy `node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs` into the Notes directory before packaging. For the largest fixture use `node_modules/isomorphic-git/index.js` as `editor-git.mjs` in a fresh copy of Notes. Indexing measurements start with exported Evidence and an empty store. Query time starts after indexing.
