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

Components pair by name. Of those left unpaired, a component on each side
with the same kind of target is taken as renamed when it is the only such one
on each side, or else with the one whose files (by path and size) overlap most
with its own, when at least 30% of the two components' files are shared;
otherwise one is reported missing and the other new. A renamed component is
shown as `old → new`; claims about each side name that side's component, and
its Evidence files carry that side's name. Without `--vendor-domain`, the host
a capture of any component starts its session on, its first page load's, is
the site itself for every component, not a new destination, while the hosts
that page load redirects through, such as a sign-in at an identity provider or
an apex redirected to `www`, are the site only for the captured component. A
host on a vendor domain is first party for every component.

The command writes `report.html`, `report.md` (for CI and pull-request
comments), `report.json`, and every REA Evidence record it used under
`evidence/`. Exit status is `2` when a finding reaches `--fail-on` (default
`high`); `1` when REA produced no facts at all for a component and no finding
reached the threshold; and `0` otherwise, so a CI job can gate the rollout.
Code REA examined only in part is not an error: it is reported as RW-C01,
high when the unexamined code changed, and `--depth deep` examines more of
large bundles ([Limits and cost](#limits-and-cost)).

| Option                                                                               | Effect                                                                                                                      |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `--vendor-domain <domain>`                                                           | Hosts on this domain are first party; repeat for several. `*.x.com` and URLs are accepted.                                  |
| `--fail-on <severity>`                                                               | `critical`, `high`, `medium`, `low` or `never`                                                                              |
| `--rea-compare <auto\|always\|never>`                                                | When to ask REA to pair renamed modules; `auto` skips it when no file could be a rename or the Evidence exceeds 64 MB       |
| `--depth <standard\|deep>`                                                           | REA's semantic node limits ([Limits and cost](#limits-and-cost)); `deep` examines more of large bundles, one side at a time |
| `--max-semantic-nodes <n>`, `--max-semantic-nodes-per-file <n>`, `--max-heap-mb <n>` | Replace that one limit of the depth                                                                                         |
| `--jobs <1\|2>`                                                                      | Analyze the two sides together (2) or one at a time (1), which lowers peak memory; default 2, and 1 with `--depth deep`     |
| `--rea <path>`                                                                       | REA CLI to use (default: this checkout, then `rea` on `PATH`)                                                               |

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
module and method, destinations by host, prompts by the variable or object
property they are assigned to. A module with more sites of one kind than
before is reported once, with both counts, because Release Watch cannot tell
which site is new.
Across the release, each site a component gained is paired with at most one
site a component lost, by method and resolved command, so a call that moved
between modules or components is low and a second copy is not. A site whose
file moved unchanged pairs with its old copy first, wherever it is, and an
old site whose file content now ships under another path pairs only with a
site in that copy. An old site the new facts lack is lost only when its
file is gone from its component or changed there and REA examined it in
full: one in a file the new side still ships unchanged was not removed,
and one in a file REA examined there only in part (or not at all) is
unknown, so a new site with its command stays high and the finding says
it may be that call, moved. Requests without a known destination follow
the same rule: such a new request is reported (RW-N02) with the same note.

Reachability (RW-E01, RW-M01) follows REA's semantic graph: the functions
REA reports, the calls it resolved, the binding reads each function owns,
imports through their imported names, export bindings, re-exports
(`export *` never gives `default`; a CommonJS `module.exports =
require("./other")` gives the other module's names) and namespace member
reads, a parameter of a callback that an iteration method
runs, inline or through the binding that names it (`TOOLS.forEach((tool) =>
…)`, `TOOLS.forEach(register)`), to the elements it iterates, and a member
call on a receiver REA does not resolve (`this.run()`) to the method or
class field of that name the enclosing class or object defines, else to that
member of a binding the class reads outside its methods, such as the class
it extends. A member read REA's nodes place on an expression, parenthesized
or not and in any layout, is that expression's: `(await connect()).run()`
and `( await connect() ).run()` are not `this.run()`, and
`runGit(args).pid` reads the call's result, not a member of `runGit`. One
they place on no single expression (`(a || b).run()`) is matched to `this`
only as a guess. A read of a value (a handler map, a tool list, an instance, a
default-exported object) leads to what REA reports giving it a value: its
initializer, later assignments, property writes (`handlers.git = …`, and
`handlers[name] = …` for any member) and, by Release Watch's reading of the
built-in methods, the arguments of `push`, `unshift`, `set` and `add` calls
on it. A binding REA reports destructured (`const { handler } = TOOL`, `for
(const { handler } of TOOLS)`) reads the property REA names of what its
pattern destructures, wherever it sits in the pattern, and its default
value (`{ handler = noop }`). For a computed key (`const { [key]: run } =
TOOL`) REA reports no destructuring but that it could not project the
binding's value, and Release Watch follows all of what the pattern
destructures as a guess. REA reports neither for a rest element, a nested
pattern with its own default or a computed key in a `for…of` pattern;
Release Watch reads such a binding's value from what follows it in the
pattern (`= TOOL`). Of the `[key, value]` pairs `entries()` and
`Object.entries()` give, one pair (a `for…of` element, what `find()` or
`at()` gives) holds a key (no function) and the element, and an index into
them (`Object.entries(H)[0]`) selects a pair. A binding REA says holds a
call's result gets that call's value; a
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
element, a destructured property or a key), which property a destructuring
with a computed key or of a computed member takes (`const { handler } =
TOOLS[name]`), or whether a call Release Watch
read as part of a literal is a statement after it, Release Watch follows
every candidate, the step says so, and the finding says the handler may
reach the process site. So it does past 8 members of a member chain: a
value that reads its own property writes back
(`l.models.fallback = { ...l.models.main }`) lengthens the chain each
time, so Release Watch takes all of what the first 8 members select. An
import Release Watch cannot resolve to one of its module's functions
reaches every process site of that module, and the finding says so.

## Findings

| Rule   | Severity            | Trigger                                                                                                                                                                                                                                                                       |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-E01 | critical            | A new renderer API whose IPC handler reaches process execution, or a kept one that reaches a site running no command its old handler ran, inline, imported or via a same-module helper or value; "may reach" when every path follows a candidate it could not settle          |
| RW-E02 | high / medium       | A window set a `webPreferences` safeguard to its unsafe (high) or a dynamic or unresolved (medium) value, or a new window has one; windows pair release-wide, one old to one new, by what they load, the functions creating them, what holds them, then their options         |
| RW-E03 | high / medium       | A hardening fuse REA read as unsafe in any executable; medium when its old state was not established                                                                                                                                                                          |
| RW-E04 | low                 | New renderer APIs, one finding per component                                                                                                                                                                                                                                  |
| RW-M01 | critical            | An MCP tool registration (per-tool or a CallTool dispatcher) reaching more process execution of a kind than before, inline, imported or via a helper or value; "may" unless more reach it by unguessed paths; "perhaps as before" via old files REA partly analyzed           |
| RW-M02 | medium / low        | More MCP tool registration calls across the release (medium); a switch between a CallTool dispatcher and per-tool registration (low)                                                                                                                                          |
| RW-A01 | high / medium       | A new AI provider host (high; medium when only a URL near requests REA could not resolve suggests it), or one that browser code now calls, or holds a URL for, when no old browser code did, or a provider SDK browser code now imports when no old browser code did (medium) |
| RW-A02 | critical / high     | A credential-format string not shipped before, or one moved into browser code; critical in browser code, high when it moved there from code Release Watch classifies neither as browser nor as server code                                                                    |
| RW-A03 | medium / low        | A new MCP server SDK or framework (medium; low when the component already served MCP through another), another MCP SDK package (client, HTTP transport, shared code) or AI SDK (low)                                                                                          |
| RW-A04 | low                 | Changed prose a variable or object property of AI code holds, whose new text no string of the old module had                                                                                                                                                                  |
| RW-A05 | medium              | A new HTML sink in browser code that fetches, in a component with an AI surface                                                                                                                                                                                               |
| RW-W01 | high / medium       | A new third-party `<script src>` host, or script code embedded in a `data:` or `javascript:` URL (high)                                                                                                                                                                       |
| RW-W02 | medium              | A new service worker in a component, noting one another component of the old release registered                                                                                                                                                                               |
| RW-W03 | low                 | Source maps with original sources, when the old release shipped none                                                                                                                                                                                                          |
| RW-W04 | low                 | New direct `eval`, outside files whose content the old release shipped                                                                                                                                                                                                        |
| RW-H02 | high / medium       | A security header the old capture sent is removed or changed                                                                                                                                                                                                                  |
| RW-H03 | critical / high     | The browser sends a credential to another party, critical for an AI provider                                                                                                                                                                                                  |
| RW-H04 | medium              | A cookie's weakest `Set-Cookie` lost `HttpOnly`, `Secure` or `SameSite` strength                                                                                                                                                                                              |
| RW-N01 | high / medium / low | A new destination host, third party (high; medium when only a URL near requests REA could not resolve suggests it) or vendor or deployment host (low)                                                                                                                         |
| RW-N02 | medium              | More request sites without a known destination in a module than before (REA resolved none, and the request reads no URL literal Release Watch binds it to), beyond those a removed site or a new destination accounts for; "not observed" if REA examined the old one in part |
| RW-N03 | medium              | A host now reached over `http://` or `ws://` that the old release reached only encrypted, from code that did not move unchanged                                                                                                                                               |
| RW-P01 | high / low          | New process execution or a changed command (high); a site that took a removed site with the same command, anywhere in the release (low)                                                                                                                                       |
| RW-G01 | high                | A Go helper's `-ldflags` sets a URL on a new third-party host, also for a new or newly identified helper                                                                                                                                                                      |
| RW-G02 | medium              | A new Go module dependency, noting a missing checksum                                                                                                                                                                                                                         |
| RW-G03 | low                 | A Go helper lost `-trimpath`                                                                                                                                                                                                                                                  |
| RW-G04 | medium              | A new helper executable                                                                                                                                                                                                                                                       |
| RW-D01 | low                 | New third-party packages imported, one finding per component                                                                                                                                                                                                                  |
| RW-C01 | high / medium       | REA examined only part of the new release (truncation, node ceilings, failed or unparsed files, a use of child_process REA classified no process call for, such as `promisify(exec)`); high when that code changed, unless its source map names no changed original source    |
| RW-C02 | low                 | A component, its application code, a capture or a module pairing available on one side only                                                                                                                                                                                   |
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
  release's analyzed code or capture. A claim that a component's old side
  lacked a fact, or that the old release did not contact a host, names any
  other old component whose code REA did not analyze.
  A site (a process call, request, HTML sink, `eval` or tool registration) in
  a file the component's old side shipped with the same content, at its
  path or the one it was renamed from, is not new even when REA's facts of
  the old copy lack it: REA examined that copy only in part, and the
  inventory lists the site as in an unchanged file. A command or destination
  such a site reads from another module can still change.
- A component whose new side REA could not analyze, holds nothing REA can
  analyze or is a capture only loses nothing: its old process sites, tool
  registrations and windows are unknown, not gone, so they explain no new
  site elsewhere, and release totals leave it out and say so. One whose old
  side REA could not analyze or holds nothing REA can analyze is graded on
  coverage only, and its analysis error decides the verdict; one whose old
  side is a capture only has its new code reported as not observed before.
- An old file REA examined only in part or not at all (at the per-file node
  ceiling, left without semantic facts after the global node limit, or
  failed) is unknown, not absent. A finding in it says what it reports may
  predate the release; every other finding about the new release ends with
  one sentence that counts the old files REA did not fully examine, names
  two of them and says when REA reached its global node limit there, after
  which any old file may be partial. Findings that report coverage itself
  (RW-C01 to RW-C04) do not carry it. A count of old sites is what REA
  observed: RW-N02 does not call sites new when REA examined the old module
  only in part, gave it no semantic facts or could not analyze it, or
  reached its global node limit on the old release. An import of a file
  whose imports REA's graph does not report on the other side (REA recorded
  a failure and no import relationship for it) is "not compared" rather
  than new or gone, and RW-D01 does not call the package new.
- Correlations are labelled heuristic: an IPC handler reaching an imported
  exec site, an MCP registration containing one, the calls counted as MCP
  tool registrations, a request attributed to a URL literal in the same
  module, a module counted as browser code because a page loads it, an
  omitted `webPreferences` option relying on Electron's default, the old
  BrowserWindow a new one is paired with, and a timer cited next to a new
  destination's requests because the request is written inside its call,
  its call reads a binding REA declares as a function around the request, or
  REA places both in one function (three such timers at most, then a count).
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
- RW-E01 compares a renderer API the component already exposed with what
  Release Watch connected its old handler to, settled or guessed, by process
  method and the command REA resolved: a handler that now reaches another
  site running a command it reached before is not reported. A site whose
  command REA did not resolve matches only the old site at its place among
  a module's sites of that method the release kept unchanged, so one whose
  unresolved command changed in place is not reported. Any other such site,
  or a resolved command where the old handler reached a site of that method
  whose command REA did not resolve, is reported without "now" and with an
  unknown that it may run a program the handler already ran. When REA
  resolved no old handler for the API's channel, the API is compared with
  each old handler whose channel REA did not resolve, any of which may have
  served it: a site counts as one it ran only when each of them ran it, and
  is reported without "now" when they differ.
- A process site whose command REA did not resolve is never taken as moved:
  a refactor that relocates one is reported high, with a note that it may be
  the same call. When an MCP tool reaches it, RW-M01 carries the same note and
  says how many old tool registrations reached a site of that method with an
  unresolved command; when a renderer API reaches a new site, RW-E01 carries
  the notes RW-P01 would.
- RW-P01 compares a process site's method and the command REA resolved (its
  first argument). REA reports the length of a literal argv array (none for
  `exec` or a computed array), not the argument values or options such as
  `shell: true`, so a changed argument list or a shell newly enabled at the
  same site is not reported. A changed key's finding names each command
  REA resolved, masked as a source line is (a Bearer or Basic value,
  curl's `-u user:password`, credential formats, URL user info, a value
  after a credential-like name such as `API_KEY=…`; another tool's password
  option, such as `sshpass -p`, is not). A command is called new only when
  REA resolved every command the old side ran at that module and method;
  where REA did not resolve a command on either side (`spawn("/bin/bash")`
  becoming `spawn(shell)`), the finding stays high and says which commands
  or sites may be the same; it counts the old sites REA did not resolve as
  sites, since two of them may run one command.
- RW-C01 finds process calls REA did not classify through the values REA
  ties to child_process: import bindings, `require("child_process")` calls,
  bindings destructured from them, the parameters REA passes them to, and
  imports of a local module's export that REA traces to child_process
  (`module.exports = require("child_process")`, `export { execSync } from
  "node:child_process"`), followed through re-exports and any number of
  local modules. A `require(name)`
  counts when REA reports `name` constant "child_process". Release Watch's
  correlations are labelled heuristic: a binding declared or assigned right
  before a read of such a value, when REA gives it the same unknown value
  (`const proc = cp`, not `const ready = typeof cp === "object"`), or right
  before a read of a member, when REA reports its value unknown and no call
  assigns it (`const run = cp.execFile`; REA's facts do not tell this from
  `const ok = typeof cp.spawn === "function"`, which is taken alike); an
  interop wrapper of the `require` (`__importStar(require(...))`); an
  export REA traced no source for, matched by the name of a binding of the
  exporting module that holds child_process (`module.exports = { spawn }`,
  also when that binding is imported from another such module);
  a pattern destructured right before a load REA links to no binding; and
  a load REA resolves no module for (`require(name)`, `module.require`,
  `process.mainModule.require`, `window.require`, the function
  `createRequire` returns, `eval("require")`, a binding that holds
  `require`: one declared right before a read of it, `const load =
  require`, or one REA's data flow shows `require` reaching, such as
  esbuild's `__require` shim), which counts only where a child_process
  export (`exec`, `execSync`, `execFile`, `execFileSync`, `spawn`,
  `spawnSync`, `fork`) is read on what it loads. A name alone never
  counts, so a saga's `fork` or a game's `world.spawn` is not a process
  API. Not seen: a value a local module derives from child_process
  (`module.exports = { run: promisify(exec) }`) or exports under another
  name (`module.exports = { run: spawn }`), a guessed load used without a
  child_process export name, and code REA does not parse (`new Function`,
  the source string `eval` runs). A read of child_process that REA's graph
  does not follow (`if (!cp)`) is reported as a gap on that read. A
  side-effect `import "child_process"` binds nothing and is no gap. REA
  reports no statement facts, so a `require("child_process")` whose result
  is discarded (rollup's CommonJS output for that import) reads as one
  whose result REA's graph does not follow (`x || require(…)`), and is
  still reported as a possible gap; RW-C01 lists such loads after the
  gaps at a use REA's graph shows. A
  method called on what a process call returns (`execSync(cmd).trim()`)
  is reported as that call (`calls execSync`). TypeScript declaration
  files (`.d.ts`, `.d.mts`, `.d.cts`) run nothing and are not examined.
  REA leaves out type-only imports (`import type`), but reports a type
  annotation in a `.ts` source as a read, so a child_process import used
  only in types there may be reported as a gap.
- RW-C06 notes that changed modules import a process library; what those
  libraries run is not examined, and a library bundled into a file without
  an import is not seen. A module whose content the old release shipped,
  under any path, did not change, and a declaration file's import of one
  starts nothing.
- Browser code is classified from what HTML pages and service workers load.
  Dedicated workers and scripts loaded at runtime are not classified, so a
  call that moved from a worker into page code is reported at medium, and a
  key that moved from such code into page code at high. Release Watch takes
  as server code, labelled heuristic, a module that imports a Node.js
  built-in for host I/O (any `node:` specifier, `fs`, `http`,
  `child_process` and the like) and what it imports, in a component no HTML
  page or service worker loads code from; a key that moved from there into
  browser code is critical.
- A component is an MCP server when one of its modules imports an MCP
  server SDK or framework: `@modelcontextprotocol/sdk/server` (the TypeScript
  SDK's v1), `@modelcontextprotocol/server` (v2), `mcp-handler`
  (`@vercel/mcp-adapter`), `fastmcp` or `mcp-framework`; a package installed
  beside the code is not one. Its tool registrations are the calls, on any
  receiver, of a member the imported SDK or framework registers tools
  through: `registerTool` (also `registerToolTask` and `tool` for v1 and
  mcp-handler), `addTool` (also `addTools` for fastmcp), and a v1
  `setRequestHandler` call whose own first argument (not one of a call in
  its receiver, as in `sessions.get(id).setRequestHandler(…)`) reads
  `CallToolRequestSchema`: as a member (`types.CallToolRequestSchema`), or
  as a binding that REA's import facts show holding that export under any
  name (a minified `import { CallToolRequestSchema as c }`, also through a
  local module's re-export); ListTools, Initialize and resource handlers
  are not. A module that imports
  a server SDK and defines an `addTool` method, as a bundled FastMCP does, has
  its component's `addTool()` calls counted too. REA does not report the
  method string a v2 `setRequestHandler("tools/call", …)` is given, so v2
  dispatchers are not counted, nor are tools mcp-framework discovers from a
  directory as `MCPTool` classes or tools passed to a server's constructor;
  RW-P01 still grades the process sites their handlers reach. A tool that
  moved from `tool()` to `registerTool()` keeps its capability. Another
  package of the SDK (a client, v2's HTTP transports and middleware, or
  shared code such as types) is a new MCP SDK package for RW-A03, worded by
  that role and not as code that talks to AI models.
- RW-M01 compares, per kind of process execution, how many tool
  registrations each side's facts connect to it; REA does not identify a
  tool across releases. When the paths that make the count grow pass
  through a file whose old counterpart REA analyzed only in part (a node
  ceiling, a file it could not analyze, the global limit; for a
  content-hashed bundle nothing paired, any old bundle of its name), the old
  tools may have reached the site the same way: the finding is titled
  "perhaps as before" and names those old files. A new tool whose path
  crosses such a file is worded the same way.
- REA does not report MCP tool names, so Release Watch counts registration
  calls and cites the last ones of a module by position, saying it cannot
  tell which is new; a switch between a CallTool dispatcher and per-tool
  registration is reported low without a count.
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
  the old release lacked it. So does a process site in a file whose content
  the old release shipped under another path: the claim says another
  component shipped the file, or that the component's old side shipped it
  under another path. A new component's RW-M02 gives the release's
  registration totals instead of comparing its calls with the old release.
- A URL literal in a module that imports an HTTP client REA does not model
  (axios, got, ky), or one such a module reads from an import (a constant,
  an object property, a namespace member), is a possible destination, not
  an observed one: it is reported medium, titled and explained as a guess.
  A URL in a module that only imports such a module is not taken as one;
  RW-C05 notes the module when it changed. A declaration file sends
  nothing, so RW-C05 neither counts it nor follows its imports and
  re-exports. REA reports no literal for a URL
  in an anonymous default-exported object, so such a URL is not reported.
  A host the old release only guessed at is new once the new release is
  seen contacting it, and the finding says the old release held its URL. A
  URL old browser code only held is not an old browser call.
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
- RW-A04 takes text as new only when the old module held no string
  literal with that value under any name, because a minifier renames
  variables freely; prompts swapped between variables are not reported.
  Each value is tested on its own, since a minified name holds unrelated
  strings in other scopes. Prose is not taken as a prompt when every read
  REA reports of its variable is the message of an `Error` constructor or a
  `console` method, or when it is a bundled package.json value: REA places
  it under a manifest field (`scripts`, `description` and the like) of an
  object REA also reports a `version` string for, and that object holds a
  field only a package.json has (`scripts`, `dependencies`) or REA reports
  no read of the field, so an agent card's description read into an AI
  call is a prompt. The old text quoted is the name's own when the new
  module no longer holds it; otherwise the finding says the old text is
  still there under another name and quotes, as Release Watch's pairing,
  the old module's prompt text the new one no longer holds when there is
  exactly one. Markup documents (an SVG icon, an XML or HTML page) are not
  prose.
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
base62 and base64), JWTs, Bearer and Basic values, `btoa("user:pw")` and
curl's `-u user:pw` (`--user`, `-U`, `--proxy-user`), values after a
credential-like name (key, token, secret, auth, pass, pwd, sig, signature,
appid, client_id and the like) in code, JSON, form bodies, headers,
bracketed keys, setters such as `setPassword("…")`, call arguments
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
file names keep their name, including a static asset named only by its hash
and one whose name ends in one or two of the 8-character base64url or
base32 hashes Rollup, Vite and esbuild write by default
(`config-manager-DsRE1v6M.js`, `start.BqU1RQ7V.js`) after a name that is
not itself random-looking; a longer run in a URL path stays masked. Claims,
evidence locations and source lines read file names by this one rule.
A `<script src>` starting with two slashes or backslashes is read as
protocol-relative, as browsers read it.

Markdown output is escaped so release content cannot add headings, links or
HTML to a pull-request comment. REA redacts transport credentials in
captures itself. The saved Evidence under `evidence/` is REA's output
verbatim and can hold the raw values a release ships; treat that directory
as sensitive.

## Limits and cost

REA's JavaScript analysis keeps a bounded number of semantic nodes (the
functions, calls, bindings, requests and literals the rules read) per file and
per side, with a bounded analyzer heap. Code a limit cuts short is reported as
RW-C01 (a TypeScript declaration file runs nothing and is not counted),
never passed, and RW-C01 names the depth or option that would raise
the limit REA reached, with the limits that re-run would use: an option you
gave keeps its value at any depth, so RW-C01 names it when it is the limit
that binds. RW-N02 gives the same advice when a limit left the old count of
a module's requests unknown. `--depth` picks the limits:

| Depth                | Semantic nodes | In one file | Analyzer heap | Sides at once |
| -------------------- | -------------- | ----------- | ------------- | ------------- |
| `standard` (default) | 150 000        | 120 000     | 1024 MiB      | 2             |
| `deep`               | 220 000        | 200 000     | 1024 MiB      | 1             |

`--max-semantic-nodes`, `--max-semantic-nodes-per-file`, `--max-heap-mb` and
`--jobs` each replace that one value of the depth, so `--depth deep --jobs 2`
analyzes both sides at once with the deep limits. `report.json` records the
settings under `run.analysis`, and each application Evidence records the
limits REA received. REA accepts up to 1 000 000 nodes and a 16 384 MiB heap;
its own defaults, which Release Watch used before, are 100 000 nodes, 20 000
in one file and 1024 MiB.

- **`standard`** suits most reviews: with both sides at once, 17 of the 22
  release pairs measured peaked under 3.2 GiB and the other five at
  3.2–3.8 GiB; the highest, `flowise-ui` and `swagger-ui-dist` at 3.8 GiB
  (4.1 GB), sit at the edge of a 4 GB budget. How far
  the two sides' analyses overlap moves that peak: `swagger-ui-dist` peaked
  at 3.6 GiB at REA's defaults here and at 5.2 GiB in an earlier run on an
  idle machine. `--jobs 1` runs the two analyses in sequence, so their
  peaks cannot add up: `@nuxt/devtools` then peaked at 2.1 GiB instead of
  3.7 GiB. Use it on runners with less than 8 GB of memory, or for a
  release that reaches the global limit on both sides.
- **`deep`** helps a release dominated by one or two large bundles when
  RW-C01 names it: it examined `deep-chat`, `@notionhq/notion-mcp-server`
  and `@vitest/ui` in full, which `standard` could not, for 1.2–1.8 times
  the CPU time. Analyzing one side at a time, its peaks were close to or
  below `standard`'s for the same release: 1.9–2.5 GiB against 2.6–2.8 GiB
  for `@notionhq/notion-mcp-server` over three runs each, 2.4 GiB against
  2.5 GiB for `@vitest/ui`.
- **Releases of many bundles** gain little from `deep`.
  desktop-commander and `flowise-ui` reached the deep global limit with the
  same files unreached as at `standard` (73 and 323), and `@nuxt/devtools`
  left 22 instead of 62. On such releases `standard` can leave more files
  without any semantic facts than REA's defaults did, since one bundle can
  take more of the global limit: desktop-commander 0.2.52 had 2 files at
  the file limit and 20 unreached at the defaults, and none at the file
  limit but 64 unreached at `standard`. Every finding
  about the new release then says what it reports may have been there
  before, naming some of those old files. REA also admits analysis results
  only up to about half its CLI process's heap limit, which Node.js sets
  from the machine's memory (8 GiB here) and no option here raises. At the
  deep depth REA rejected two `@nuxt/devtools` files and four
  `swagger-ui-dist` files on that budget ("exceeds the parent's result
  budget"; three at 200 000 nodes). The budget follows REA's live heap, so
  which files it rejects can differ between runs, and a rejected file can be
  missing from the application graph, so the report's file inventory lists it
  as new or gone although both releases ship it. A file whose relationships
  REA rejected has no import facts either: at the deep depth the old
  `swagger-ui.js` of `swagger-ui-dist` 5.32.15 imports nothing REA reports, so
  RW-D01 and the imports inventory list the 31 packages the new one imports as
  not compared, where `standard` finds one new package
  (`@tanstack/react-virtual`).

The values follow these measurements:

- **Memory follows retained nodes.** Each side's REA process holds its
  semantic graph while it writes the Evidence, and Release Watch then holds
  both sides' facts. `@nuxt/devtools`, which reaches the global limit on
  both sides, peaked at 2.6, 3.7 and 4.8 GiB at 100 000, 150 000 and
  200 000 nodes: 150 000 kept it under 4 GB, 200 000 did not.
- **The largest single files** needed 116 000 nodes (`aicommits`), 164 000
  (`@notionhq/notion-mcp-server`), 185 000 (`@vitest/ui`) and 191 000
  (`@browserbasehq/stagehand`). The standard per-file limit covers the
  first and the deep one the rest; a file that takes most of the global
  limit leaves the rest of the side less, as `deep-chat`'s two bundles
  did at the standard depth.
- **Release Watch reads a side's Evidence as one JSON text**, which V8 caps
  at 512 MiB. Evidence is 1.7–2.2 KiB per retained node, so about 240 000
  nodes fit at the densest measured; the deep global limit stays below
  that, and a side past it fails with `output_too_large` instead of being
  read in part, with REA's complete Evidence still saved under `evidence/`.
- **A larger heap rescued no file that exhausted it.** `llm-cli`'s 1.5 MB
  bundle ran out at 1024, 2048 and 4096 MiB and `rapidoc`'s at 1024 and
  2048 MiB; at 8192 MiB both ran past REA's 300 s per-file deadline, which
  fails the whole side. Files of up to 191 000 nodes fit in 1024 MiB, so
  both depths keep REA's default heap. `opencommit`'s 5 MB single-file
  bundle overflows REA's parser stack at any heap.

Measured on a 4-core Linux container (16 GB, Node.js 22) that other jobs
shared at a load average of 0.5–24, with CPU as user + system time of every
process and peak process-tree memory sampled every 100 ms. Runs of one pair
differ: CPU by 6 % to almost half (`aicommits` at `standard` took 4.5–4.8
min, `@nuxt/devtools` 8.0 min at a load of 5–10 and 11.8 min, in less wall
time, at a load of 2), and peaks with both sides at once by up to 0.5 GiB
(`aicommits` at `standard` peaked at 2.4, 2.7 and 2.9 GiB), so a difference
within that does not tell two depths apart. Wall times are upper bounds. A
range covers the runs made: a first run and two repeats for the first four
pairs, two more of `firecrawl-mcp`, and two to four separate runs, some made
after this change, for `aicommits`, `@notionhq/notion-mcp-server`,
desktop-commander, `@nuxt/devtools` and `swagger-ui-dist`. Release Watch
reuses nothing between runs, so a repeat differs only by the operating
system's file cache and the machine's load. Other rows are single runs. The
standard runs of stagehand and `flowise-ui`, and one each of
desktop-commander, `@nuxt/devtools` and `swagger-ui-dist`, ran the release
before this change with the standard limits given as options, which passes
REA the same limits. "Not examined" is what RW-C01 reports for the new
release; its file counts leave out TypeScript declaration files, which run
nothing and are not listed as unexamined, and were taken without them from
the saved reports of these runs rather than re-measured. The verdict lists
the rules that found something high or critical. The table leaves out six pairs whose coverage and findings did not
change with the limits (the Acme Notes Electron app, `ai-renamer`,
`@codacy/codacy-mcp`, `mcp-server-kubernetes`, `opencommit` and `rapidoc`)
and `aicommit2`, whose 31 600-node bundle the standard depth examined in
full, like `aicommits`'.

| Release pair                                                   | Limits                 | Wall         | CPU          | Peak (GiB) | Not examined in the new release                                                                | Verdict                             |
| -------------------------------------------------------------- | ---------------------- | ------------ | ------------ | ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| Acme Notes Cloud (2 components, HAR)                           | REA defaults, standard | 11–29 s      | 23–25 s      | 1.1–1.3    | —                                                                                              | block, the same findings            |
| Acme Notes Electron distribution                               | REA defaults, standard | 17–46 s      | 29–34 s      | 1.4–1.5    | —                                                                                              | block, the same findings            |
| `@modelcontextprotocol/server-everything` 2026.1.26 → 2026.7.4 | REA defaults, standard | 20–40 s      | 27–32 s      | 0.8–0.9    | —                                                                                              | review, the same findings           |
| `firecrawl-mcp` 3.30.1 → 3.30.2                                | REA defaults           | 42–58 s      | 72–80 s      | 1.3–1.4    | 1 file at the file limit                                                                       | block (RW-C01 high)                 |
|                                                                | standard               | 40–85 s      | 75–97 s      | 1.2–1.4    | —                                                                                              | pass                                |
| `aicommits` 4.1.0 → 4.1.1                                      | REA defaults           | 39 s         | 81 s         | 1.3        | 1 file at the file limit                                                                       | block (RW-C01 high)                 |
|                                                                | standard               | 2.1–4.4 min  | 4.5–4.8 min  | 2.4–2.9    | unclassified `child_process` uses                                                              | block (RW-P01 high, RW-C01 high)    |
|                                                                | standard, `--jobs 1`   | 3.8 min      | 4.7 min      | 1.5        | unclassified `child_process` uses                                                              | block (RW-P01 high, RW-C01 high)    |
| `@notionhq/notion-mcp-server` 2.4.1 → 2.5.0                    | REA defaults           | 66 s         | 2.2 min      | 1.5        | 1 file at the file limit                                                                       | block (RW-C01 high)                 |
|                                                                | standard               | 2.4–2.9 min  | 4.6–5.3 min  | 2.6–2.8    | 1 file at the file limit                                                                       | block (RW-C01 high)                 |
|                                                                | deep                   | 5.5–8.6 min  | 6.1–6.9 min  | 1.9–2.5    | —                                                                                              | pass                                |
| `@vitest/ui` 5.0.4 → 5.0.5                                     | REA defaults           | 49 s         | 103 s        | 1.5        | 1 file at the file limit, inline scripts                                                       | review                              |
|                                                                | standard               | 2.9 min      | 4.3 min      | 2.5        | 1 file at the file limit, inline scripts                                                       | review                              |
|                                                                | deep                   | 6.9 min      | 7.8 min      | 2.4        | inline scripts                                                                                 | review                              |
| `deep-chat` 2.4.1 → 2.4.2                                      | REA defaults           | 2.5 min      | 2.8 min      | 1.8        | 2 files at the file limit                                                                      | block (RW-C01 high)                 |
|                                                                | standard               | 3.9 min      | 5.2 min      | 3.1        | global limit                                                                                   | block (RW-C01 high)                 |
|                                                                | deep                   | 7.2 min      | 6.6 min      | 2.2        | —                                                                                              | review                              |
| `task-master-ai` 0.43.0 → 0.43.1                               | REA defaults           | 5.0 min      | 3.8 min      | 2.0        | 2 files at the file limit, unclassified `child_process` uses                                   | block (RW-C01 high)                 |
|                                                                | standard               | 2.9 min      | 4.4 min      | 3.6        | unclassified `child_process` uses                                                              | block (RW-C01 high)                 |
| `@browserbasehq/stagehand` 4.1.0 → 4.2.0                       | REA defaults           | 4.1 min      | 3.3 min      | 1.7        | 2 files at the file limit, unclassified `child_process` uses                                   | block (RW-C01 high)                 |
|                                                                | standard               | 4.3 min      | 5.3 min      | 3.1        | 1 file at the file limit, global limit                                                         | block (RW-C01 high)                 |
|                                                                | deep                   | 7.4 min      | 7.1 min      | 2.9        | global limit                                                                                   | block (RW-C01 high)                 |
| `@wonderwhy-er/desktop-commander` 0.2.52 → 0.3.0               | REA defaults           | 7.0 min      | 6.0 min      | 2.3        | 2 files at the file limit, 54 files unreached, global limit, unclassified `child_process` uses | block (RW-P01 high ×2, RW-C01 high) |
|                                                                | standard               | 3.7–5.3 min  | 6.8–8.4 min  | 3.7        | 73 files unreached, global limit, unclassified `child_process` uses                            | block (RW-P01 high ×2, RW-C01 high) |
|                                                                | deep                   | 9.8 min      | 8.6 min      | 3.2        | 73 files unreached, global limit, unclassified `child_process` uses                            | block (RW-P01 high ×2, RW-C01 high) |
| `@nuxt/devtools` 3.4.2 → 3.4.3                                 | REA defaults           | 7.7 min      | 7.3 min      | 2.6        | 2 files at the file limit, 90 files unreached, global limit, inline scripts                    | block (RW-C01 high, RW-C06 high)    |
|                                                                | standard               | 4.7–5.5 min  | 8.0–11.8 min | 3.7        | 62 files unreached, global limit, inline scripts                                               | block (RW-C01 high, RW-C06 high)    |
|                                                                | standard, `--jobs 1`   | 9.4 min      | 11.3 min     | 2.1        | 62 files unreached, global limit, inline scripts                                               | block (RW-C01 high, RW-C06 high)    |
|                                                                | 200 000 nodes, 2 sides | 8.1 min      | 10.9 min     | 4.8        | 25 files unreached, global limit, inline scripts                                               | block, the same findings            |
|                                                                | deep                   | 10.0 min     | 11.8 min     | 3.5        | 22 files unreached, global limit, 2 files failed, inline scripts                               | block (RW-C01 high, RW-C06 high)    |
| `swagger-ui-dist` 5.32.15 → 5.33.1                             | REA defaults           | 8.7 min      | 9.4 min      | 3.6        | 4 files at the file limit, global limit                                                        | block (RW-C01 high)                 |
|                                                                | standard               | 4.1–8.2 min  | 8.2–11.3 min | 3.2–3.8    | 1 file at the file limit, 3 files unreached, global limit                                      | block (RW-C01 high)                 |
|                                                                | standard, `--jobs 1`   | 12.4 min     | 9.9 min      | 2.1        | 1 file at the file limit, 3 files unreached, global limit                                      | block (RW-C01 high)                 |
|                                                                | deep                   | 7.9–10.9 min | 9.0–13.3 min | 3.4–3.5    | 1 file at the file limit, 4 files failed                                                       | block (RW-C01 high)                 |
| `flowise-ui` 3.1.3 → 3.1.4                                     | REA defaults           | 9.6 min      | 10.5 min     | 3.7        | 2 files at the file limit, 236 files unreached, global limit, 1 file failed, inline scripts    | block (RW-C01 high)                 |
|                                                                | standard               | 10.7 min     | 11.5 min     | 3.8        | 323 files unreached, global limit, 1 file failed, inline scripts                               | block (RW-C01 high)                 |
|                                                                | deep                   | 18.6 min     | 16.8 min     | 3.0        | 323 files unreached, global limit, 1 file failed, inline scripts                               | block (RW-C01 high)                 |
| `llm-cli` 0.0.11 → 0.0.12                                      | REA defaults           | 61 s         | 2.0 min      | 2.8        | 1 file failed                                                                                  | block (RW-C01 high)                 |
|                                                                | standard               | 115 s        | 119 s        | 2.8        | 1 file failed                                                                                  | block (RW-C01 high)                 |
|                                                                | deep                   | 107 s        | 2.5 min      | 1.4        | 1 file failed                                                                                  | block (RW-C01 high)                 |

Higher limits cost CPU that grows with the nodes they add, and they
change findings: `firecrawl-mcp` 3.30.2 passes at the standard depth (its
20 300-node bundle was cut at REA's 20 000), and `aicommits`' 116 000-node
bundle, examined in full on both sides, exposes an `npm install -g`
`exec()` that RW-P01 reports as new because the bundle's content-hashed
name changed (the finding notes the same call in the old bundle).
desktop-commander's verdict does not change: at either depth RW-P01
reports the `exec()` and the `execFile()` in the new
`diagnostics/report.js` high, saying they may have been there before since
old files had no semantic facts (64 at the standard depth). Saved Evidence is 1.7–2.2 KiB per retained node and side (620 MB
for a standard `swagger-ui-dist` review, 900 MB at the deep depth), and
neither side's Evidence is reused between runs yet. No model is called, so
no tokens are used.

## Tests

```bash
npm test    # from products/release-watch
```

The CLI tests run the real REA build against the fixtures and are skipped when
REA has not been built.
