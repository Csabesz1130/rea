// The feed as files a web server can serve as they are: a page of what
// changed, each comparison's Release Watch report, a JSON Feed, an Atom
// feed and the entries as JSON. Built again from the entries on each run;
// REA's Evidence, which may hold the packages' text, is never copied.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { escapeHtml } from "../../release-watch/src/report/html.mjs";
import { severityRank } from "../../release-watch/src/rules/shared.mjs";
import { readEntries, writeJson } from "./state.mjs";

const REPORT_FILES = ["report.html", "report.json", "report.md"];
// How many entries the page and the feeds show; api/entries.json has all.
const PAGE_ENTRIES = 200;
const FEED_ENTRIES = 50;
const SHOWN_FINDINGS = 4;
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

const segment = (text) => encodeURIComponent(text);
const reportPath = (entry) =>
  `reports/${segment(entry.slug)}/${segment(`${entry.old.version}_${entry.new.version}`)}`;
const day = (time) =>
  typeof time === "string" ? time.slice(0, 10) : "unknown date";

const changesOf = (entry) =>
  (entry.findings ?? []).filter((finding) => finding.kind === "change");
const notesOf = (entry) =>
  (entry.findings ?? []).filter((finding) => finding.kind === "coverage");
const highestOf = (entry) => entry.changes?.highest ?? "info";
const examinedInPart = (entry) =>
  entry.status === "compared" &&
  (entry.verdict.errors > 0 ||
    notesOf(entry).length > 0 ||
    entry.coverage.old.length + entry.coverage.new.length > 0);

// One line that says what an entry found, for a feed title or an alert.
export const headlineOf = (entry) => {
  const pair = `${entry.package} ${entry.old.version} → ${entry.new.version}`;
  if (entry.status !== "compared")
    return `${pair}: not compared (${entry.reason})`;
  const count = entry.changes.count;
  const found =
    count === 0
      ? "no change found"
      : `${count} change${count === 1 ? "" : "s"}, highest ${highestOf(entry)}`;
  return `${pair}: ${found}${examinedInPart(entry) ? ", examined in part" : ""}`;
};

// The entry as plain text: its changes by severity, then what the
// analysis could not examine.
export const textOf = (entry) => {
  const lines = [headlineOf(entry)];
  if (entry.status !== "compared") lines.push(entry.detail ?? "");
  for (const finding of changesOf(entry))
    lines.push(`[${finding.severity}] ${finding.rule} ${finding.title}`);
  for (const finding of notesOf(entry))
    lines.push(`[not examined] ${finding.rule} ${finding.title}`);
  if (entry.releases_between > 1)
    lines.push(`${entry.releases_between} releases were published in between.`);
  return lines.filter(Boolean).join("\n");
};

const CSS = `
:root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b675f; --line: #e3dfd6; --card: #ffffff;
  --critical: #a4161a; --high: #c2410c; --medium: #a16207; --low: #3f6212; --info: #475569; --link: #1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --bg: #15140f; --fg: #ece9e1; --muted: #a09b90; --line: #2e2c25;
  --card: #1c1b16; --critical: #ff8a8a; --high: #fdba74; --medium: #facc15; --low: #bef264; --info: #cbd5e1; --link: #93c5fd; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2rem max(1rem, env(safe-area-inset-left)) 4rem; }
h1 { font-size: 1.7rem; line-height: 1.2; margin: 0 0 .4rem; text-wrap: balance; }
p { margin: .4rem 0; max-width: 65ch; }
a { color: var(--link); }
.muted, footer { color: var(--muted); font-size: .9rem; }
.facts { display: flex; flex-wrap: wrap; gap: .4rem 1.4rem; margin: 1rem 0 1.6rem; padding: 0; list-style: none; }
.facts b { font-variant-numeric: tabular-nums; }
.entries { display: grid; gap: .8rem; padding: 0; margin: 0; list-style: none; }
.entry { background: var(--card); border: 1px solid var(--line); border-left: .3rem solid var(--info); border-radius: .4rem; padding: .8rem 1rem; min-width: 0; }
.entry.critical { border-left-color: var(--critical); } .entry.high { border-left-color: var(--high); }
.entry.medium { border-left-color: var(--medium); } .entry.low { border-left-color: var(--low); }
.entry h2 { font-size: 1.05rem; margin: 0; overflow-wrap: anywhere; }
.entry h2 span { font-weight: 400; font-variant-numeric: tabular-nums; }
.entry ul { margin: .5rem 0 0; padding-left: 1.1rem; }
.entry li { overflow-wrap: anywhere; }
.sev { font-size: .75rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.sev.critical { color: var(--critical); } .sev.high { color: var(--high); } .sev.medium { color: var(--medium); }
.sev.low { color: var(--low); } .sev.info { color: var(--info); }
.meta { display: flex; flex-wrap: wrap; gap: .2rem 1rem; margin-top: .5rem; }
footer { margin-top: 2.5rem; border-top: 1px solid var(--line); padding-top: 1rem; }
`;

const findingsHtml = (entry) => {
  const changes = changesOf(entry).sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const shown = changes.slice(0, SHOWN_FINDINGS);
  const more = changes.length - shown.length;
  const notes = notesOf(entry);
  return `${
    changes.length === 0
      ? `<p class="muted">No change found by the rules in what REA examined.</p>`
      : `<ul>${shown
          .map(
            (finding) =>
              `<li><span class="sev ${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span> ${escapeHtml(finding.title)}</li>`,
          )
          .join(
            "",
          )}${more > 0 ? `<li class="muted">and ${more} more in the report</li>` : ""}</ul>`
  }${
    notes.length > 0
      ? `<p class="muted">Not examined: ${escapeHtml(notes[0].title)}${notes.length > 1 ? `, and ${notes.length - 1} more note${notes.length === 2 ? "" : "s"}` : ""}.</p>`
      : ""
  }`;
};

const entryHtml = (entry, { reports }) => {
  const compared = entry.status === "compared";
  const between =
    entry.releases_between > 1
      ? `${entry.releases_between} releases in between`
      : null;
  const meta = [
    `published ${escapeHtml(day(entry.new.published))}`,
    `compared with ${escapeHtml(entry.basis)}`,
    between,
    examinedInPart(entry) ? "examined in part" : null,
    entry.new.license ? `license ${escapeHtml(entry.new.license)}` : null,
    compared && reports
      ? `<a href="${reportPath(entry)}/report.html">full report</a>`
      : null,
  ].filter(Boolean);
  const body = compared
    ? findingsHtml(entry)
    : `<p class="muted">Not compared: ${escapeHtml(entry.reason)}. ${escapeHtml(entry.detail ?? "")}</p>`;
  return `<li class="entry ${compared && entry.changes.count > 0 ? escapeHtml(highestOf(entry)) : "info"}">
<h2>${escapeHtml(entry.package)} <span>${escapeHtml(entry.old.version)} → ${escapeHtml(entry.new.version)}</span></h2>
${body}
<div class="meta muted">${meta.map((item) => `<span>${item}</span>`).join("")}</div>
</li>`;
};

const pageHtml = (entries, { title, watched, checkedAt, reports }) => {
  const compared = entries.filter((entry) => entry.status === "compared");
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [
      severity,
      compared.filter(
        (entry) => entry.changes.count > 0 && highestOf(entry) === severity,
      ).length,
    ]),
  );
  const flagged = SEVERITIES.filter((severity) => counts[severity] > 0)
    .map(
      (severity) =>
        `<li><b>${counts[severity]}</b> with a ${severity} change</li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="alternate" type="application/feed+json" href="feed.json">
<link rel="alternate" type="application/atom+xml" href="feed.xml">
<style>${CSS}</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
<p>What each new release of these packages changed in what its code can do: new tools, processes, requests, models and more. Each release is read statically with REA and compared by Release Watch; nothing is installed or run.</p>
<ul class="facts">
<li><b>${watched}</b> packages watched</li>
<li><b>${compared.length}</b> releases compared</li>
${flagged}
<li>last checked ${escapeHtml(day(checkedAt))}</li>
<li><a href="feed.xml">Atom</a> · <a href="feed.json">JSON Feed</a> · <a href="api/entries.json">all entries</a></li>
</ul>
<ul class="entries">
${entries
  .slice(0, PAGE_ENTRIES)
  .map((entry) => entryHtml(entry, { reports }))
  .join("\n")}
</ul>
<footer>
<p>A change is something a rule recognises between two releases, with the lines it rests on in the report. "New" means REA saw it only in the new release. "Not examined" names code the analysis could not read in full. No change found means no rule matched in the code REA examined, not that a release is safe.</p>
<p>Made with Release Feed on REA.</p>
</footer>
</main></body></html>
`;
};

// Text for XML: escaped as for HTML, which also turns controls into
// spaces, then without what XML 1.0 forbids beyond them.
const xml = (value) =>
  escapeHtml(String(value).toWellFormed()).replace(/[\uFFFE\uFFFF]/g, " ");

const linkOf = (entry, baseUrl, reports) =>
  baseUrl && reports && entry.status === "compared"
    ? `${baseUrl}/${reportPath(entry)}/report.html`
    : (baseUrl ?? null);

const idOf = (entry) => `urn:release-feed:${segment(entry.id)}`;

const atom = (
  entries,
  { title, baseUrl, reports, updated },
) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${xml(title)}</title>
<id>${xml(baseUrl ? `${baseUrl}/` : `urn:release-feed:${segment(title)}`)}</id>
<updated>${xml(updated)}</updated>
${baseUrl ? `<link href="${xml(`${baseUrl}/`)}"/>\n<link rel="self" href="${xml(`${baseUrl}/feed.xml`)}"/>` : ""}
<author><name>Release Feed</name></author>
${entries
  .slice(0, FEED_ENTRIES)
  .map((entry) => {
    const link = linkOf(entry, baseUrl, reports);
    return `<entry>
<title>${xml(headlineOf(entry))}</title>
<id>${xml(idOf(entry))}</id>
<updated>${xml(entry.detected_at)}</updated>
<published>${xml(entry.new.published ?? entry.detected_at)}</published>
${link ? `<link href="${xml(link)}"/>` : ""}
<summary>${xml(textOf(entry))}</summary>
</entry>`;
  })
  .join("\n")}
</feed>
`;

const jsonFeed = (entries, { title, baseUrl, reports }) => ({
  version: "https://jsonfeed.org/version/1.1",
  title,
  ...(baseUrl
    ? { home_page_url: `${baseUrl}/`, feed_url: `${baseUrl}/feed.json` }
    : {}),
  items: entries.slice(0, FEED_ENTRIES).map((entry) => {
    const link = linkOf(entry, baseUrl, reports);
    return {
      id: idOf(entry),
      ...(link ? { url: link } : {}),
      title: headlineOf(entry),
      content_text: textOf(entry),
      date_published: entry.new.published ?? entry.detected_at,
      date_modified: entry.detected_at,
      tags: [
        entry.package,
        ...(entry.status !== "compared"
          ? [entry.status]
          : entry.changes.count > 0
            ? [highestOf(entry)]
            : []),
      ],
    };
  }),
});

/**
 * Builds the site of the feed in `work` under `work/site` and returns `{
 * directory, entries }`. `options` are `{ title, baseUrl, reports,
 * watched, checkedAt }`: `baseUrl` (no trailing slash) makes the feeds'
 * links absolute; `reports: false` leaves the full reports, which quote
 * lines of the packages' code, out of the site. `work` is an absolute
 * path. The site is built beside the old one and swapped in, so a server
 * never serves half of it.
 */
export const buildSite = (work, options) => {
  const entries = readEntries(work);
  const settings = {
    title: options.title ?? "Release Feed",
    baseUrl: options.baseUrl?.replace(/\/+$/, "") || null,
    reports: options.reports !== false,
    watched:
      options.watched ?? new Set(entries.map((entry) => entry.package)).size,
    checkedAt: options.checkedAt ?? entries[0]?.detected_at ?? null,
    updated:
      entries
        .map((entry) => entry.detected_at)
        .sort()
        .at(-1) ?? new Date(0).toISOString(),
  };
  const next = path.join(work, "site.next");
  rmSync(next, { recursive: true, force: true });
  mkdirSync(path.join(next, "api"), { recursive: true });
  writeFileSync(path.join(next, "index.html"), pageHtml(entries, settings));
  writeFileSync(path.join(next, "feed.xml"), atom(entries, settings));
  writeJson(path.join(next, "feed.json"), jsonFeed(entries, settings));
  writeJson(path.join(next, "api", "entries.json"), {
    title: settings.title,
    entries,
  });
  if (settings.reports)
    for (const entry of entries.filter((item) => item.status === "compared")) {
      const target = path.join(
        next,
        "reports",
        entry.slug,
        `${entry.old.version}_${entry.new.version}`,
      );
      mkdirSync(target, { recursive: true });
      for (const file of REPORT_FILES) {
        const source = path.join(work, entry.report, file);
        if (!existsSync(source)) continue;
        // The site's copy names files under the work directory relative
        // to it: where the feed runs is not the site's readers' business.
        writeFileSync(
          path.join(target, file),
          readFileSync(source, "utf8").replaceAll(`${work}${path.sep}`, ""),
        );
      }
    }
  const directory = path.join(work, "site");
  const previous = path.join(work, "site.previous");
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(directory)) renameSync(directory, previous);
  renameSync(next, directory);
  rmSync(previous, { recursive: true, force: true });
  return { directory, entries: entries.length };
};
