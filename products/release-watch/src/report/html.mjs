// Self-contained HTML report: verdict first, then one ledger row per finding,
// then the inventory, provenance and run cost.
import { inventory } from "./model.mjs";

const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const BASIS = {
  observed: "Observed",
  inferred: "Inferred",
  heuristic: "Heuristic",
  unknown: "Unknown",
};
const DECISION = {
  block: { word: "Block", line: "Do not roll this update out." },
  review: {
    word: "Review",
    line: "A person should review these changes before rollout.",
  },
  pass: { word: "Pass", line: "No change reached the review threshold." },
};
const STATUS = {
  added: "added",
  removed: "removed",
  changed: "changed",
  unchanged: "unchanged",
  ambiguous: "ambiguous",
  "not-previously-observed": "new",
  "no-longer-observed": "gone",
};

const short = (digest) => (digest ? `${digest.slice(0, 12)}…` : "—");

const STYLE = `
/* Layout: an audit ledger. Verdict band, then findings as ruled rows with a
   severity column, then reference tables. */
:root {
  --paper: #f5f7f7; --sheet: #ffffff; --ink: #11222a; --muted: #5a6b72; --rule: #d7dfe1;
  --accent: #0b5d72; --code: #eef3f4;
  --critical: #a8201a; --high: #c2410c; --medium: #a15c07; --low: #1d5fbf; --info: #64748b;
  --display: "Archivo", "Helvetica Neue", Arial, sans-serif;
  --body: "IBM Plex Sans", "Segoe UI", Roboto, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0d1518; --sheet: #121d21; --ink: #e2eaec; --muted: #94a6ac; --rule: #263539;
    --accent: #5fb7cb; --code: #172529;
    --critical: #f2716a; --high: #f59252; --medium: #e0a53d; --low: #78a9f2; --info: #9aa8b4;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #0d1518; --sheet: #121d21; --ink: #e2eaec; --muted: #94a6ac; --rule: #263539;
  --accent: #5fb7cb; --code: #172529;
  --critical: #f2716a; --high: #f59252; --medium: #e0a53d; --low: #78a9f2; --info: #9aa8b4;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 var(--body); }
.wrap { max-width: 1120px; margin: 0 auto; padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
header.band { background: var(--sheet); border-bottom: 1px solid var(--rule); }
header .wrap { padding-block: 28px 24px; display: grid; gap: 20px; }
.brand { display: flex; align-items: center; gap: 10px; font: 600 13px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.brand svg { width: 18px; height: 18px; color: var(--accent); }
.title-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 32px; }
h1 { margin: 0; font: 700 clamp(26px, 4vw, 38px)/1.1 var(--display); letter-spacing: -.01em; text-wrap: balance; }
h1 .versions { display: block; margin-top: 6px; font: 500 16px/1.3 var(--mono); color: var(--muted); letter-spacing: 0; }
.verdict { display: grid; gap: 4px; justify-items: end; text-align: right; }
.verdict .word { font: 800 34px/1 var(--display); text-transform: uppercase; letter-spacing: .04em; }
.verdict.block .word { color: var(--critical); }
.verdict.review .word { color: var(--medium); }
.verdict.pass .word { color: var(--accent); }
.verdict .line { color: var(--muted); font-size: 14px; }
.stats { display: flex; flex-wrap: wrap; gap: 8px 28px; padding-top: 16px; border-top: 1px solid var(--rule); font-variant-numeric: tabular-nums; }
.stat { display: grid; gap: 2px; min-width: 0; }
.stat b { font: 700 22px/1.1 var(--display); }
.stat span { font: 500 11px/1.2 var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.stat.sev b { color: var(--sev); }
main .wrap { padding-block: 28px 56px; display: grid; gap: 40px; }
h2 { margin: 0 0 4px; font: 700 20px/1.2 var(--display); text-wrap: balance; }
.lede { margin: 0 0 16px; color: var(--muted); max-width: 70ch; }
.ledger { border-top: 2px solid var(--ink); }
.finding { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 0 24px; padding-block: 22px; border-bottom: 1px solid var(--rule); scroll-margin-top: 16px; }
.finding:target { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.gutter { display: grid; align-content: start; gap: 6px; }
.gutter .fid { font: 600 13px/1 var(--mono); color: var(--muted); }
.sevtag { justify-self: start; font: 700 11px/1 var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--sev); border: 1.5px solid var(--sev); padding: 5px 7px 4px; }
.finding.critical .sevtag { background: var(--sev); color: var(--sheet); }
.rule-id { font: 500 11px/1 var(--mono); color: var(--muted); }
.critical { --sev: var(--critical); } .high { --sev: var(--high); } .medium { --sev: var(--medium); } .low { --sev: var(--low); } .info { --sev: var(--info); }
.body { display: grid; gap: 10px; min-width: 0; }
h3 { margin: 0; font: 650 18px/1.3 var(--display); text-wrap: balance; }
.summary { margin: 0; max-width: 72ch; }
.why { margin: 0; color: var(--muted); max-width: 72ch; }
.evidence { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 8px; }
.evidence li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 4px 12px; align-items: start; }
.basis { font: 600 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 4px 6px 3px; text-align: center; border: 1px solid var(--muted); color: var(--muted); margin-top: 2px; }
.basis.observed { background: var(--ink); border-color: var(--ink); color: var(--sheet); }
.basis.inferred { border-color: var(--ink); color: var(--ink); }
.basis.heuristic { border-style: dashed; border-color: var(--accent); color: var(--accent); }
.basis.unknown { border-style: dotted; }
.claim { min-width: 0; overflow-wrap: anywhere; }
.where { display: block; font: 500 12.5px/1.4 var(--mono); color: var(--muted); }
.where .source { color: var(--muted); }
.snippet { grid-column: 2; display: flex; gap: 12px; align-items: baseline; margin: 2px 0 0; background: var(--code); padding: 7px 10px; overflow-x: auto; font: 13px/1.45 var(--mono); }
.snippet .ln { color: var(--muted); user-select: none; flex: none; }
.snippet code { white-space: pre; }
.snippet .ok { margin-left: auto; padding-left: 16px; flex: none; color: var(--accent); font-size: 11px; }
.unknowns { margin: 2px 0 0; padding: 10px 12px; border-left: 3px dotted var(--muted); background: var(--code); display: grid; gap: 4px; max-width: 80ch; }
.unknowns strong { font: 600 11px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.next { margin: 2px 0 0; font-weight: 500; max-width: 72ch; }
.next::before { content: "Next step  "; font: 600 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap: 28px 32px; }
.table { min-width: 0; }
.table.wide { grid-column: 1 / -1; }
.table h4 { margin: 0 0 8px; font: 650 15px/1.3 var(--display); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 10px 7px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font: 600 11px/1.2 var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
td.mono, .mono { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.st { font: 600 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }
.st.added, .st.new, .st.changed { color: var(--high); }
.st.removed, .st.gone { color: var(--low); }
.st.unchanged { color: var(--muted); }
.regressed { color: var(--high); font-weight: 600; }
.empty { color: var(--muted); font-style: italic; }
footer { color: var(--muted); font-size: 13px; }
footer .wrap { padding-block: 0 40px; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 640px) {
  .finding { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .gutter { grid-auto-flow: column; justify-content: start; align-items: center; gap: 10px; }
  .evidence li { grid-template-columns: minmax(0, 1fr); }
  .basis { justify-self: start; }
  .snippet { grid-column: 1; }
  .verdict { justify-items: start; text-align: left; }
}
`;

const MARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h10M4 12h16M4 17h7"/><circle cx="18" cy="7" r="2.2"/><circle cx="15" cy="17" r="2.2"/></svg>`;

const evidenceItem = (item) => {
  const where = item.location?.file
    ? `${item.location.file}${item.location.line ? `:${item.location.line}` : ""}`
    : null;
  const snippet = item.snippet
    ? `<div class="snippet"><span class="ln">${item.snippet.line}</span><code>${escape(item.snippet.text)}</code>${item.snippet.verified ? `<span class="ok" title="File SHA-256 matches REA's digest">sha256 ✓ ${escape(item.snippet.release)}</span>` : ""}</div>`
    : "";
  return `<li><span class="basis ${item.basis}">${BASIS[item.basis] ?? item.basis}</span><div class="claim">${escape(item.claim)}<span class="where">${where ? `${escape(where)} · ` : ""}<span class="source">${escape(item.source)}</span></span></div>${snippet}</li>`;
};

const findingRow = (finding) => `
<article class="finding ${finding.severity}" id="${finding.id}">
  <div class="gutter"><span class="fid">${finding.id}</span><span class="sevtag">${finding.severity}</span><span class="rule-id">${finding.rule}</span></div>
  <div class="body">
    <h3>${escape(finding.title)}</h3>
    <p class="summary">${escape(finding.summary)}</p>
    <p class="why">${escape(finding.why)}</p>
    <ul class="evidence">${finding.evidence.map(evidenceItem).join("")}</ul>
    ${finding.unknowns.length ? `<div class="unknowns"><strong>Not established</strong>${finding.unknowns.map((unknown) => `<span>${escape(unknown)}</span>`).join("")}</div>` : ""}
    <p class="next">${escape(finding.recommendation)}</p>
  </div>
</article>`;

const table = (title, headers, rows, wide = false) => `
<section class="table${wide ? " wide" : ""}"><h4>${escape(title)}</h4>${
  rows.length === 0
    ? `<p class="empty">Nothing to show.</p>`
    : `<div class="scroll"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.join("")}</tr>`).join("")}</tbody></table></div>`
}</section>`;

const statusCell = (status) =>
  `<td><span class="st ${STATUS[status] ?? status}">${STATUS[status] ?? status}</span></td>`;
const cell = (value, mono = false) =>
  `<td${mono ? ` class="mono"` : ""}>${escape(value)}</td>`;

const inventorySection = (report) => {
  const tables = inventory(report);
  const helperRows = tables.helpers.flatMap((helper) => [
    ...helper.dependencies.map((dependency) => [
      cell(helper.relative, true),
      cell(`${dependency.path} ${dependency.version}`, true),
      statusCell(dependency.status),
      cell(dependency.sum ?? "no checksum", true),
    ]),
    ...helper.settings.map((setting) => [
      cell(helper.relative, true),
      cell(setting.key, true),
      statusCell("changed"),
      cell(`${setting.before ?? "—"} → ${setting.after ?? "—"}`, true),
    ]),
  ]);
  return `
<section>
  <h2>What changed</h2>
  <p class="lede">Every capability REA recovered from both releases. "New" means REA saw it only in ${escape(report.right.label)} but its coverage of ${escape(report.left.label)} cannot prove it was absent.</p>
  <div class="tables">
    ${table(
      "Electron fuses",
      ["Fuse", report.left.label, report.right.label],
      tables.fuses.map((row) => [
        cell(row.name, true),
        cell(row.before),
        `<td class="${row.changed ? "regressed" : ""}">${escape(row.after)}</td>`,
      ]),
    )}
    ${table(
      "Renderer APIs and IPC",
      ["API", "Channel", "Status"],
      tables.bridge.map((row) => [
        cell(row.member, true),
        cell(row.channel, true),
        statusCell(row.status),
      ]),
    )}
    ${table(
      "URLs in code",
      ["URL", "Module", "Status"],
      tables.urls.map((row) => [
        cell(row.url, true),
        cell(row.module, true),
        statusCell(row.status),
      ]),
    )}
    ${table("Requests and processes", ["Call", "Module", "Status"], [...tables.requests.map((row) => [cell(`${row.method}()`, true), cell(row.module, true), statusCell(row.status)]), ...tables.processes.map((row) => [cell(`${row.method}() child process`, true), cell(row.module, true), statusCell(row.status)])])}
    ${table(
      "Files",
      ["Path", "Status"],
      tables.files.map((row) => [cell(row.path, true), statusCell(row.status)]),
    )}
    ${table("Helper binaries", ["Binary", "Item", "Status", "Detail"], helperRows, true)}
  </div>
</section>`;
};

const provenanceSection = (report) => {
  const rows = [];
  for (const side of [report.left, report.right]) {
    if (side.app)
      rows.push([
        cell(`${side.label} application`),
        cell(side.app.root_sha256 ? short(side.app.root_sha256) : "—", true),
        cell(side.app.evidence_id, true),
        cell(side.appEvidenceFile, true),
      ]);
    if (side.runtime)
      rows.push([
        cell(`${side.label} ${side.runtime.name} (fuses)`),
        cell(short(side.runtime.fuses.sha256), true),
        cell(side.runtime.fuses.evidence_id, true),
        cell(side.runtime.file, true),
      ]);
    for (const helper of side.helpers)
      if (helper.go)
        rows.push([
          cell(`${side.label} ${helper.relative}`),
          cell(short(helper.go.sha256), true),
          cell(helper.go.evidence_id, true),
          cell(helper.file, true),
        ]);
  }
  if (report.comparison?.evidence_id)
    rows.push([
      cell("REA version comparison"),
      cell("—"),
      cell(report.comparison.evidence_id, true),
      cell(report.comparison.file, true),
    ]);
  const calls = report.run.rea_calls.map((call) => [
    cell(call.label, true),
    cell(`${(call.elapsed_ms / 1000).toFixed(2)} s`),
    cell(call.ok ? "ok" : "failed"),
  ]);
  const coverage = [report.left, report.right]
    .filter((side) => side.app)
    .map((side) => [
      cell(side.label),
      cell(side.app.coverage.graph),
      cell(side.app.coverage.semantic),
    ]);
  return `
<section>
  <h2>Evidence and cost</h2>
  <p class="lede">Each finding links to complete REA Evidence saved next to this report. The analysis is deterministic and sent no data to a model.</p>
  <div class="tables">
    ${table("Evidence records", ["Subject", "SHA-256", "Evidence ID", "File"], rows, true)}
    ${table("REA calls", ["Step", "Time", "Result"], calls)}
    ${table("REA coverage", ["Release", "Application graph", "Semantic graph"], coverage)}
  </div>
</section>`;
};

/** Render the full HTML report. */
export const renderHtml = (report) => {
  const verdict = report.verdict;
  const decision = DECISION[verdict.decision];
  const stats = [
    ...["critical", "high", "medium", "low"].map(
      (severity) =>
        `<div class="stat sev ${severity}"><b>${verdict.counts[severity]}</b><span>${severity}</span></div>`,
    ),
    `<div class="stat"><b>${report.run.rea_calls.length}</b><span>REA calls</span></div>`,
    `<div class="stat"><b>${(report.run.elapsed_ms / 1000).toFixed(1)} s</b><span>analysis time</span></div>`,
    `<div class="stat"><b>${report.run.llm_tokens}</b><span>LLM tokens</span></div>`,
  ].join("");
  const errors = report.errors.length
    ? `<section><h2>Analysis errors</h2>${report.errors.map((error) => `<p class="mono">${escape(error.side)} ${escape(error.operation)}: ${escape(error.message)}</p>`).join("")}</section>`
    : "";
  const product = report.product ?? "Release";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(product)} ${escape(report.right.label)} review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style>
</head>
<body>
<header class="band"><div class="wrap">
  <div class="brand">${MARK}Release Watch</div>
  <div class="title-row">
    <h1>${escape(product)} update review<span class="versions">${escape(report.left.label)} → ${escape(report.right.label)}</span></h1>
    <div class="verdict ${verdict.decision}"><span class="word">${decision.word}</span><span class="line">${decision.line}</span></div>
  </div>
  <div class="stats">${stats}</div>
</div></header>
<main><div class="wrap">
  <section>
    <h2>Findings</h2>
    <p class="lede">Ordered by severity. Each line says whether REA observed it, REA inferred it, or Release Watch correlated it; what neither could establish is listed separately.</p>
    <div class="ledger">${report.findings.map(findingRow).join("") || `<p class="empty">No findings.</p>`}</div>
  </section>
  ${inventorySection(report)}
  ${provenanceSection(report)}
  ${errors}
</div></main>
<footer><div class="wrap">Generated ${escape(report.generated_at)} by ${escape(report.tool.name)} ${escape(report.tool.version)} on REA Evidence. Static analysis only: neither release was executed.</div></footer>
</body>
</html>
`;
};
