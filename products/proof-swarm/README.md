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
reviewed "yes" packages open. Sketching all 26 took 13.8 s and 14.5 s of
CPU in one process, with a peak of 412 MB, most of it the cache of every
package's text.

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
node bin/proof-swarm.mjs sketch <package-dir> [--level <0-3>]
node bin/proof-swarm.mjs check <claim.json> --package <package-dir>
node bin/proof-swarm.mjs plan <workflow-args.json>
node bin/proof-swarm.mjs collect <workflow-args.json> <workflow-result.json>
```

`scan` lists what a claim must account for. `sketch` prints `{ levels }`
up to `--level` (default 3). `check` prints `{ status, errors, warnings,
scan }` and exits 0 when the claim passes, 1 when it fails. `plan` prints
the workflow's args again, with packages level 0 settles under `settled`
and every other package carrying its sketch's levels 0 to 2. `collect`
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
runtime. Files named as tests and declaration files do not count
(Landscape's catalog). It over-reports rather than misses; a "no" explains
each line it lists.

## Running the swarm

`workflows/tool-reach.workflow.js` is the protocol as a Claude Code workflow
script for the Workflow tool. It takes `{ cli, claims, batches }`: the path
of `bin/proof-swarm.mjs`, a directory for claim files, and batches of
`{ name, version, dir, slug, reasons }`, with `calibration` (`yes` or `no`)
for a package whose answer is known; only `collect` reads it. Run `plan` on
those args first and give the workflow what it prints; save the run's
return value as JSON and pass it to `collect` with the planned args. The
prompts are the protocol, so any agent runner can follow them with the same
commands.

## First run

The question went to the 24 servers of Landscape's MCP Trust Index whose
tool-reach cell REA's facts leave unknown, and to two calibration servers
whose answer they settle (@drawio/mcp: yes; @upstash/context7-mcp: no),
without telling the agents which were which. Round 2 ran the committed
workflow once more, on the three servers the first run's fixes affected.

|                         | First run                | Round 2                |
| ----------------------- | ------------------------ | ---------------------- |
| Packages                | 26, in 9 batches         | 3, one per batch       |
| Solvers and reviewers   | 9 and 9                  | 3 and 3                |
| Wall time, 2 at a time  | 101 min                  | 17 min                 |
| Agent tokens, tool uses | about 3.7 million, 1,177 | about 1.0 million, 212 |

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

The agents found five flaws in the harness itself. Each is fixed, the
first four with a test that fails without the fix:

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

After the first three fixes, every first-run claim was checked again. Two
outcomes changed, both of servers round 2 re-ran: @tanstack/ai-mcp's "no"
and n8n-mcp's refuted "no" left out a file the scan now lists. After the
last two, both rounds' claims were checked again and none changed. The
first run was collected before `collect` existed, with the same rule but
without the review-consistency test; round 2's results come from
`collect`. By the solvers' own count, the check turned back 13 drafts in
the first run and none in round 2.

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
kept open by code loaded at runtime, every kind of escape, and a plan whose
settled package collect reports as settled by the scan.
