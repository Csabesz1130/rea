# Landscape

Landscape answers the question a founder or product lead asks before
building: **what do the products in this category actually do, and where
can a new one be different?** It reads each product's shipped code with REA,
through the facts Release Watch projects from REA's Evidence, and maps about
twenty traits across them: the AI providers they call, whether they run on
local models, the MCP tools they serve and what those tools reach, the
processes and shells they start, the telemetry and other hosts their data
goes to, and their desktop and web safeguards.

From the map it reports what every product does (table stakes), what most
do, what only one does, the risks they share, and **openings**: something
few or none of them offer, or a risk most of them expose users to that a new
product can avoid and prove it avoids. It writes a clean-room brief a team
can build from without reading anyone's code.

It is a prototype product beside [Release Watch](../release-watch/README.md)
in this repository. Nothing in `src/` parses application source: REA owns
parsing, Release Watch owns what its facts mean, and Landscape owns grouping
them into traits and what the counts suggest.

## Learning from existing products without copying them

Reverse engineering is useful to a new product only for what it reveals about
behavior: what the incumbents do, what they all leave out, and what they all
get wrong. Copying how they do it gives you a weaker version of their
product. Landscape is built around that difference:

1. **Read what the products do, not how they are written.** Every trait is a
   fact about behavior (calls OpenAI, runs commands through a shell, sends
   analytics to a named service) with the REA Evidence and file location
   behind it.
2. **Map the category, not one rival.** Table stakes are what users of the
   category will expect; a capability only one product has is that product's
   edge; a risk most products share is a position nobody holds yet.
3. **Read the direction.** `landscape history` shows what each release of a
   product started or stopped doing, so you build where the category is going
   rather than where it was.
4. **Pick a difference you can prove.** An opening is either white space
   (local-first models in a category of hosted ones) or an inversion (no
   telemetry in a category that sends it). Both are claims your own releases
   can be checked against.
5. **Hand off clean.** `brief.md` carries what the products do and the
   openings, and no source code, commands, prompt text or file paths, so the
   people building the new product never need to read the old ones. The
   analyst keeps `report.html` and the Evidence.
6. **Keep the difference true.** Run Release Watch on every release of your
   own product, so the claim you sell on (no telemetry, no shell, local-first)
   cannot quietly regress, and map the category again when it moves.

## Quick start

You need what Release Watch needs: Node.js 22.19 or later on the 22 line,
24.11 or later, or 26 and later, with npm and git; Landscape is verified on
Linux x64. Every demo but `fixtures` downloads public packages with npm,
checks each tarball against the sha512 integrity pinned in
`demo/packages.json`, and unpacks it with `tar`; nothing downloaded is run.

```bash
npm ci && npm run build:cached                       # build REA (repository root)
bash products/landscape/demo/run-demo.sh fixtures    # offline, a few seconds
bash products/landscape/demo/run-demo.sh mcp         # five real terminal MCP servers
bash products/landscape/demo/run-demo.sh history     # six releases of ai-renamer
bash products/landscape/demo/run-demo.sh index       # the 40 most-downloaded MCP servers
bash products/landscape/demo/run-demo.sh gemini      # Gemini CLI core, launch to 0.64.0
cd products/landscape
node bin/landscape.mjs map A B C --ours MINE --category "AI note apps" --out map
node bin/landscape.mjs history V1 V2 V3 --category "Product X" --out trajectory
```

Each product is anything Release Watch reads: an Electron distribution, a
JavaScript app or npm package directory, a built web app, an `.asar` file, a
HAR capture, or a directory with a `release-watch.json` manifest naming
several components. `--ours` adds your own product beside the others without
counting it, and reports where it stands. `history` takes releases of one
product, oldest first. A map of more than eight products lists products as
rows and traits as columns.

### Large products

REA's node limits apply to one analysis, so a package of hundreds of source
files is examined only in part when it is read whole. `demo/split.mjs` lays
such a package out as one component per source directory, listed in a
`release-watch.json` manifest, and Landscape reads the components as one
product:

```bash
node demo/split.mjs path/to/package --root dist/src --out split
node bin/landscape.mjs history split-v1 split-v2 --category "Product X"
```

Each directory is then examined in full, but imports between directories are
not followed, so a trait that needs a path across them (an MCP tool that
reaches process execution through another directory's helper) may not show.

## Who it is for

| Use case                             | Command                 | What you get                                                               |
| ------------------------------------ | ----------------------- | -------------------------------------------------------------------------- |
| Position a new product in a category | `map A B C …`           | table stakes, edges, shared risks, openings, `brief.md`                    |
| Check your product against the field | `map A B C --ours MINE` | what you match, lack, alone offer, and which shared risks you avoid        |
| Follow a competitor's direction      | `history V1 V2 …`       | what each release started or stopped doing                                 |
| Compare vendors before buying        | `map VENDOR1 VENDOR2 …` | data flows, AI providers and risks side by side, with Evidence             |
| Technical due diligence              | `map TARGET PEERS…`     | what a product ships against its peers, where REA could and could not look |

## What it maps

| Group                    | Traits                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI models                | calls each AI provider; uses a hosted model; supports several providers; runs on a local model; reads provider keys from the environment; calls a provider from browser code (risk); ships a credential in its code (risk) |
| Agent tools              | is an MCP server; connects to MCP servers; an MCP tool reaches process execution (risk)                                                                                                                                    |
| Machine access           | starts processes; runs commands through a shell (risk); runs interactive terminal sessions; evaluates code built at runtime (risk)                                                                                         |
| Data leaving the machine | contacts remote hosts; sends analytics, telemetry or error reports (risk); checks a registry for updates; sends over plain HTTP (risk)                                                                                     |
| Desktop                  | is an Electron app; a window turns off an Electron safeguard (risk)                                                                                                                                                        |
| Web                      | ships web pages; registers a service worker; keeps data in browser storage; loads scripts from other hosts (risk)                                                                                                          |

Each cell is one of:

- **● Yes**: REA's facts show it, directly or tied together by Release Watch
  without a guess (a request that reads the variable holding a URL).
- **◐ Likely**: only a guess suggests it, such as a URL near requests, a
  library known to start processes, or a host whose name says telemetry.
- **– Not seen**: not observed where REA looked, which is not proof of
  absence.
- **? Unknown**: REA examined the product only in part, or a library REA
  does not model (an HTTP client such as axios, a process library such as
  execa or node-pty) may do it unseen. Unknown cells are never counted as
  absent, and the reason is in the Evidence section.

Only code that runs with the product counts. TypeScript declaration files
and files named as tests (`*.test.js`, `*.spec.js`, `*.test.circular.js`,
and files under `__tests__/`, `__mocks__/`, `__fixtures__/` or
`test-utils/`) ship in some packages, but Landscape reads no trait from
them; a test that names `https://test-server.example` is not a host the
product contacts. A plain `test/` or `mocks/` directory still counts,
because products keep running code there: xcodebuildmcp's `utils/test/`
holds the code its tools use to run a project's tests.

The building blocks (AI and MCP SDKs, and packages more than one product
imports) are listed separately.

## Openings

| Opening                  | Kind        | Suggested when                                                       |
| ------------------------ | ----------- | -------------------------------------------------------------------- |
| Local-first AI           | white space | at most half the products that use a hosted model run on a local one |
| Bring any model          | white space | most products that use a hosted model call one provider              |
| No telemetry             | inversion   | any product sends analytics, telemetry or error reports              |
| Commands without a shell | inversion   | any product runs commands through a shell                            |
| Narrow agent tools       | inversion   | any MCP server has a tool that reaches process execution             |
| Usable by agents         | white space | none of two or more products serves MCP tools                        |
| Keys stay off the client | inversion   | any product calls a provider from browser code or ships a credential |
| Encrypted everywhere     | inversion   | any product sends over plain HTTP                                    |
| Hardened desktop app     | inversion   | any Electron app turns off a window safeguard                        |
| Only your own scripts    | inversion   | any product loads scripts from other hosts                           |
| Works offline            | white space | two or more products ship pages and none registers a service worker  |
| Interactive sessions     | white space | two or more products start processes and none runs a pseudo-terminal |

Openings are Landscape's reading of the counts, labelled so in every report;
deciding which one is a business is yours.

## Reports

`--out` (default `./landscape-report`) receives:

- `report.html`: openings, what the products do together, your position or
  the trajectory, the map, building blocks, and every evidence line behind
  every mark. Self-contained; loads nothing from the network.
- `report.md`: the same for a terminal or a pull request.
- `report.json`: the model both render, with each product's coverage, REA
  Evidence IDs and files, and the REA calls made.
- `brief.md` (maps only): the clean-room brief.
- `evidence/`: REA's Evidence exactly as REA wrote it. It holds the products'
  own text, so treat it as sensitive.

Reports mask URL secrets and credential formats as Release Watch does; a
shipped credential is reported by its kind and place, never its value.

## On real products

**Terminal MCP servers** (`run-demo.sh mcp`): shell-mcp-server 1.0.3,
mcp-shell 0.1.3, super-shell-mcp 2.0.15, @mako10k/mcp-shell-server 2.8.1 and
@wonderwhy-er/desktop-commander 0.3.0, all MIT-licensed npm packages.

- All five serve MCP tools and start processes (two only likely: one through
  execa, one through child_process calls REA did not classify).
- Two have a tool whose code reaches process execution and two run commands
  through a shell; for the other three REA's facts cannot tell, because they
  start processes through libraries REA does not model (execa, node-pty) or
  child_process calls it did not classify.
- Only @mako10k/mcp-shell-server runs interactive terminal sessions
  (node-pty). Only desktop-commander contacts remote hosts, among them two
  whose names say telemetry; REA examined desktop-commander only in part.
- Openings: no telemetry, commands without a shell, narrow agent tools.

**ai-renamer releases** (`run-demo.sh history`, GPL-3.0): from 1.0.19 the
tool calls its models through axios, which REA does not model, so its AI
traits become unknown rather than absent; 1.0.23 starts running commands
through a shell (`exec()` in its frame extraction).

## Limits and cost

- Landscape reads shipped code statically; it does not run the products. A
  trait not seen where REA looked is not proof the product lacks it.
- Bundled code hides the packages it was built from, and providers reached
  through a configurable base URL are not told apart. REA did not report a
  URL assigned inside a branch as a literal (ai-renamer 1.0.19), which is
  why those releases read as unknown.
- REA's limits are Release Watch's (`--depth standard|deep` and the limit
  options). A large product may be examined only in part; its absent traits
  are then unknown.

Measured on this container (4 CPUs), one run each, standard depth, two
products at a time:

| Run                              | Wall      | CPU   | Peak memory (process family) |
| -------------------------------- | --------- | ----- | ---------------------------- |
| fixtures map, 4 small products   | 4.7–5.0 s | 12 s  | 0.75 GB                      |
| terminal MCP servers, 5 packages | 141 s     | 219 s | 2.1 GB                       |
| ai-renamer history, 6 releases   | 12.7 s    | 33 s  | 0.84 GB                      |

Most of the MCP map's time and memory is desktop-commander (266 files):
about 137 s of REA analysis, and Evidence of about 300 MB that Landscape
reads whole. Agent tokens were not measured; Landscape makes no model calls.

## Use it responsibly

- Analyze only software you own, are licensed to analyze, or that is
  published under terms that allow it, such as the open-source packages the
  demo maps. Some license agreements forbid reverse engineering; the right to
  study code for interoperability differs by country.
- The brief is meant for clean-room work: the team that builds from it should
  not need, and should not get, the products' code or Evidence.
- Treat findings about other people's products as what they are: facts with
  Evidence and stated limits. Report a security problem to its maintainers
  before publishing it.

## Tests

```bash
cd products/landscape && npm test     # needs the REA build from npm run build:cached
```

The CLI tests map the checked-in example products in `test/fixtures` and
products the tests write, with REA's real output; `model.test.mjs` covers
counting, opening and trajectory rules directly.
