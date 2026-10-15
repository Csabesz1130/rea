# Release Watch

Release Watch answers one question before a rollout: **what did this release
change, and should we ship it?** It compares two releases with REA, grades the
changes that matter to security and privacy reviewers, and writes a report in
which every claim names its REA Evidence, its location and whether REA
observed it, inferred it, or Release Watch correlated it.

It reviews three kinds of software, alone or together:

- **Desktop apps** built on Electron: renderer-reachable IPC, `webPreferences`,
  hardening fuses and native Go helpers.
- **Web apps**: built sites (`index.html`, `dist/`), their scripts, service
  workers and source maps, and browser captures (HAR) of the running site for
  headers, cookies and the credentials the browser sends.
- **AI apps**: code that calls model providers, credentials shipped in code,
  prompt changes, model output rendered as HTML, and MCP servers whose tools
  start processes.

It is a prototype product built on this repository's REA CLI. Nothing in
`src/` parses application source, binaries or captures; REA owns parsing and
Release Watch owns the policy and the report.

## Quick start

```bash
npm ci && npm run build:cached        # build REA (from the repository root)
cd products/release-watch
node bin/release-watch.mjs compare OLD NEW --vendor-domain vendor.example --out report
```

`OLD` and `NEW` are each one of:

| Input                     | Detected by                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| Electron distribution     | `resources/app.asar` or `resources/app/`                          |
| JavaScript app or package | `package.json`                                                    |
| Built web app             | `index.html`, or `dist/`, `build/`, `out/`, `public/` holding one |
| ASAR archive              | `.asar` file                                                      |
| Browser capture           | `.har` file                                                       |
| Several components        | a `release-watch.json` manifest                                   |

A manifest names the components of one release, so a web front end, its API
and their captures are reviewed together:

```json
{
  "product": "Acme Notes Cloud",
  "version": "2.4.0",
  "components": [
    { "name": "web", "path": "web/site", "capture": "web.har" },
    { "name": "api", "path": "api" }
  ]
}
```

Component names are 1–64 letters, digits, `.`, `_` or `-`, and paths must stay
inside the release directory. For a single component, `--old-capture` and
`--new-capture` attach captures instead.

The command writes `report.html`, `report.md` (for CI and pull-request
comments), `report.json`, and every REA Evidence record it used under
`evidence/`. Exit status is `2` when a finding reaches `--fail-on` (default
`high`); `1` when REA produced no facts at all for a component and no finding
reached the threshold; and `0` otherwise, so a CI job can gate the rollout.
Code REA examined only in part is not an error: it is reported as RW-C01,
high when the unexamined code changed.

| Option                                                                               | Effect                                                                                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `--vendor-domain <domain>`                                                           | Hosts on this domain are first party; repeat for several. `*.x.com` and URLs are accepted.                            |
| `--fail-on <severity>`                                                               | `critical`, `high`, `medium`, `low` or `never`                                                                        |
| `--rea-compare <auto\|always\|never>`                                                | When to ask REA to pair renamed modules; `auto` skips it when no file could be a rename or the Evidence exceeds 64 MB |
| `--max-semantic-nodes <n>`, `--max-semantic-nodes-per-file <n>`, `--max-heap-mb <n>` | Passed to REA's JavaScript analysis when large bundles are truncated                                                  |
| `--jobs <1\|2>`                                                                      | Analyze the two sides together (2, the default) or one at a time (1), which halves peak memory                        |
| `--rea <path>`                                                                       | REA CLI to use (default: this checkout, then `rea` on `PATH`)                                                         |

### Recording a capture

```bash
node bin/release-watch.mjs record https://staging.example.com --out new.har \
  --step 'click:#login' --step 'fill:#q=hello' --step 'waitfor:.result'
```

`record` loads the page in Chromium (`CHROMIUM_PATH` or `--browser`), runs the
steps in order and saves a HAR without response bodies. It is the only
command that runs the software under review; `compare` never executes either
release.

## Demo

`demo/run-demo.sh [electron|cloud|all]` reviews two fictional products whose
hosts use reserved `.example` domains:

- **Acme Notes 1.4.0 → 1.5.0**, an Electron app built around a real Electron
  38.2.0 runtime (downloaded and checked against its pinned SHA-256). 1.5.0
  adds a legitimate sync feature plus what a compromised build pipeline might
  ship: a renderer API that reaches `child_process.exec`, an hourly beacon to a
  new third-party host, the renderer sandbox turned off, hardening fuses reset,
  and a Go updater with a checksum-less dependency and a linker-injected
  endpoint. Release Watch blocks it with 1 critical, 4 high, 1 medium and 3 low
  findings and grades the sync feature low.
- **Acme Notes Cloud 2.3.0 → 2.4.0**, a web front end with recorded captures
  and a Node.js API. 2.4.0 ships an OpenAI key in a browser bundle and calls
  OpenAI from the browser, loads a third-party analytics script, drops HSTS and
  weakens CSP, loses `HttpOnly` on the session cookie, registers a service
  worker, publishes source maps, changes the summarizer's system prompt, and
  adds an MCP server with a tool that runs shell commands. Release Watch
  blocks it with 3 critical, 4 high, 4 medium and 3 low findings, and no
  report file contains the key.

The cloud fixtures are checked in; `demo/record-captures.mjs` re-records their
captures against a local HTTPS server. The Electron demo needs Linux x64, Go,
`curl` and `unzip`; set `ELECTRON_ZIP` to reuse a downloaded
`electron-v38.2.0-linux-x64.zip`.

`demo/video/` records the demo video from two real runs in one directory that
holds both Electron releases and copies of the two cloud releases. Terminal
scenes replay the captured output at its captured times, and report scenes
show the reports those runs wrote. It needs ffmpeg, Chromium (`CHROMIUM_PATH`)
and this repository's `playwright-core` dev dependency.

```bash
node demo/video/capture-terminal.mjs "$dir" desktop.json \
  acme-notes-1.4.0-linux-x64 acme-notes-1.5.0-linux-x64 report
node demo/video/capture-terminal.mjs "$dir" cloud.json \
  acme-notes-cloud-2.3.0 acme-notes-cloud-2.4.0 cloud-report
node demo/video/record-video.mjs --releases "$dir" \
  --desktop desktop.json --cloud cloud.json --out release-watch-demo.mp4
```

## How it works

| Step              | REA operation                    | Used for                                                                                                      |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Application graph | `analyze-javascript-application` | IPC, bridge APIs, windows, imports, HTML scripts, service workers, source maps, requests, processes, literals |
| Module pairing    | `compare-application-versions`   | Renamed bundles REA pairs by content; content-hash names are paired by name as well                           |
| Capture           | `inspect-web-network-capture`    | Requests, document headers, cookies, credentials REA redacted                                                 |
| API surface       | `inspect-analysis-view`          | REA's grouping of a capture's API endpoints                                                                   |
| Runtime           | `inspect-electron-fuses`         | Fuse states and their runtime implications                                                                    |
| Helpers           | `inspect-go-binary`              | Go version, modules, checksums, build settings                                                                |
| Source lines      | `extract-artifact`               | Display only; a line is marked verified when the file's SHA-256 matches REA's digest                          |

Facts are keyed so that moving code does not invent changes: requests by
module and method, destinations by host, prompts by the variable they are
assigned to. A module with more sites of one kind than before is reported
once, with both counts, because Release Watch cannot tell which site is new.
Across the release, each site a component gained is paired with at most one
site a component lost, by method and resolved command, so a call that moved
between modules or components is low and a second copy is not.

Reachability (RW-E01, RW-M01) follows REA's semantic graph: the functions
REA reports, the calls it resolved, the binding reads each function owns,
and imports through their imported names, export bindings, re-exports and
namespace member reads. A read of an object or table (a handler map, a tool
list) leads to the functions its initializer defines and the bindings it
reads; the initializer ends before the binding's first use outside those
functions. An import Release Watch cannot resolve to one of its module's
functions reaches every process site of that module, and the finding says
so.

## Findings

| Rule   | Severity            | Trigger                                                                                                                                                                                                                                                                    |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-E01 | critical            | A new renderer API whose IPC handler reaches process execution, inline, through an imported function that holds it, or through a same-module helper                                                                                                                        |
| RW-E02 | high / medium       | A window set a `webPreferences` safeguard to its unsafe (high) or a dynamic (medium) value; windows pair by the variable that holds them, what they load (a call on the constructor, or on the variable after each assignment), then their options                         |
| RW-E03 | high / medium       | A hardening fuse REA read as unsafe in any executable; medium when its old state was not established                                                                                                                                                                       |
| RW-E04 | low                 | New renderer APIs, one finding per component                                                                                                                                                                                                                               |
| RW-M01 | critical            | An MCP tool registration that reaches more process execution of a kind than before, inline, imported or through a same-module helper                                                                                                                                       |
| RW-M02 | medium / low        | More MCP tool registration calls across the release (medium); a switch between a CallTool dispatcher and per-tool registration (low)                                                                                                                                       |
| RW-A01 | high / medium       | A new AI provider host (high; medium when only a URL near requests REA could not resolve suggests it), or one that browser code now calls when no old browser code did (medium)                                                                                            |
| RW-A02 | critical / high     | A credential-format string not shipped before, or one moved into browser code; critical in browser code                                                                                                                                                                    |
| RW-A03 | medium / low        | A new MCP server SDK (medium) or AI SDK (low)                                                                                                                                                                                                                              |
| RW-A04 | low                 | Changed prose assigned to a variable in AI code                                                                                                                                                                                                                            |
| RW-A05 | medium              | A new HTML sink in browser code that fetches, in a component with an AI surface                                                                                                                                                                                            |
| RW-W01 | high / medium       | A new third-party `<script src>` host, or script code embedded in a `data:` or `javascript:` URL (high)                                                                                                                                                                    |
| RW-W02 | medium              | A new service worker                                                                                                                                                                                                                                                       |
| RW-W03 | low                 | Source maps with original sources, when the old release shipped none                                                                                                                                                                                                       |
| RW-W04 | low                 | New direct `eval`                                                                                                                                                                                                                                                          |
| RW-H02 | high / medium       | A security header the old capture sent is removed or changed                                                                                                                                                                                                               |
| RW-H03 | critical / high     | The browser sends a credential to another party, critical for an AI provider                                                                                                                                                                                               |
| RW-H04 | medium              | A cookie's weakest `Set-Cookie` lost `HttpOnly`, `Secure` or `SameSite` strength                                                                                                                                                                                           |
| RW-N01 | high / medium / low | A new destination host, third party (high; medium when only a URL near requests REA could not resolve suggests it) or vendor or deployment host (low)                                                                                                                      |
| RW-N02 | medium              | Request sites without a known destination that no removed site accounts for                                                                                                                                                                                                |
| RW-N03 | medium              | A host now reached over `http://` or `ws://` that was reached only encrypted before                                                                                                                                                                                        |
| RW-P01 | high / low          | New process execution or a changed command (high); a site that took a removed site with the same command, anywhere in the release (low)                                                                                                                                    |
| RW-G01 | high                | A Go helper's `-ldflags` sets a URL on a new third-party host, also for a new or newly identified helper                                                                                                                                                                   |
| RW-G02 | medium              | A new Go module dependency, noting a missing checksum                                                                                                                                                                                                                      |
| RW-G03 | low                 | A Go helper lost `-trimpath`                                                                                                                                                                                                                                               |
| RW-G04 | medium              | A new helper executable                                                                                                                                                                                                                                                    |
| RW-D01 | low                 | New third-party packages imported, one finding per component                                                                                                                                                                                                               |
| RW-C01 | high / medium       | REA examined only part of the new release (truncation, node ceilings, failed or unparsed files, process APIs REA could not resolve, a child_process member called by a computed name); high when that code changed, unless its source map names no changed original source |
| RW-C02 | low                 | A component, capture or module pairing available on one side only                                                                                                                                                                                                          |
| RW-C03 | medium              | The old release's fuses were readable and the new release's are not                                                                                                                                                                                                        |
| RW-C04 | medium              | A helper REA identified before is not identified now                                                                                                                                                                                                                       |
| RW-C05 | medium / low        | New or changed modules reach an HTTP client library and REA recognised no request site in them; low when a capture covers the release                                                                                                                                      |

Coverage findings exist because a rule that found nothing only means
something for code REA examined; a truncated analysis is reviewed rather than
passed.

## What the report does not claim

- A fact seen only in the new release is "added" only when REA's coverage of
  the old release is complete. Otherwise it is "not observed in" the old
  release, and destination claims say the host was "not seen in" the old
  release's analyzed code or capture.
- Correlations are labelled heuristic: an IPC handler reaching an imported
  exec site, an MCP registration containing one, a request attributed to a URL
  literal in the same module, a module counted as browser code because a page
  loads it, an omitted `webPreferences` option relying on Electron's default.
- A capture records one session. It does not show which code sent a request
  or what other paths contact.
- A process site whose command REA did not resolve is never taken as moved:
  a refactor that relocates one is reported high, with a note that it may be
  the same call.
- Browser code is classified from what HTML pages and service workers load.
  Dedicated workers and scripts loaded at runtime are not classified, so a
  call that moved from a worker into page code is reported at medium.
- REA does not report MCP tool names, so Release Watch counts registration
  calls; a switch of registration API is reported low without a count.
- An unresolved request pairs with a removed one across components only when
  its file moved unchanged; otherwise a request with no known destination
  that moved between components is reported medium. An HTML sink pairs only
  with one in an unchanged file. Browser placement, shipped original sources
  and known hosts are compared with the whole old release, so code that
  moved between components keeps what it had.
- A URL literal in a module that imports an HTTP client REA does not model
  (axios, got, ky) is a possible destination, not an observed one: it is
  reported medium, labelled a guess, and a host the old release only
  guessed at is new once the new release is seen contacting it.
- REA reports strings assigned to variables and URLs it resolved. A key
  written inline in a call or a header is not seen by RW-A02, and a request
  that reads a URL variable is attributed to that URL even if it transforms
  it first.
- Static analysis does not prove runtime behaviour.

## Redaction

Reports never contain credential values in the formats Release Watch knows.
Every report passes through one boundary (`src/redact.mjs`) that masks
documented credential formats wherever they appear, replaces URL query values,
fragments, user info and token-like path segments with a short tag such as
`‹3f9c›`, and strips control and bidirectional characters. Tags are keyed per
run, and equal values share a tag within a report. Source lines shown next
to evidence are masked by span on a bounded window of the line, whatever the
code's syntax: long token-like runs, JWTs, Bearer values, values after a
credential-like name in code, JSON, form bodies, headers and call arguments,
URL query and fragment values and token-like path segments, and escaped
character runs; code that only reads a secret stays readable. On a line where
REA reported a key, and on the line that continues it, every string is
masked. A 40 or 64 hex path segment is kept only before a static asset file,
and content-hashed file names keep their name. Markdown output is escaped so
release content cannot add headings, links or HTML to a pull-request comment. REA
redacts transport credentials in captures itself. The saved Evidence under
`evidence/` is REA's output verbatim and can hold the raw values a release
ships; treat that directory as sensitive.

## Cost

Measured on a 4-core Linux container (16 GB), three warm runs each, wall time,
CPU (user + system of all processes) and peak process-tree memory sampled
every 100 ms. No model is called, so no tokens are used.

| Review                                                         | Wall       | CPU     | Peak memory |
| -------------------------------------------------------------- | ---------- | ------- | ----------- |
| Acme Notes Cloud (2 components, HAR)                           | 9.4–10.9 s | 27–30 s | 1.3 GB      |
| Acme Notes Electron distribution                               | 7.5–7.9 s  | 24–25 s | 1.6 GB      |
| `@modelcontextprotocol/server-everything` 2026.1.26 → 2026.7.4 | 14.4 s     | 30 s    | 0.9 GB      |
| `swagger-ui-dist` 5.32.15 → 5.33.1 (12 MB of bundles)          | 238 s      | 9.3 min | 5.0 GB      |

Each side's JavaScript analysis needs about 2.5 GB at the swagger-ui scale, so
use `--jobs 1` on runners with less than 6 GB of memory; it roughly doubles
wall time. Saved Evidence for such a release is about 600 MB. Neither side's
Evidence is reused between runs yet.

## Tests

```bash
npm test    # from products/release-watch
```

The CLI tests run the real REA build against the fixtures and are skipped when
REA has not been built.
