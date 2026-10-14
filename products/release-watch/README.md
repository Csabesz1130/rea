# Release Watch

Release Watch answers one question for IT and security teams: **what did this
desktop-app update change, and should we roll it out?** It compares two
releases of an Electron app with REA, grades the changes that matter to
endpoint security, and writes a report where every claim names its REA
Evidence, its source location and whether it was observed, inferred or
correlated.

It is a prototype product built on this repository's REA CLI. Nothing in
`src/` reads application source or binary formats itself; REA owns parsing,
and Release Watch owns the policy and the report.

## Quick start

```bash
npm ci && npm run build:cached        # build REA (from the repository root)
cd products/release-watch
node bin/release-watch.mjs compare OLD_RELEASE NEW_RELEASE \
  --vendor-domain vendor.example --out report
```

A release is an Electron distribution directory (`resources/app.asar`, the
runtime executable and helpers), an extracted app directory, or an `.asar`
file. The command writes `report.html`, `report.md` (for CI comments),
`report.json` and every REA Evidence record it used under `evidence/`.

Exit status is `2` when a finding reaches `--fail-on` (default `high`), `0`
below it, and `1` for usage or analysis errors, so a CI job can gate rollout.

## Demo

`demo/run-demo.sh` builds two releases of a fictional app, Acme Notes, around a
real Electron 38.2.0 runtime (downloaded from GitHub and checked against the
pinned SHA-256), then reviews the update. Version 1.5.0 adds a legitimate
cloud-sync feature plus the changes a compromised build pipeline might ship:

- a renderer API that reaches `child_process.exec`,
- an hourly beacon to a new third-party host,
- the renderer sandbox turned off,
- Electron's hardening fuses reset to defaults,
- a Go updater helper with a vendored, checksum-less dependency and a
  linker-injected endpoint.

Release Watch blocks the update with 1 critical, 4 high, 1 medium and 3 low
findings, and grades the sync feature low. The fixtures are never executed;
their hosts use reserved `.example` domains.

Requirements: Linux x64, Go, `curl`, `unzip`, and the REA build. Set
`ELECTRON_ZIP` to reuse a downloaded `electron-v38.2.0-linux-x64.zip`.

### Demo video

`demo/video/` records the demo from a real run. The terminal scene replays
captured output at its captured times; the report scene scrolls through the
report that run wrote. It needs ffmpeg, Chromium (`CHROMIUM_PATH`) and the
`playwright-core` dev dependency of this repository.

```bash
node demo/video/capture-terminal.mjs "$work/releases" terminal.json
node demo/video/record-video.mjs --releases "$work/releases" \
  --terminal terminal.json --out release-watch-demo.mp4
```

## How it works

| Step              | REA operation                    | Used for                                                                                                   |
| ----------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Application graph | `analyze-javascript-application` | IPC handlers, bridge APIs, BrowserWindow options, imports, requests, child processes, timers, URL literals |
| Structural diff   | `compare-application-versions`   | REA's own comparison record, kept as Evidence                                                              |
| Runtime           | `inspect-electron-fuses`         | Fuse states and their runtime implications                                                                 |
| Helpers           | `inspect-go-binary`              | Go version, modules, checksums, build settings                                                             |
| Source lines      | `extract-artifact`               | Display only; a line is marked verified when the file's SHA-256 matches REA's digest                       |

Independent REA calls run in parallel. The demo review takes about 7 s on a
4-core Linux container with a warm file cache, and uses no model tokens.

## Findings

| Rule   | Severity   | Trigger                                                                                                              |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| RW-E01 | critical   | A new renderer bridge API whose IPC handler reads a binding imported from a module with a new process-execution site |
| RW-P01 | high       | Any other new process-execution site                                                                                 |
| RW-N01 | high / low | A new request site whose module holds a URL for a host outside the vendor's domains (high) or inside them (low)      |
| RW-N02 | medium     | A new request site with no resolvable destination                                                                    |
| RW-E02 | high       | `sandbox`, `contextIsolation`, `webSecurity` or Node integration moved to its unsafe value                           |
| RW-E03 | high       | Hardening fuses moved to their unsafe state                                                                          |
| RW-G01 | high       | A Go helper's `-ldflags` now sets a third-party URL                                                                  |
| RW-G02 | medium     | A new Go module dependency, noting a missing checksum                                                                |
| RW-G03 | low        | A Go helper lost `-trimpath`                                                                                         |
| RW-E04 | low        | A new renderer bridge API                                                                                            |

## What the report does not claim

- A fact seen only in the new release is "added" only when REA's coverage of
  the old release is complete. Otherwise it is reported as "not observed in"
  the old release, because REA's semantic coverage does not establish absence.
- RW-E01 connects REA facts by location: the IPC handler's source range, a
  binding read inside it, and the import that defines that binding. REA does
  not establish that the IPC argument reaches the `exec` command; the report
  says so.
- When REA does not resolve a request's URL argument, the destination is the
  URL literal defined in the same module. The report labels that association.
- Static analysis does not prove runtime behaviour. Neither release is run.

## Tests

```bash
npm test    # from products/release-watch
```

The CLI test runs the real REA build against the fixture app directories and
is skipped when REA has not been built.
