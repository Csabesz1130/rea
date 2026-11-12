# Release Feed

Release Feed watches npm packages and says what each new release changed
in what its code can do. It asks the registry for every watched package's
latest release, compares a release it has not seen with the one before it
using [Release Watch](../release-watch/README.md), and publishes the
outcome as a feed: a page, a full report per comparison, a JSON Feed, an
Atom feed and, for findings that need a person, a webhook alert.

It is a prototype beside Release Watch, [Landscape](../landscape/README.md)
and [Proof Swarm](../proof-swarm/README.md), and what
[`products/vm`](../vm/README.md) runs as a service.

## Why

A review of a dependency goes stale with its next release, and popular
packages release often. Landscape's MCP Trust Index read the 40
most-downloaded MCP servers on npm on 20 October 2026. On 12 November, 23
days later, 28 of the 40 had a newer `latest` release, and the registry
listed 610 releases published between the old and the new ones, 102 for
one server alone. Nobody reads those by hand. Release Feed reads each new
latest release and reports the changes a reviewer would want to know
about: a new tool, a new process call, a request to a new host, a new
dependency.

## First run

On 12 November 2026 Release Feed ran on those 40 servers with
`--since 2026-10-20`, one comparison at a time, in a container with 4
vCPUs and 13.7 GB of usable memory. It found 12 servers unchanged since
that day and compared the other 28; none failed.

| Measure                                       | Result                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Releases compared                             | 28                                                                                                                                                         |
| With a change found                           | 12: highest severity high in 3, medium in 6, low in 3                                                                                                      |
| Changes                                       | 34: 14 requests with an unresolved destination, 9 new process executions, 7 sets of new third-party packages, 3 more MCP tool registrations, 1 new MCP SDK |
| No change found                               | 16                                                                                                                                                         |
| With a note on code that was not examined     | 20                                                                                                                                                         |
| Wall time and CPU                             | 45.6 min and 93 min                                                                                                                                        |
| Peak memory, process family / largest process | 6.1 / 4.2 GB                                                                                                                                               |
| The same 40 again later that day, nothing new | 11 s, 0.15 GB                                                                                                                                              |

The three entries with a high change each add process execution:
hostinger-api-mcp and @hostinger/mcp, 3.4.0 → 3.40.0 with 101 and 102
releases in between, start processes in a new OAuth flow and a headless
launcher, and supergateway 4.2.0 → 4.2.2 adds an `execFile` call. A
finding is what a rule recognised in two static readings, with the lines
it rests on in the report; it is not a judgement of the package.

What the run taught, beyond its numbers:

- It made a 29th comparison that was wrong. For xcodebuildmcp the
  `--since` rule took 26.0.0, a stray higher number published long before,
  for the release of 20 October, and compared it with the real latest,
  2.7.0. Reading the results caught it. The rule now takes the latest
  release itself when it was already out that day and nothing above it
  otherwise; it agrees with the run on the other 39 packages, and the
  entry was removed. The times above include that comparison.
- Release Watch reports code it could not examine as findings too, some
  of them high, and 20 of the 28 comparisons had one. Counted with the
  changes, they were the highest finding of 16 entries. The feed now
  keeps them apart: an entry's severity and its alerts come from changes
  only, and what was not examined is a note beside them.
- More depth is not the cure for those notes. With `--depth deep` two of
  three partly examined packages took twice as long and kept every note;
  the third was stopped. In @ui5/mcp-server the files in question are
  templates and tests REA cannot analyze in either release.
- Reports named the directory the feed ran in. The site's copies now give
  paths relative to the work directory.

## How it works

1. **Ask.** `npm view` gives a package's `latest` release and when each
   version was published. A package whose latest release was already seen
   costs that one call.
2. **Choose what to compare with.** A new latest release is compared with
   the release last seen. On first sight a package is only recorded,
   unless `--since <day>` asks for the stable release as of that day (the
   greatest plain x.y.z published by then), or `--backfill` for the stable
   release just below the latest.
3. **Fetch.** `npm pack --ignore-scripts` downloads both tarballs. Each
   must have the sha512 integrity the registry states, and a release seen
   before must still have the integrity recorded then. A tarball is
   unpacked through a size limit and refused when it holds a symbolic
   link, a hard link, a device or a pipe, which npm would not install and
   which could make a reader follow a path out of the package. Nothing
   downloaded is run.
4. **Compare.** Release Watch compares the two directories in a child
   process with its own heap and a time limit. REA reads both releases
   statically.
5. **Record.** The outcome is an entry: the two versions with their
   integrity and publish times, how many releases lay between them,
   Release Watch's verdict, its findings as changes or as notes on code
   that was not examined (its RW-C rules), and the ids and digests of
   REA's Evidence. A release that could not be
   compared is an entry that says why.
6. **Publish.** The site is built again from the entries and swapped in
   whole. REA's Evidence, which may hold the packages' text, stays out of
   it.
7. **Alert.** With `RELEASE_FEED_WEBHOOK_URL` set, each comparison with a
   change at or above `--alert-on` is posted once as `{ text, title,
   entry }`; a note on code that was not examined alerts nobody. A tarball whose integrity changed or that held a link alerts
   whatever the threshold. A delivery that fails is tried again on the
   next run. The URL is read from the environment and written nowhere.

## Quick start

It needs what Release Watch needs: a built REA checkout
(`npm ci && npm run build:cached` at the repository root), Node.js, npm and
tar, on Linux.

```bash
cd products/release-feed
node bin/release-feed.mjs run watchlists/mcp-top-40.json --work ~/feed \
  --since 2026-10-20          # first run: what changed since that day
node bin/release-feed.mjs run watchlists/mcp-top-40.json --work ~/feed
                              # every later run: only what is new
node bin/release-feed.mjs status --work ~/feed
```

A watchlist is `{ "title": "…", "packages": ["name", "@scope/name"] }`.
`run` prints a summary and exits 0 when it completed; `--help` lists the
options. Open `~/feed/site/index.html`, or serve `~/feed/site` with any
web server:

| File                             | What it is                                        |
| -------------------------------- | ------------------------------------------------- |
| `index.html`                     | The newest 200 entries, changes by severity       |
| `reports/<package>/<old>_<new>/` | Release Watch's report as HTML, JSON and Markdown |
| `feed.xml`, `feed.json`          | Atom and JSON Feed 1.1 of the newest 50 entries   |
| `api/entries.json`               | Every entry                                       |

`--base-url` makes the feeds' links absolute. `--no-reports` leaves the
full reports out of the site; they quote the lines a finding rests on.

## A larger machine

`run` sizes itself: it runs as many comparisons at once as both the
machine's CPUs and its memory allow, and gives each a heap of three
quarters of memory split among them, between 2 and 8 GB. One comparison
analyzes two releases at once; on the 40 MCP servers two analyses used 2.3
CPUs on average and peaked at 6.4 GB for the largest packages, so a
comparison is counted as 2 CPUs and 6.5 GB, with 1.5 GB left to the system.

| Machine        | Comparisons at once | Heap of each |
| -------------- | ------------------- | ------------ |
| 4 vCPU, 8 GB   | 1                   | 5.7 GB       |
| 8 vCPU, 16 GB  | 2                   | 5.7 GB       |
| 16 vCPU, 32 GB | 4                   | 5.7 GB       |

`--parallel` and `--heap-mb` replace either. Only the first row's shape
was measured (above), with one comparison at a time; the others are the
rule's arithmetic. `--depth deep` passes Release Watch's deep setting on,
for more time per comparison.

## What a run keeps

Under `--work`: `state.json` (each package's latest release and its
integrity), `entries/` (one JSON file per comparison), `reports/` (Release
Watch's output, with REA's Evidence), `packages/` (the latest release of
each compared package, unpacked for the next comparison), `site/` and
`last-run.json`. Evidence is the bulk: `--max-evidence-gb` (default 10)
keeps the newest and removes the oldest as a run goes; the entry keeps the
Evidence ids and digests. One run at a time may write a work directory; a
second one stops with exit status 1.

## What it does not establish

- Everything Release Watch does not: findings are changes its rules
  recognise between two static readings. "New" means REA saw it only in
  the new release. No change found means no rule matched in the code REA
  examined, not that a release is safe; in the first run most entries
  carried a note that part of the changed code was not examined.
- It compares the release last seen with the latest one. With several
  releases in between it says how many, and reads none of them.
- "The stable release as of a day" is the latest release when it was
  already out that day, else the greatest plain x.y.z published by then
  below it: usually, not always, what `latest` named that day.
- It follows the `latest` tag. A release under another tag is not seen
  until `latest` moves to it.
- The registry's integrity says the tarball is the one the registry
  lists, not who published it or what it does.
- Reports quote short lines of the packages' code. Publish a site with
  them for packages whose licences allow it, or with `--no-reports`.

## Tests

```bash
cd products/release-feed && npm test
```

The tests start a small npm registry on 127.0.0.1 and run the CLI against
it, so npm, the integrity check, unpacking, Release Watch and REA run for
real on packages written for each case: a package recorded on first
sight, compared on its next release (a tool that starts a process and a
new host), published and alerted exactly once, with neither the webhook's
URL nor the work directory's path in a file of the site; `--since` across
a prerelease, where a note on unexamined code alerts nobody and Evidence
is removed at a zero budget; a registry that states an integrity
the tarball lacks, a tarball with a link out of the package, one that
unpacks beyond the limit, and a version published again with other
content; a held lock and a stale one; a watchlist entry that is an npm
flag; hostile text escaped on the page and in the feeds; and the rules
that choose which release to compare with and how many comparisons a
machine runs. The two comparisons need REA built.
