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
between modules or components is low and a second copy is not. A site whose
file moved unchanged pairs with its old copy first, wherever it is.

Reachability (RW-E01, RW-M01) follows REA's semantic graph: the functions
REA reports, the calls it resolved, the binding reads each function owns,
imports through their imported names, export bindings, re-exports and
namespace member reads, a parameter of a callback that an iteration method
runs, inline or through the binding that names it (`TOOLS.forEach((tool) =>
…)`, `TOOLS.forEach(register)`), to the elements it iterates, and a member
call on a receiver REA does not resolve (`this.run()`) to the method or
class field of that name the enclosing class or object defines, else to that
member of a binding the class reads outside its methods, such as the class
it extends. A read of a value (a handler map, a tool list, an instance, a
default-exported object) leads to what REA reports giving it a value: its
initializer, later assignments, property writes (`handlers.git = …`, and
`handlers[name] = …` for any member) and, by Release Watch's reading of the
built-in methods, the arguments of `push`, `unshift`, `set` and `add` calls
on it. A binding REA says holds a call's result gets that call's value; a
call made when the module loads gives the value only what it returns (the
class's methods for `new`, what a function written in place returns for
`(() => …)()`), not the code it runs. By the same reading, a built-in method
called on a value (`find`, `filter`, `slice`, `concat`, `get`, `values` and
the like) gives that value's elements, `keys()` and `Object.keys()` give no
function, and a callback whose result such a method does not keep (`find`,
`filter`, `forEach`) is not part of the value. A receiver a method is bound
back to (`repo.status.bind(repo)`) is reached only through `this`. REA
reports where an object or array literal ends only as the range of an
`export const` statement; Release Watch ends any other at the next
declaration, use, assignment, property write, event listener registration,
timer or discarded promise of its own scope (a later assignment ends only at
a use inside a call, since it can read the binding itself). Bindings REA
places in a nested function's scope, including a named function or class
expression's own name, do not end it. A member read leads to the functions
REA reports written to that member or names after it, or to every function
there when REA's property slots show only that member can hold one and the
value holds no more values than those slots; nowhere when they show it holds
a literal. A method REA names after another member is never taken for this
one. When REA's facts do not say which function a member read selects, which
part of an element a callback parameter read without a member holds (a whole
element, a destructured property or a key), or whether a call Release Watch
read as part of a literal is a statement after it, Release Watch follows
every candidate, the step says so, and the finding says the handler may
reach the process site. An import Release Watch cannot resolve to one of its
module's functions reaches every process site of that module, and the
finding says so.

## Findings

| Rule   | Severity            | Trigger                                                                                                                                                                                                                                                                       |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-E01 | critical            | A new renderer API whose IPC handler reaches process execution, inline, through an imported function that holds it, or through a same-module helper or value; "may reach" when the path follows a candidate Release Watch could not settle                                    |
| RW-E02 | high / medium       | A window set a `webPreferences` safeguard to its unsafe (high) or a dynamic or unresolved (medium) value, or a new window has one; windows pair release-wide, one old to one new, by what they load, the functions creating them, what holds them, then their options         |
| RW-E03 | high / medium       | A hardening fuse REA read as unsafe in any executable; medium when its old state was not established                                                                                                                                                                          |
| RW-E04 | low                 | New renderer APIs, one finding per component                                                                                                                                                                                                                                  |
| RW-M01 | critical            | An MCP tool registration that reaches more process execution of a kind than before, inline, imported or through a same-module helper or value; "may reach" unless more registrations reach it than before by paths that follow no candidate Release Watch could not settle    |
| RW-M02 | medium / low        | More MCP tool registration calls across the release (medium); a switch between a CallTool dispatcher and per-tool registration (low)                                                                                                                                          |
| RW-A01 | high / medium       | A new AI provider host (high; medium when only a URL near requests REA could not resolve suggests it), or one that browser code now calls, or holds a URL for, when no old browser code did, or a provider SDK browser code now imports when no old browser code did (medium) |
| RW-A02 | critical / high     | A credential-format string not shipped before, or one moved into browser code; critical in browser code                                                                                                                                                                       |
| RW-A03 | medium / low        | A new MCP server SDK (medium) or AI SDK (low)                                                                                                                                                                                                                                 |
| RW-A04 | low                 | Changed prose assigned to a variable in AI code                                                                                                                                                                                                                               |
| RW-A05 | medium              | A new HTML sink in browser code that fetches, in a component with an AI surface                                                                                                                                                                                               |
| RW-W01 | high / medium       | A new third-party `<script src>` host, or script code embedded in a `data:` or `javascript:` URL (high)                                                                                                                                                                       |
| RW-W02 | medium              | A new service worker in a component, noting one another component of the old release registered                                                                                                                                                                               |
| RW-W03 | low                 | Source maps with original sources, when the old release shipped none                                                                                                                                                                                                          |
| RW-W04 | low                 | New direct `eval`, outside files whose content the old release shipped                                                                                                                                                                                                        |
| RW-H02 | high / medium       | A security header the old capture sent is removed or changed                                                                                                                                                                                                                  |
| RW-H03 | critical / high     | The browser sends a credential to another party, critical for an AI provider                                                                                                                                                                                                  |
| RW-H04 | medium              | A cookie's weakest `Set-Cookie` lost `HttpOnly`, `Secure` or `SameSite` strength                                                                                                                                                                                              |
| RW-N01 | high / medium / low | A new destination host, third party (high; medium when only a URL near requests REA could not resolve suggests it) or vendor or deployment host (low)                                                                                                                         |
| RW-N02 | medium              | More request sites without a known destination in a module than before (REA resolved none, and the request reads no URL literal Release Watch binds it to), beyond those a removed site of the release or a new destination accounts for                                      |
| RW-N03 | medium              | A host now reached over `http://` or `ws://` that the old release reached only encrypted, from code that did not move unchanged                                                                                                                                               |
| RW-P01 | high / low          | New process execution or a changed command (high); a site that took a removed site with the same command, anywhere in the release (low)                                                                                                                                       |
| RW-G01 | high                | A Go helper's `-ldflags` sets a URL on a new third-party host, also for a new or newly identified helper                                                                                                                                                                      |
| RW-G02 | medium              | A new Go module dependency, noting a missing checksum                                                                                                                                                                                                                         |
| RW-G03 | low                 | A Go helper lost `-trimpath`                                                                                                                                                                                                                                                  |
| RW-G04 | medium              | A new helper executable                                                                                                                                                                                                                                                       |
| RW-D01 | low                 | New third-party packages imported, one finding per component                                                                                                                                                                                                                  |
| RW-C01 | high / medium       | REA examined only part of the new release (truncation, node ceilings, failed or unparsed files, a use of child_process REA classified no process call for, such as `promisify(exec)`); high when that code changed, unless its source map names no changed original source    |
| RW-C02 | low                 | A component, capture or module pairing available on one side only                                                                                                                                                                                                             |
| RW-C03 | medium              | The old release's fuses were readable and the new release's are not                                                                                                                                                                                                           |
| RW-C04 | medium              | A helper REA identified before is not identified now                                                                                                                                                                                                                          |
| RW-C05 | medium / low        | New or changed modules use an HTTP client library and REA recognised no request site in them, or import or are imported by such a module (low); low when a capture covers the release                                                                                         |
| RW-C06 | high / medium       | Changed modules import a library that starts processes (execa, cross-spawn, shelljs, zx, node-pty and the like), whose calls REA does not classify; high when a module imports it for the first time, medium when every such module imported it before                        |

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
  loads it, an omitted `webPreferences` option relying on Electron's default,
  the old BrowserWindow a new one is paired with.
- Windows pair first by what they load, then by the named functions that
  create them and the binding or member REA reports holding them, so a window
  that now loads what another window loaded is paired with that window. A
  call on one that holds several windows goes to the window created last
  before it in the same function, so windows created in two branches of one
  function are told apart by position; a call in another function leaves
  those windows' loads unknown. Windows left unpaired by these pair by
  options within their component, identical first and then the closest, so
  options swapped between them, or a window replaced by another with similar
  options, are not reported. Across components they pair by options only in
  a component new in the release, with the old windows no other component
  kept.
- A `webPreferences` value REA did not resolve is compared by its tokens,
  without spacing, comments, string quoting and the parentheses around a
  name, a member path, a literal or the whole expression. A renamed variable
  or other parentheses read as a change (medium), and REA reports a
  minifier's `!0` or `!1` as such a value, so a change between them is graded
  medium. REA gives no text for a whole options or `webPreferences` object it
  reports as dynamic, so a change inside one both releases use is not seen.
  An option set next to a spread or computed key is taken as set; REA does
  not report which comes first, so an unsafe value after one is graded
  medium, without claiming the old window had the safeguard.
- A capture records one session. It does not show which code sent a request
  or what other paths contact.
- REA reports neither where an object or array literal ends (outside an
  `export const` statement) nor which property an arrow function or a
  binding in a literal is (`{ status, deploy }`). A statement between a
  table and its first use that is not a declaration, a use, an assignment, a
  property write, an event listener registration, a timer or a discarded
  promise (a plain call such as `watch(() => …)`) is read as part of the
  table, and a member read of a map whose functions REA does not name
  reaches every function and binding the map holds that is not a method of
  another name. Unless REA's property slots bound the table, what such a call
  is given reaches only as a guess. Either way the finding says the handler
  may reach the process site.
- Arguments are not followed into the parameters of the function they are
  passed to, except the elements an iteration method passes to its callback
  and what `push`, `unshift`, `set` and `add` add to a value. REA does not
  say which part of an element a callback parameter holds, so a parameter
  read without a member (`({ name }) => …`, `([name, fn]) => …`) is followed
  to all of each element as a guess. A callback passed by name is followed
  only within its own module. `this.method()` is matched by name to a method
  or class field of the enclosing class, or of a binding the class reads
  outside its methods (the class it extends), and the finding says so; one
  that matches none is not followed. REA relates no value to other members
  of `this` (`this.tools[name]` after `this.tools = {…}`), and Release Watch
  does not follow them. A function stored by a function the value is passed
  to is not followed; one stored through a computed property
  (`handlers[name] = fn`) may be any member's.
- A process site whose command REA did not resolve is never taken as moved:
  a refactor that relocates one is reported high, with a note that it may be
  the same call.
- RW-P01 compares a process site's method and the command REA resolved (its
  first argument). REA reports the length of a literal argv array (none for
  `exec` or a computed array), not the argument values or options such as
  `shell: true`, so a changed argument list or a shell newly enabled at the
  same site is not reported.
- RW-C01 finds process calls REA did not classify through the values REA
  ties to child_process: import bindings, `require("child_process")` calls,
  bindings destructured from them, the parameters REA passes them to, and
  imports of a local module's export that REA traces to child_process
  (`module.exports = require("child_process")`, `export { execSync } from
  "node:child_process"`), followed through re-exports. A `require(name)`
  counts when REA reports `name` constant "child_process". Release Watch's
  correlations are labelled heuristic: a binding declared or assigned right
  before a read of such a value, when REA gives it the same unknown value
  (`const proc = cp`, not `const ready = typeof cp === "object"`), or right
  before a read of a member, when REA reports its value unknown and no call
  assigns it (`const run = cp.execFile`; REA's facts do not tell this from
  `const ok = typeof cp.spawn === "function"`, which is taken alike); an
  interop wrapper of the `require` (`__importStar(require(...))`); an
  export REA traced no source for, matched by the name of a binding of the
  exporting module that holds child_process (`module.exports = { spawn }`);
  a pattern destructured right before a load REA links to no binding; and
  a load REA resolves no module for (`require(name)`, `module.require`,
  `process.mainModule.require`, `window.require`, the function
  `createRequire` returns, `eval("require")`), which counts only where a
  child_process export (`exec`, `execSync`, `execFile`, `execFileSync`,
  `spawn`, `spawnSync`, `fork`) is read on what it loads. A name alone never
  counts, so a saga's `fork` or a game's `world.spawn` is not a process
  API. Not seen: a value a local module derives from child_process
  (`module.exports = { run: promisify(exec) }`) or exports under another
  name (`module.exports = { run: spawn }`), a guessed load used without a
  child_process export name, and code REA does not parse (`new Function`,
  the source string `eval` runs). A read of child_process that REA's graph
  does not follow (`if (!cp)`) is reported as a gap on that read.
- RW-C06 notes that changed modules import a process library; what those
  libraries run is not examined, and a library bundled into a file without
  an import is not seen. A module whose content the old release shipped,
  under any path, did not change.
- Browser code is classified from what HTML pages and service workers load.
  Dedicated workers and scripts loaded at runtime are not classified, so a
  call that moved from a worker into page code is reported at medium.
- REA does not report MCP tool names, so Release Watch counts registration
  calls; a switch of registration API is reported low without a count.
- An unresolved request pairs with a removed one across components only when
  its file moved unchanged; otherwise a request with no known destination
  that moved between components is reported medium. An HTML sink pairs only
  with one in an unchanged file. Browser placement, shipped original sources,
  known, guessed and named hosts and the schemes they were reached over are
  compared with the whole old release. An `eval`, or an HTTP client import
  RW-C05 would note, in a file whose content the old release shipped is not
  new, nor is a cleartext request whose request, URL constant and client
  modules, and the modules an import of the URL passed through, all have
  such content, so code that moved between components keeps what it had.
  Page scripts, service workers, direct `eval`, HTML sinks, renderer APIs,
  process sites, MCP tool registration calls and native helpers are
  compared per component: one
  another component of the old release had at the same key (an API name, a
  module path and method, a helper path) is reported as new to its
  component, and the claim says another component had it rather than that
  the old release lacked it. A new component's RW-M02 gives the release's
  registration totals instead of comparing its calls with the old release.
- A URL literal in a module that imports an HTTP client REA does not model
  (axios, got, ky), or one such a module reads from an import (a constant,
  an object property, a namespace member), is a possible destination, not
  an observed one: it is reported medium, titled and explained as a guess.
  A URL in a module that only imports such a module is not taken as one;
  RW-C05 notes the module when it changed. REA reports no literal for a URL
  in an anonymous default-exported object, so such a URL is not reported. A host the
  old release only guessed at is new once the new release is seen
  contacting it, and the finding says the old release held its URL. A URL
  old browser code only held is not an old browser call.
- Calls through a provider SDK carry no host REA reports: browser code that
  imports one (openai, @anthropic-ai/sdk and other single-provider clients)
  is reported as a possible direct call to that provider, medium.
  Frameworks and clients that may call the vendor's own or a local server
  instead (Vercel AI SDK, LangChain, LlamaIndex, Ollama) are not.
- A request that reads a URL constant or an object property REA reports a
  literal for (`TELEMETRY_URL`, `ENDPOINTS.telemetry`, `C.TELEMETRY_URL`
  through a namespace import), in its module or imported through export
  bindings and named, namespace and star re-exports, is attributed to that
  URL, and RW-N02 does not count it. A computed member (`ENDPOINTS[key]`)
  is not attributed and stays an unresolved request.
- REA reports strings assigned to variables and URLs it resolved. A key
  written inline in a call or a header is not seen by RW-A02, and a request
  that reads a URL variable is attributed to that URL even if it transforms
  it first.
- Static analysis does not prove runtime behaviour.

## Redaction

Reports never contain credential values in the formats Release Watch knows.
Every report passes through one boundary (`src/redact.mjs`) that masks
documented credential formats and JWTs wherever they appear, replaces URL
query values, fragments, user info, path parameter values (`;jsessionid=`)
and token-like path segments with a tag such as `‹3f9c2a›`, and writes
control and bidirectional characters as `\uXXXX` in `report.json` (spaces in
rendered output). Tags are keyed per run, equal values share a tag within a
report and different values never do (a tag grows past six hex digits when
another value holds it), a claim and a source line give a URL part the
same tag, and scrubbing a tagged text again keeps its tags. A query with more than 64
pairs shows its first 64 values as tags and the rest as one tag. A field
that cannot be scrubbed is withheld rather than written. Header values are
read as prose: relative URLs such as `report-uri csp/r/<token>`,
`csp-report#…`, `?token=…` and `csp-report;jsessionid=…` are masked like
absolute ones. Paths the caller chose (inputs, Evidence and output files)
and local paths in error and coverage text are shown as given, with only
credential formats masked.

Source lines shown next to evidence are masked by span on a bounded window
of the line, whatever the code's syntax: random-looking runs (hex, UUIDs,
base62 and base64), JWTs, Bearer and Basic values and `btoa("user:pw")`,
values after a credential-like name (key, token, secret, auth, pass, pwd,
sig, signature, appid, client_id and the like) in code, JSON, form bodies,
headers, bracketed keys, setters such as `setPassword("…")`, call arguments
and `||`, `??` or ternary fallbacks, unquoted values in comments and
template text or mixing letters and digits, strings that follow `?name=`
pieces or end user info with `@`, URL parts as their claims show them, and
escaped character runs. Code that only reads a secret stays readable, and so
do names made of word-like pieces such as `sendAnalyticsEventV2Async`,
`@aws-sdk/client-route-53-domains` or `claude-3-5-sonnet-20241022`; a
template's `${…}` interpolations are code. HTML character references are
decoded only in `.html`, `.htm`, `.xhtml`, `.svg` and `.xml` files, where
tabs and line breaks in a quoted URL do not split its values. Text near the
cut edge of a long line, and the rest of the URL or value it falls in, is
not shown. On a line where REA reported a key, and on up to four lines that
continue it (after `+`, `,`, `[`, `(`, inside a template or a continued
string), every string is masked except the readable parts of URLs and short
keyword-like strings such as HTTP methods and header names. A 40 or 64 hex
path segment is kept only before a static asset file, and content-hashed
file names keep their name, including a static asset named only by its hash.
A `<script src>` starting with two slashes or backslashes is read as
protocol-relative, as browsers read it.

Markdown output is escaped so release content cannot add headings, links or
HTML to a pull-request comment. REA redacts transport credentials in
captures itself. The saved Evidence under `evidence/` is REA's output
verbatim and can hold the raw values a release ships; treat that directory
as sensitive.

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
