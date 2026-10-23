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
2. **Solve.** One agent per batch of packages works depth-first: it runs
   `proof-swarm scan`, reads the code the scan points to, writes a claim,
   runs `proof-swarm check`, and fixes what the check rejects until it
   passes.
3. **Check.** `proof-swarm check` accepts a claim only when every cited
   line is in a running file of the package and holds the quoted text; a
   "yes" path starts at a tool registration, links each call to a
   definition of the name it calls, and ends at a process call; a "no" cites
   every candidate process call and every process-capable file the scan
   finds, each with a reason, and says why code loaded at runtime cannot
   reach one either.
4. **Review.** An independent agent reads the code behind every checked
   "yes" or "no" and tries to refute it: is the registration a real tool,
   does each call reach the very function the path names, is the process
   call reachable and live, did a "no" miss a path?
5. **Accept.** A claim the check passes and the reviewer upholds is a
   reviewed answer. Its evidence is the cited path or account, its basis is
   "reviewed", and REA's own marks never change.

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
- A `no` needs `process_sites`: `{ file, line, text, reachable_from_tool:
  false, why }` for every candidate line the scan lists and a line in every
  process-capable file. It also needs a `residual` when the package loads
  or evaluates code at runtime.
- An `undetermined` needs a `residual` that says what blocks a decision.
- `hint_sequence` lists the insights that settled the question, in order;
  `work` records files read and searches. Together they estimate the k and
  t above, roughly: agents report them themselves.

## Commands

```bash
node bin/proof-swarm.mjs scan <package-dir>
node bin/proof-swarm.mjs check <claim.json> --package <package-dir>
```

`scan` lists what a claim must account for. `check` prints `{ status,
errors, warnings, scan }` and exits 0 when the claim passes, 1 when it
fails. Neither runs, imports or installs anything from the package, and
neither calls a model.

The scan reads the package's shipped text with regular expressions,
deliberately broadly: files that load child_process or a process library
from Release Watch's catalog, lines that may call a process function
(anywhere, since a file can call a function it was handed), process
functions handed on as values, and lines that load or evaluate code at
runtime. Files named as tests and declaration files do not count
(Landscape's catalog). It over-reports rather than misses; a "no" explains
each line it lists.

## Running the swarm

`workflows/tool-reach.workflow.js` is the protocol as a Claude Code workflow
script for the Workflow tool. It takes `{ cli, claims, batches }`: the path
of `bin/proof-swarm.mjs`, a directory for claim files, and batches of
`{ name, version, dir, slug, reasons }`. Its prompts are the protocol, so
any agent runner can follow them with the same two commands.

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

## Tests

```bash
cd products/proof-swarm && npm test
```

The tests run the CLI on packages written for each case: a true path, a
shifted line, a missing definition, invented code, a cited test file, a
path outside the package, a false "no", a process function handed to a
file that never loads child_process, an honest "no" with code loaded at
runtime, and an undetermined answer without a reason.
