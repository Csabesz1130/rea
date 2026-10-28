# Proof Swarm

Proof Swarm settles questions that static analysis leaves unknown. Agents
take each question to a finished claim, a deterministic check accepts a
claim only when every line it cites is in the shipped code, and an
independent agent then tries to refute it. A claim that passes both is a
reviewed answer, kept apart from REA's observations.

It is a prototype beside [Landscape](../landscape/README.md) and
[Release Watch](../release-watch/README.md). Its first question comes from
Landscape's MCP Trust Index: for 24 of the 40 most-downloaded MCP servers on
npm, REA's facts could not tell whether an MCP tool can start a process.

## Why a swarm and a checker

A hard question needs a sequence of insights with work between them. Its
difficulty grows roughly like 2^k + t: exponentially with k, the number of
insights an expert would need to be told, and linearly with t, the work
between them (W. T. Gowers, on the unit-distance disproof). People explore
many directions shallowly and drop most of them early, because following
one is slow. Agents can follow many to the end, and let a checker decide
which answers hold.

So the leverage is the checker, not the model. Here it is narrow on
purpose: it checks text, never meaning, and an adversarial reviewer handles
meaning. "Undetermined" is an accepted answer; a guess is not.

## How it works

1. **Question.** One per package: can code that runs when an MCP client
   calls one of the server's tools start an operating-system process, and
   through a shell?
2. **Plan.** `proof-swarm plan` sketches every package coarse to fine
   (below). A package whose coarsest level already settles the question
   needs no agent; every other package goes to the agents with its sketch.
3. **Solve.** One agent per batch of packages works depth-first: it starts
   from the sketch, runs `proof-swarm scan` for the exact lines a claim must
   cite, reads the code they point to, writes a claim, runs
   `proof-swarm check`, and fixes what the check rejects until it passes.
4. **Check.** `proof-swarm check` accepts a claim only when every cited
   line is in a running file of the package and holds the quoted text; a
   "yes" path starts at a tool registration, links each call to a
   definition of the name it calls, and ends at a process call; a "no" cites
   every candidate process call and every process-capable file the scan
   finds, each with a reason, and says why code loaded at runtime cannot
   reach one either.
5. **Review.** An independent agent reads the code behind every checked
   "yes" or "no" and tries to refute it: is the registration a real tool,
   does each call reach the very function the path names, is the process
   call reachable and live, did a "no" miss a path?
6. **Accept.** `proof-swarm collect` checks every claim file again, so a
   solver's report of its own check counts for nothing, and sketches every
   package the plan settled again. A claim the check passes and a
   consistent review upholds is a reviewed answer. A review names each
   failure it finds; one that refutes without naming a failure, or upholds
   while naming one, settles nothing. An answer's evidence is the cited path
   or account, its basis is "reviewed" (or "settled by the scan"), and
   REA's own marks never change.

## Coarse to fine

Next-concept modeling (Kumbong et al., "Next-Concept Modeling: Fast,
Parallel Coarse-to-Fine Text Generation", arXiv:2610.14162) generates text
as a hierarchy: a multiscale residual quantizer turns a sequence into
levels of growing length (1, 2, 4 … 89 positions for a Sudoku board), each
coding only what the coarser levels leave unexplained, and a transformer
predicts every position of a level at once, conditioned on the sketch so
far. Generation takes one step per level instead of one per token, which
is where its 9 to 31 times speedups over diffusion language models come
from (the mechanism as its released code shows it; the numbers are the
authors').

Proof Swarm runs no model, so the architecture does not transfer; its
shape does. `proof-swarm sketch` describes a package in four levels, each
listing only what the coarser ones leave open:

| Level | Positions                                                                               | Settles                                                      |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 0     | the package: counts and a verdict                                                       | "no" when nothing that can run starts a process              |
| 1     | its entry points: bin, main, module, every exports target                               | where code starts                                            |
| 2     | files that load a process module or library, call a process function or register a tool | which of them the entry points reach through literal imports |
| 3     | lines: every escape, and candidate calls and tool registrations in reached files        | what an agent must still read                                |

A file the entry points do not reach can run only through an escape: an
import the sketch cannot resolve, a native addon, a script the scan leaves
out, code loaded or evaluated at runtime, or a worker started from a path.
Level 0 says "no" when the scan finds nothing to account for, or when
every process-capable file and candidate call is unreached and nothing
escapes. Agents receive levels 0 to 2 in their prompt and read level 3 on
demand, so they explain the few escapes instead of re-tracing imports by
hand, as n8n-mcp's round-2 solver and reviewer each did across about 180
files.

On the 26 packages of the first run, level 0 settles one,
@upstash/context7-mcp, and agrees with its reviewed "no"; it leaves all 15
reviewed "yes" packages open. `plan` sketched all 26 in 7.2 to 8.3 s and
7.9 to 9.1 s of CPU over two runs, with a peak of 458 MB, most of it the
cache of every package's text.

Round 3 ran round 2's three packages again through `plan`: level 0
settled @upstash/context7-mcp in 55 ms with no agent, and n8n-mcp and
@tanstack/ai-mcp went to agents with their sketches and reached the same
reviewed "no" as in round 2. Against round 2, the whole task took 164 tool
uses instead of 212, about 0.7 million tokens of final context instead of
1.0 million, and 14 minutes instead of 17. All of that came from context7
needing no agent. By the agents' transcripts, the two packages still sent
to agents cost more with the sketch than without: 164 tool uses against
145, and 690,000 tokens of final context against 647,000. Their agents
still checked the import structure themselves, and n8n-mcp's solver found
the sixth flaw below. One run per package shows a direction, not an effect
size: the coarse level paid where it settled a package outright, and the
sketch in the prompt did not shorten the agents' reading.

### REA at level 0

The scan reads text, so a process call or an `eval` written in a string, a
regex, a comment or a method definition keeps a package open as surely as
a real one. With `--rea`, `sketch` and `plan` ask REA's parse which matches
are code. REA reports every call, load and evaluation where it starts, so
a match where REA's parse finds none is not one: level 0 discharges it.

REA runs only when its facts could settle the package: no process-capable
file is reached, every open line is a form REA reports at the very
position the scan matched (a bare `eval`, `require`, `import()` or
`Function`, or a process function called by its bare name), and every file
that holds one is at most 640 KB. Of real package files analyzed alone at
standard depth, REA examined every one up to 602 KB in full; for every one
from 719 KB to 2.6 MB its semantic graph exceeded REA's result budget
after 17 to 48 s, and REA recorded a failure. REA then analyzes copies of
those files alone, and a match is discharged only when REA examined its
file in full by Release Watch's coverage (no node limit, no failure) and
reports nothing starting there. Positions are compared as offsets into the
same text, because REA counts U+2028, U+2029 and a lone carriage return as
line breaks and the scan does not. Level 0 records its basis, `scan and
REA`, and `rea`: the Evidence id, the files and every discharged line,
REA's error, or why REA was not run. `collect` sketches a package settled
this way again with REA.

On the 26 packages, level 0 with REA settles two: context7, and n8n-mcp,
whose six open lines were strings, a regex and method definitions in
three files. Both agree with their reviewed "no", and none of the 15
reviewed "yes" packages is settled. The other reviewed "no" packages stay
open for real reasons: @tanstack/ai-mcp reaches a process-capable file,
and creem, @launchdarkly/mcp-server, @modelcontextprotocol/server-pdf and
@notionhq/notion-mcp-server build code at runtime (depd's and ajv's
`new Function`, function-bind's `Function`, express's `require(mod)`) in
bundles of 1.0 to 2.6 MB, too large for REA to examine. `plan --rea`
took 13.8 to 14.1 s, 18.4 to 18.7 s of CPU and a peak of 874 MB across its
processes over two runs, against the 7.2 to 8.3 s above without REA.
Before the size bound, REA spent 184 s analyzing those four bundles to no
effect.

Before relying on it, REA's positions were checked on packages written
for each case. REA reported every real bare call, load and evaluation, 62
in all, exactly where the scan matched it: in closures, class fields and
static blocks, default parameters, getters, computed keys, templates,
`new` expressions and optional calls, after non-ASCII text, a byte-order
mark, a shebang, CRLF line ends and the line breaks above, and in a file
whose parse REA recovered from a syntax error (Babel's recovery parses on
through the same tokens). For invalid UTF-8 or a parse that fails, REA
records a failure and nothing is discharged. Comparing line and column
instead of offsets fails the tests.

## Claims

A claim is a JSON file:

```json
{
  "server": "@netlify/mcp",
  "version": "1.19.0",
  "verdict": "yes",
  "shell": "yes",
  "paths": [
    {
      "tool": "netlify-*-services-*",
      "hops": [
        {
          "file": "dist/netlify-mcp.js",
          "line": 2188,
          "text": "server.registerTool(toolName, {",
          "role": "registration"
        },
        {
          "file": "dist/netlify-mcp.js",
          "line": 2197,
          "text": "await getNetlifyAccessToken(remoteMCPRequest);",
          "role": "call",
          "calls": "getNetlifyAccessToken"
        },
        {
          "file": "dist/netlify-mcp.js",
          "line": 407,
          "text": "var getNetlifyAccessToken = async (request2) => {",
          "role": "definition",
          "defines": "getNetlifyAccessToken"
        },
        {
          "file": "dist/netlify-mcp.js",
          "line": 443,
          "text": "await runCommand(\"netlify login\"",
          "role": "call",
          "calls": "runCommand"
        },
        {
          "file": "dist/netlify-mcp.js",
          "line": 20,
          "text": "var runCommand = async (command, options = {}) => {",
          "role": "definition",
          "defines": "runCommand"
        },
        {
          "file": "dist/netlify-mcp.js",
          "line": 22,
          "text": "const childProcess = exec(",
          "role": "process"
        }
      ]
    }
  ],
  "hint_sequence": [
    "Every service tool first fetches a token",
    "With no token in the environment, the token helper runs netlify login",
    "runCommand wraps child_process exec"
  ],
  "residual": null
}
```

- `verdict` and `shell` are `yes`, `no` or `undetermined`.
- A `yes` needs `paths`. Each hop cites a file inside the package, a
  1-based line and 6 to 400 characters copied from that line.
- A `no` needs `process_sites`: `{ file, line, text, why }` for every
  candidate line the scan lists and a line in every process-capable file,
  where `why` says why no tool can start a process there: no tool reaches
  it, or it is not a process call. It also needs a `residual` when the
  package loads or evaluates code at runtime.
- An `undetermined` needs a `residual` that says what blocks a decision.
- `hint_sequence` lists the insights that settled the question, in order;
  `work` records files read and searches. Together they estimate the k and
  t above, roughly: agents report them themselves.

## Commands

```bash
node bin/proof-swarm.mjs scan <package-dir>
node bin/proof-swarm.mjs sketch <package-dir> [--level <0-3>] [--rea]
node bin/proof-swarm.mjs check <claim.json> --package <package-dir>
node bin/proof-swarm.mjs plan <workflow-args.json> [--rea]
node bin/proof-swarm.mjs collect <workflow-args.json> <workflow-result.json>
```

`scan` lists what a claim must account for. `sketch` prints `{ levels }`
up to `--level` (default 3); `--rea` adds REA's facts to level 0 and needs
this checkout's REA build (`npm run build:cached`) or `REA_CLI`. `check` prints `{ status, errors, warnings,
scan }` and exits 0 when the claim passes, 1 when it fails. `plan` prints
the workflow's args again, with packages level 0 settles under `settled`
and every other package carrying its sketch's levels 0 to 2; `--rea`
sketches with REA's facts. `collect`
prints `{ outcomes, records }` for a swarm run: each
package's claim, its check, its reviews, the solver's own report and the
outcome (`reviewed yes`, `reviewed no`, `settled by the scan`,
`undetermined`, `refuted`, `review inconsistent`, `not reviewed`,
`failed the check` or `no claim`).
No command runs, imports or installs anything from a package, and none
calls a model.

The scan reads the package's shipped text with regular expressions,
deliberately broadly: files that load child_process or a library that
starts processes (Release Watch's catalog: execa, node-pty, the MCP SDK's
stdio client transport and others), lines that may call a process function
(anywhere, since a file can call a function it was handed), process
functions handed on as values, and lines that load or evaluate code at
runtime. A module loads through `require` and what bundlers rename it to
(`__require`, `require2`), `Module._load`, `getBuiltinModule` and every
name a file binds to a `createRequire` result; a `createRequire` result
that no name keeps whole is code loaded at runtime. Optional calls
(`require?.(…)`) count like calls. Files named as tests and declaration files do not count
(Landscape's catalog). It over-reports rather than misses; a "no" explains
each line it lists.

## Running the swarm

`workflows/tool-reach.workflow.js` is the protocol as a Claude Code workflow
script for the Workflow tool. It takes `{ cli, claims, batches }`: the path
of `bin/proof-swarm.mjs`, a directory for claim files, and batches of
`{ name, version, dir, slug, reasons }`, with `calibration` (`yes` or `no`)
for a package whose answer is known; only `collect` reads it. Run `plan` on
those args first, with `--rea` where REA is built, and give the workflow
what it prints; save the run's
return value as JSON and pass it to `collect` with the planned args. The
prompts are the protocol, so any agent runner can follow them with the same
commands.

## First run

The question went to the 24 servers of Landscape's MCP Trust Index whose
tool-reach cell REA's facts leave unknown, and to two calibration servers
whose answer they settle (@drawio/mcp: yes; @upstash/context7-mcp: no),
without telling the agents which were which. Round 2 ran the committed
workflow once more, on the three servers the first run's fixes affected,
and round 3 ran those three again coarse to fine (below).

|                         | First run                | Round 2                | Round 3                         |
| ----------------------- | ------------------------ | ---------------------- | ------------------------------- |
| Packages                | 26, in 9 batches         | 3, one per batch       | 3: 1 settled by plan, 2 batches |
| Solvers and reviewers   | 9 and 9                  | 3 and 3                | 2 and 2                         |
| Wall time, 2 at a time  | 101 min                  | 17 min                 | 14 min                          |
| Agent tokens, tool uses | about 3.7 million, 1,177 | about 1.0 million, 212 | about 0.7 million, 164          |

Agent tokens are what the workflow reports: the sum of each agent's final
context. Counting every model call's input, cache reads included, round 2
processed 20.8 million tokens and round 3 17.4 million.

Of the 24 unknown cells, 21 are settled:

- **A tool reaches a process, 15.** Through a shell: next-devtools-mcp,
  @next-ai-drawio/mcp-server (on Windows only), @cap-js/mcp-server,
  hostinger-api-mcp and @hostinger/mcp. Shell undetermined: rea-agents,
  @hasna/todos, @swmansion/argent, mcporter and @zereight/mcp-gitlab.
  Without a shell: @ui5/mcp-server, kordoc, @google-cloud/gcloud-mcp,
  xcodebuildmcp and @softeria/ms-365-mcp-server.
- **No tool reaches one, 6.** @notionhq/notion-mcp-server, creem,
  @launchdarkly/mcp-server and @modelcontextprotocol/server-pdf from the
  first run; @tanstack/ai-mcp and n8n-mcp from round 2. Both of those load
  the MCP SDK's stdio client transport in a file no tool reaches.
- **Undetermined, 3.** supergateway registers no tools of its own: it
  relays tool calls to a server it spawns, in stateless HTTP mode once per
  request with `shell: true`, so no path can start at a registration.
  @google-cloud/observability-mcp and @google-cloud/storage-mcp call Google
  client libraries they do not ship; in the copies the solvers could read,
  google-auth-library runs `gcloud config config-helper` through a shell
  when no project ID is set.

Each answer holds under the conditions its review records. Several "yes"
paths fire only on a fallback or on one operating system, and a shell "no"
can hold on Linux and macOS only: on Windows, cross-spawn and execa run a
`.cmd` file through cmd.exe, as @ui5/mcp-server's reviewer recorded for its
npm call.

Calibration: in the first run @drawio/mcp came out right, and
@upstash/context7-mcp's right "no" passed the check but was turned down by
a reviewer that marked it refuted while writing that no step failed. In
round 2 it came out right.

The agents found six flaws in the harness itself. Each is fixed, all but
the fifth with a test that fails without the fix:

1. The check counted `shell: false` as a shell (rea-agents' reviewer,
   first run).
2. The scan missed the MCP SDK's stdio client transport, which spawns the
   server it connects to (n8n-mcp's reviewer, first run; @tanstack/ai-mcp's
   solver had explained it only in prose). It is now in Release Watch's
   catalog, which Release Watch, Landscape and the scan share, so Landscape
   also marks those two servers as likely starting processes.
3. A review could refute a claim while naming no failure (context7's
   reviewer, first run). Reviewers now list each failure, and `collect`
   discards a verdict its failures contradict.
4. The scan missed process calls as TypeScript and bundlers emit them,
   `(0, child_process_1.spawnSync)(…)` and `import_child_process.exec(…)`
   (n8n-mcp's solver, round 2, which cited those lines by hand). The wider
   scan lists 37 more candidate lines in the 26 packages: 35 in
   @swmansion/argent, whose answer is a "yes", and the two n8n-mcp's claim
   cites.
5. A "no" had to mark every candidate line `reachable_from_tool: false`,
   even a line a tool reaches that starts no process (n8n-mcp's reviewer,
   round 2). The field is gone: `why` says which it is. First-run claims
   still carry it, and the check ignores it.
6. The scan read a require of a template literal with `${…}` as a literal
   specifier, so a path computed at runtime counted as neither runtime
   code nor an escape (n8n-mcp's solver, round 3, at
   `dist/loaders/node-loader.js:40`). It is now code loaded at runtime.

After the first three fixes, every first-run claim was checked again. Two
outcomes changed, both of servers round 2 re-ran: @tanstack/ai-mcp's "no"
and n8n-mcp's refuted "no" left out a file the scan now lists. After the
last three, and after the sketch's own additions to the scan
(`getBuiltinModule`, Node's spawn bindings and `createRequire` called at
once), every claim of every round was checked again and none changed.

Feeding REA's facts into level 0 turned up two more gaps, found while
building it rather than by agents, and fixed with tests: REA's line
numbers differ from the scan's after U+2028, U+2029 or a lone carriage
return, which would have discharged a real `eval`; and the scan missed
modules loaded through bundlers' `require` names and `createRequire`
bindings (two packages, both reviewed "yes", gain a process-capable file),
optional calls and `Function(…)` without `new`. The wider scan drops nothing it found before. Every claim of every
round was checked again and none changed. The first run was collected before `collect` existed, with the same rule but
without the review-consistency test; rounds 2 and 3 come from `collect`.
By the solvers' own count, the check turned back 13 drafts in the first
run, none in round 2 and 3 in round 3.

## Data boundary

The agents read the packages through a hosted model, so everything they
read is sent to the model's provider. Use Proof Swarm on public packages, or
on code you may share with that provider. The scan and the check run
locally, and nothing in `src/` calls a model.

## What it does not establish

- The check confirms that cited text exists and that names link up. It
  does not prove that a path is taken; the reviewer reads for that, and a
  reviewer is also an agent that can be wrong.
- A reviewed answer is a different kind of evidence from REA's facts, and
  reports keep them apart. A reviewed "yes" shows one way a tool reaches a
  process, under the conditions the reviewer records.
- A reviewed "no" holds for the shipped files the scan read. A library the
  package loads but does not ship is outside what anyone examined.
- Hint sequences are the solvers' own account of what settled a question,
  so they measure difficulty roughly.
- A "no" settled by the scan holds for what the scan's patterns and the
  sketch's literal imports can see. Code that builds a module name or a
  call from pieces at runtime is listed as an escape when the scan sees a
  dynamic load, and missed when it does not; deliberately disguised code
  is out of reach of a text scan.
- The scan misses ordinary forms it does not model: a loader handed from
  one file to another, a process function called through `.call`,
  `.apply`, `Reflect` or a computed member, a call split across lines, a
  tagged template, and a `createRequire` call more than 32 lines long or
  with an unbalanced parenthesis in a regex inside it. It reads `.js`,
  `.mjs` and `.cjs` files and node scripts; Node does not strip types or
  run JSX under node_modules, so `.ts` and `.jsx` files do not count.
- REA's facts discharge a match only where REA examined its file in full
  and its parse finds nothing starting there; they say nothing about the
  matches they keep, which agents still explain.
- The sketch's closure follows literal imports between the package's own
  files. It does not decide which functions in a reached file run, so a
  large bundle is reached whole and stays open.

## Tests

```bash
cd products/proof-swarm && npm test
```

The tests run the CLI on packages written for each case: a true path, a
shifted line, a missing definition, invented code, a cited test file, a
path outside the package, a shell "yes" on `shell: false`, a false "no", a
process function handed to a file that never loads child_process, an
honest "no" with code loaded at runtime, an undetermined answer without a
reason, a file that loads the MCP SDK's stdio client transport, process
calls as compilers and bundlers emit them, child_process reached without
an import, and a collection in which only a passing claim with a
consistent, upholding review is an answer. The sketch's tests cover a
package level 0 settles because nothing can start a process, one it
settles because no entry point loads the process code, the same package
kept open by code loaded at runtime, every kind of escape, a package with
no entry point read whole, the loaders bundlers and `createRequire` leave,
and a plan whose settled package collect reports as settled by the scan.
With REA built, they also check that REA's facts discharge a comment, a
string, a regex and a method definition; keep a real `eval` after a
U+2028 and one after a syntax error REA's parser recovers from; leave
forms REA does not report where they match to the scan; and settle a plan
that collect reports on the same basis.
