// Self-contained HTML report: verdict first, then one ledger row per finding,
// then the inventory, provenance and run cost.
import { componentSections } from "./model.mjs";

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
  error: {
    word: "Error",
    line: "Part of the release could not be analyzed; nothing was cleared.",
  },
};
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
.verdict.error .word { color: var(--critical); }
.components { display: flex; flex-wrap: wrap; gap: 10px 14px; }
.component { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--rule); background: var(--paper); min-width: 0; }
.component b { font: 650 14px/1.2 var(--display); }
.component span { font: 500 12px/1.3 var(--mono); color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: 600 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 4px 6px 3px; border: 1px solid var(--accent); color: var(--accent); }
.gutter .comp { font: 500 11px/1.2 var(--mono); color: var(--accent); overflow-wrap: anywhere; }
.errors { border-left: 3px solid var(--critical); padding: 10px 14px; background: var(--code); display: grid; gap: 6px; }
h3.component-title { margin: 8px 0 12px; font: 700 17px/1.2 var(--display); }
.note { margin: 0 0 6px; color: var(--muted); font-size: 13px; }
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
.st.unchanged, .st.known { color: var(--muted); }
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
    ? `${item.location.file}${item.location.line ? `:${item.location.line}` : ""}${item.location.record !== undefined && item.location.record !== null ? ` record ${item.location.record}` : ""}`
    : null;
  const snippet = item.snippet
    ? `<div class="snippet"><span class="ln">${item.snippet.line}</span><code>${escape(item.snippet.text)}</code>${item.snippet.verified ? `<span class="ok" title="File SHA-256 matches REA's digest">sha256 ✓ ${escape(item.snippet.release)}</span>` : ""}</div>`
    : "";
  return `<li><span class="basis ${item.basis}">${BASIS[item.basis] ?? item.basis}</span><div class="claim">${escape(item.claim)}<span class="where">${where ? `${escape(where)} · ` : ""}<span class="source">${escape(item.source)}</span></span></div>${snippet}</li>`;
};

const findingRow = (finding, showComponent) => `
<article class="finding ${finding.severity}" id="${finding.id}">
  <div class="gutter"><span class="fid">${finding.id}</span><span class="sevtag">${finding.severity}</span><span class="rule-id">${finding.rule}</span>${showComponent ? `<span class="comp">${escape(finding.component)}</span>` : ""}</div>
  <div class="body">
    <h3>${escape(finding.title)}</h3>
    <p class="summary">${escape(finding.summary)}</p>
    <p class="why">${escape(finding.why)}</p>
    <ul class="evidence">${finding.evidence.map(evidenceItem).join("")}</ul>
    ${finding.unknowns.length ? `<div class="unknowns"><strong>Not established</strong>${finding.unknowns.map((unknown) => `<span>${escape(unknown)}</span>`).join("")}</div>` : ""}
    <p class="next">${escape(finding.recommendation)}</p>
  </div>
</article>`;

const STATUS_CLASS = new Set([
  "added",
  "new",
  "changed",
  "removed",
  "gone",
  "unchanged",
  "known",
]);

const cellHtml = (value) => {
  if (value !== null && typeof value === "object")
    return `<td class="mono${value.flag ? " regressed" : ""}">${escape(value.text)}</td>`;
  const text = String(value ?? "");
  if (STATUS_CLASS.has(text))
    return `<td><span class="st ${text}">${escape(text)}</span></td>`;
  return `<td class="mono">${escape(text)}</td>`;
};

const table = (entry, wide = false) => `
<section class="table${wide ? " wide" : ""}"><h4>${escape(entry.title)}</h4>${entry.note ? `<p class="note">${escape(entry.note)}</p>` : ""}<div class="scroll"><table><thead><tr>${entry.headers.map((header) => `<th>${escape(header)}</th>`).join("")}</tr></thead><tbody>${entry.rows.map((cells) => `<tr>${cells.map(cellHtml).join("")}</tr>`).join("")}</tbody></table></div></section>`;

const WIDE = new Set([
  "helpers",
  "headers",
  "destinations",
  "api-groups",
  "cookies",
]);

const inventorySection = (report) => `
<section>
  <h2>What changed</h2>
  <p class="lede">Every capability REA recovered from both releases. "New" means REA saw it only in the new release but its coverage of the old one cannot prove it was absent.</p>
  ${report.components
    .map((component) => {
      const sections = componentSections(component);
      return `${report.components.length > 1 ? `<h3 class="component-title">${escape(component.name)}</h3>` : ""}<div class="tables">${sections.length ? sections.map((entry) => table(entry, WIDE.has(entry.id))).join("") : `<p class="empty">Nothing changed that Release Watch tracks.</p>`}</div>`;
    })
    .join("")}
</section>`;

const short = (digest) => (digest ? `${digest.slice(0, 12)}…` : "—");

const evidenceRows = (component) => {
  const rows = [];
  for (const side of [component.left, component.right]) {
    const name = `${component.name} ${side.label}`;
    if (side.app)
      rows.push([
        `${name} application`,
        short(side.app.root_sha256),
        side.app.evidence_id,
        side.appEvidence ?? "—",
      ]);
    if (side.runtime)
      rows.push([
        `${name} ${side.runtime.name} fuses`,
        short(side.runtime.fuses.sha256),
        side.runtime.fuses.evidence_id,
        side.runtime.file,
      ]);
    for (const helper of side.helpers)
      if (helper.go)
        rows.push([
          `${name} ${helper.relative}`,
          short(helper.go.sha256),
          helper.go.evidence_id,
          helper.file,
        ]);
    if (side.capture)
      rows.push([
        `${name} capture ${side.capture.name}`,
        short(side.capture.sha256),
        side.capture.evidence_id,
        side.capture.file,
      ]);
  }
  if (component.comparison?.evidence_id)
    rows.push([
      `${component.name} REA version comparison`,
      "—",
      component.comparison.evidence_id,
      component.comparison.file,
    ]);
  return rows;
};

const provenanceSection = (report) => {
  const evidence = report.components.flatMap(evidenceRows);
  const coverage = report.components.flatMap((component) =>
    [component.left, component.right]
      .filter((side) => side.app)
      .map((side) => [
        `${component.name} ${side.label}`,
        side.app.coverage.graph,
        side.app.coverage.semantic,
        String(side.app.inlineScripts),
      ]),
  );
  const calls = report.run.rea_calls.map((call) => [
    call.label,
    `${(call.elapsed_ms / 1000).toFixed(2)} s`,
    call.ok ? "ok" : "failed",
  ]);
  return `
<section>
  <h2>Evidence and cost</h2>
  <p class="lede">Each finding links to complete REA Evidence saved next to this report under evidence/. The analysis is deterministic and sent no data to a model. The evidence directory keeps REA's records verbatim, including any credentials the releases contain; treat it as sensitive.</p>
  <div class="tables">
    ${table({ title: "Evidence records", headers: ["Subject", "SHA-256", "Evidence ID", "File"], rows: evidence }, true)}
    ${table({ title: "REA calls", headers: ["Step", "Time", "Result"], rows: calls })}
    ${coverage.length ? table({ title: "REA coverage", headers: ["Release", "Application graph", "Semantic graph", "Inline scripts"], rows: coverage }) : ""}
  </div>
</section>`;
};

const componentStrip = (report) =>
  `<div class="components">${report.components
    .map(
      (component) =>
        `<div class="component"><b>${escape(component.name)}</b><span>${escape(component.left.label)} → ${escape(component.right.label)} · ${escape(component.right.target?.kind ?? component.left.target?.kind ?? "missing")}</span>${component.surfaces.length ? `<div class="chips">${component.surfaces.map((surface) => `<span class="chip">${escape(surface)}</span>`).join("")}</div>` : ""}</div>`,
    )
    .join("")}</div>`;

const headline = (report) => {
  const kinds = new Set(
    report.components.flatMap((component) => [
      component.left.target?.kind,
      component.right.target?.kind,
    ]),
  );
  if (kinds.has("electron-dist") || kinds.has("asar")) return "update review";
  if (
    [...kinds].every(
      (kind) => kind === "web-build" || kind === "har" || kind === undefined,
    )
  )
    return "deployment review";
  return "release review";
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
    ? `<section><h2>Analysis errors</h2><div class="errors">${report.errors.map((error) => `<p class="mono">${escape(error.component)} ${escape(error.side)} · ${escape(error.operation)}: ${escape(error.message)}</p>`).join("")}</div></section>`
    : "";
  const product = report.product ?? "Release";
  const showComponent = report.components.length > 1;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(product)} ${escape(report.labels.right)} review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style>
</head>
<body>
<header class="band"><div class="wrap">
  <div class="brand">${MARK}Release Watch</div>
  <div class="title-row">
    <h1>${escape(product)} ${headline(report)}<span class="versions">${escape(report.labels.left)} → ${escape(report.labels.right)}</span></h1>
    <div class="verdict ${verdict.decision}"><span class="word">${decision.word}</span><span class="line">${decision.line}</span></div>
  </div>
  ${componentStrip(report)}
  <div class="stats">${stats}</div>
</div></header>
<main><div class="wrap">
  ${errors}
  <section>
    <h2>Findings</h2>
    <p class="lede">Ordered by severity. Each line says whether REA observed it, REA inferred it, or Release Watch correlated it; what neither could establish is listed separately.</p>
    <div class="ledger">${report.findings.map((finding) => findingRow(finding, showComponent)).join("") || `<p class="empty">No findings.</p>`}</div>
  </section>
  ${inventorySection(report)}
  ${provenanceSection(report)}
</div></main>
<footer><div class="wrap">Generated ${escape(report.generated_at)} by ${escape(report.tool.name)} ${escape(report.tool.version)} on REA Evidence. Static analysis and recorded captures only: Release Watch ran neither release.</div></footer>
</body>
</html>
`;
};
