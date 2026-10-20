// Self-contained HTML report: openings first, then what the products do
// together, the caller's position or the trajectory, the map, and every
// cited evidence line. Renders the scrubbed report model only and loads
// nothing from the network.
import { GROUPS } from "../traits/definitions.mjs";
import { printable } from "../release-watch.mjs";
import {
  MARKS,
  coverageWords,
  lookups,
  placeOf,
  positionSections,
  presentLines,
  summarySections,
  trajectorySections,
} from "./text.mjs";

// Controls, line separators and bidirectional overrides become spaces, so
// product text cannot reorder what a reader sees.
const escape = (value) =>
  printable(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const anchor = (rowId, productId) =>
  `ev-${rowId.replace(/[^A-Za-z0-9_-]/g, "_")}-${productId}`;

const STYLE = `
/* A survey sheet: openings as numbered field notes, then the map as a grid
   of marks with a legend, then the evidence ledger. */
:root {
  --paper: #f4f3ee; --sheet: #fffefa; --ink: #1d2a24; --muted: #5d6a63; --rule: #d9dccf;
  --accent: #2f6b4f; --accent-soft: #e3ede5; --risk: #a3471b; --risk-soft: #f5e6dc;
  --likely: #8a6d1d; --unknown: #6b7280; --code: #efeee6;
  --display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --body: system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #121614; --sheet: #181e1b; --ink: #e4e9e4; --muted: #9aa69f; --rule: #2a332e;
    --accent: #7cc39d; --accent-soft: #1f2d25; --risk: #f0a070; --risk-soft: #33241b;
    --likely: #d9b45a; --unknown: #a0a7b0; --code: #1d2420;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #121614; --sheet: #181e1b; --ink: #e4e9e4; --muted: #9aa69f; --rule: #2a332e;
  --accent: #7cc39d; --accent-soft: #1f2d25; --risk: #f0a070; --risk-soft: #33241b;
  --likely: #d9b45a; --unknown: #a0a7b0; --code: #1d2420;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 var(--body); }
.wrap { max-width: 1120px; margin: 0 auto; padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
header.band { background: var(--sheet); border-bottom: 1px solid var(--rule); }
header .wrap { padding-block: 28px 22px; display: grid; gap: 14px; }
.brand { font: 600 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
h1 { margin: 0; font: 600 clamp(28px, 4.4vw, 44px)/1.08 var(--display); letter-spacing: -.01em; text-wrap: balance; }
.sub { margin: 0; color: var(--muted); max-width: 72ch; }
.products { display: flex; flex-wrap: wrap; gap: 8px; }
.product { display: grid; gap: 3px; padding: 8px 12px; border: 1px solid var(--rule); background: var(--paper); min-width: 0; }
.product b { font: 650 14px/1.25 var(--body); overflow-wrap: anywhere; }
.product span { font: 500 11.5px/1.3 var(--mono); color: var(--muted); }
.product.ours { border-color: var(--accent); }
.product .partial { color: var(--likely); }
main .wrap { padding-block: 8px 48px; display: grid; gap: 40px; }
section { display: grid; gap: 14px; min-width: 0; }
h2 { margin: 26px 0 0; font: 600 24px/1.2 var(--display); text-wrap: balance; }
h3 { margin: 0; font: 650 15px/1.3 var(--body); text-wrap: balance; }
.lede { margin: 0; color: var(--muted); max-width: 74ch; }
.openings { display: grid; gap: 12px; counter-reset: opening; }
.opening { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 4px 16px; padding: 16px 18px; background: var(--sheet); border: 1px solid var(--rule); border-left: 4px solid var(--accent); }
.opening.inversion { border-left-color: var(--risk); }
.opening .n { grid-row: 1 / span 4; font: 600 30px/1 var(--display); color: var(--accent); }
.opening > :not(.n) { grid-column: 2; }
.opening.inversion .n { color: var(--risk); }
.opening .kind { font: 600 10.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.opening p { margin: 0; max-width: 78ch; }
.opening .pitch { font-weight: 550; }
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.column { padding: 14px 16px; background: var(--sheet); border: 1px solid var(--rule); min-width: 0; }
.column ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; }
.column.risk h3 { color: var(--risk); }
.scroll { overflow-x: auto; border: 1px solid var(--rule); background: var(--sheet); }
table.map { border-collapse: collapse; width: 100%; min-width: 560px; font-variant-numeric: tabular-nums; }
.map th, .map td { padding: 7px 10px; border-bottom: 1px solid var(--rule); text-align: center; vertical-align: middle; }
.map thead th { font: 600 12px/1.25 var(--body); position: sticky; top: 0; background: var(--sheet); }
.map thead th.ours { color: var(--accent); }
.map th.trait { text-align: left; font: 500 14px/1.35 var(--body); position: sticky; left: 0; background: var(--sheet); min-width: 220px; }
.map tr.group th { text-align: left; font: 600 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); background: var(--paper); position: sticky; left: 0; }
.map tr.risk th.trait::after { content: " ⚠"; color: var(--risk); }
.map td a, .map td span, .legend span { font-family: "DejaVu Sans", "Segoe UI Symbol", "Noto Sans Symbols 2", "Apple Symbols", var(--body); }
.map td a { text-decoration: none; display: inline-block; width: 26px; height: 26px; line-height: 26px; border-radius: 50%; font-size: 15px; }
.mark-yes { color: var(--accent); background: var(--accent-soft); }
td.risk .mark-yes { color: var(--risk); background: var(--risk-soft); }
.map th.vertical { vertical-align: bottom; padding: 10px 4px; min-width: 36px; }
.map th.vertical span { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); max-height: 190px; text-align: left; font: 600 12px/1.25 var(--body); }
.map th.vertical.risk span { color: var(--risk); }
.map th.groupcol { font: 600 10.5px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); border-left: 1px solid var(--rule); text-align: left; }
.map th.trait small { display: block; font: 500 11px/1.3 var(--mono); color: var(--muted); }
.map tr.counts th, .map tr.counts td { border-top: 1.5px solid var(--ink); }
.mark-likely { color: var(--likely); }
.mark-no { color: var(--muted); }
.mark-unknown { color: var(--unknown); font: 600 13px/26px var(--mono); }
.map td.count { font: 500 12px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--muted); }
.ledger { display: grid; gap: 18px; }
.trait-ev { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--rule); }
.cell-ev { display: grid; gap: 4px; padding: 8px 12px; background: var(--sheet); border: 1px solid var(--rule); scroll-margin-top: 16px; }
.cell-ev:target { outline: 2px solid var(--accent); }
.cell-ev b { font: 600 13.5px/1.3 var(--body); }
.cell-ev ul { margin: 0; padding-left: 18px; display: grid; gap: 3px; font-size: 13.5px; }
.where { font: 500 12px/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.basis { font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
table.plain { border-collapse: collapse; width: 100%; font-size: 13.5px; }
.plain th, .plain td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.plain code, .cell-ev code { font: 12.5px/1.4 var(--mono); background: var(--code); padding: 1px 4px; overflow-wrap: anywhere; }
.limits { margin: 0; padding-left: 20px; color: var(--muted); display: grid; gap: 4px; max-width: 90ch; }
.timeline { display: grid; gap: 10px; }
.release { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr); gap: 12px; padding: 10px 14px; background: var(--sheet); border: 1px solid var(--rule); }
.release b { font: 600 13px/1.3 var(--mono); overflow-wrap: anywhere; }
.release ul { margin: 0; padding-left: 18px; }
.errors { border-left: 3px solid var(--risk); padding: 10px 14px; background: var(--risk-soft); }
footer { color: var(--muted); font-size: 13px; }
@media (max-width: 560px) {
  .opening { grid-template-columns: 1fr; }
  .opening .n { grid-row: auto; font-size: 22px; }
  .opening > :not(.n) { grid-column: 1; }
  .release { grid-template-columns: 1fr; }
}
`;

const list = (lines) =>
  `<ul>${lines.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>`;

const header = (model, look) => `
<header class="band"><div class="wrap">
  <div class="brand">Landscape · ${model.mode === "history" ? "trajectory" : "category map"}</div>
  <h1>${escape(model.category)}</h1>
  <p class="sub">${model.products.length} ${model.mode === "history" ? "releases" : "products"} read from their shipped code with REA on ${escape(model.generated_at.slice(0, 10))}. Counts cover ${look.compared.length} ${model.mode === "history" ? "releases" : "compared products"}${look.ours ? `; ${escape(look.ours.label)} is yours and is not counted` : ""}.</p>
  <div class="products">${model.products
    .map(
      (product) =>
        `<div class="product${product.role === "ours" ? " ours" : ""}"><b>${escape(product.label)}</b><span class="${product.coverage.status === "complete" ? "" : "partial"}">${escape(product.id)} · ${product.role === "ours" ? "yours · " : ""}${escape(coverageWords(product))}</span></div>`,
    )
    .join("")}</div>
</div></header>`;

const openingsSection = (model) =>
  model.openings.length === 0
    ? ""
    : `<section><h2>Openings</h2><p class="lede">Where a new product can differ: something few or none of these products offer, or a risk most of them share that it can avoid. Each is Landscape's reading of the counts below, not an observation.</p><div class="openings">${model.openings
        .map(
          (opening, index) =>
            `<article class="opening ${opening.kind === "inversion" ? "inversion" : "space"}"><div class="n">${index + 1}</div><div class="kind">${escape(opening.kind)}</div><h3>${escape(opening.title)}</h3><p>${escape(opening.finding)}</p><p class="pitch">${escape(opening.positioning)}</p></article>`,
        )
        .join("")}</div></section>`;

const columns = (sections, title, lede = "") =>
  sections === null || sections.length === 0
    ? ""
    : `<section><h2>${escape(title)}</h2>${lede}<div class="columns">${sections
        .map(
          ({ heading, lines }) =>
            `<div class="column${heading.startsWith("Risks") ? " risk" : ""}"><h3>${escape(heading)}</h3>${list(lines)}</div>`,
        )
        .join("")}</div></section>`;

const historySection = (model) => {
  const releases = trajectorySections(model);
  if (releases === null) return "";
  const present = presentLines(model);
  return `<section><h2>How it changed</h2><p class="lede">Each release lists the traits REA's facts now show or no longer show, against the last release they settled. A trait no longer seen may also mean the code now does it in a way REA does not report.</p><div class="timeline">${
    present.length > 0
      ? `<div class="release"><b>From the start</b>${list(present)}</div>`
      : ""
  }${releases
    .map(
      ({ version, lines }) =>
        `<div class="release"><b>${escape(version)}</b>${list(lines)}</div>`,
    )
    .join(
      "",
    )}${releases.length === 0 ? '<p class="lede">No trait changed between these releases.</p>' : ""}</div></section>`;
};

const cellLink = (row, product) => {
  const cell = row.cells[product.id];
  const mark = MARKS[cell.state];
  if (cell.state === "no")
    return `<td class="${row.kind}"><span class="mark-no" title="${escape(mark.word)}${cell.notes?.length ? `: ${escape(cell.notes.join("; "))}` : ""}">${mark.mark}</span></td>`;
  return `<td class="${row.kind}"><a class="mark-${cell.state}" href="#${anchor(row.id, product.id)}" title="${escape(product.label)} · ${escape(row.label)}: ${escape(mark.word)}">${mark.mark}</a></td>`;
};

// Maps of more products than this read better with products as rows.
const WIDE = 8;

const groupsOf = (model) =>
  GROUPS.map((group) => ({
    group,
    rows: model.rows.filter((row) => row.group === group.id),
  })).filter(({ rows }) => rows.length > 0);

// Products as rows and traits as columns, grouped as GROUPS orders them.
const productRows = (model, look) => {
  const groups = groupsOf(model);
  const rows = groups.flatMap((entry) => entry.rows);
  const head = `<tr><th class="trait" rowspan="2">Product</th>${groups
    .map(
      ({ group, rows: grouped }) =>
        `<th class="groupcol" colspan="${grouped.length}">${escape(group.label)}</th>`,
    )
    .join(
      "",
    )}</tr><tr>${rows.map((row) => `<th class="vertical ${row.kind}" title="${escape(row.label)}"><span>${escape(row.label)}</span></th>`).join("")}</tr>`;
  const body = model.products
    .map(
      (product) =>
        `<tr><th class="trait">${escape(product.label)}<small>${product.role === "ours" ? "yours · " : ""}${escape(coverageWords(product))}</small></th>${rows.map((row) => cellLink(row, product)).join("")}</tr>`,
    )
    .join("");
  const counts = `<tr class="counts"><th class="trait">Count</th>${rows.map((row) => `<td class="count">${row.counts.held}/${look.compared.length}</td>`).join("")}</tr>`;
  return `<thead>${head}</thead><tbody>${body}${counts}</tbody>`;
};

const traitRows = (model, look) => {
  const head = `<tr><th class="trait">Trait</th>${model.products
    .map(
      (product) =>
        `<th class="${product.role === "ours" ? "ours" : ""}" title="${escape(product.label)}">${escape(product.label)}</th>`,
    )
    .join("")}<th>Count</th></tr>`;
  const body = GROUPS.flatMap((group) => {
    const rows = model.rows.filter((row) => row.group === group.id);
    if (rows.length === 0) return [];
    return [
      `<tr class="group"><th colspan="${model.products.length + 2}">${escape(group.label)}</th></tr>`,
      ...rows.map(
        (row) =>
          `<tr class="${row.kind}"><th class="trait">${escape(row.label)}</th>${model.products
            .map((product) => cellLink(row, product))
            .join(
              "",
            )}<td class="count">${row.counts.held}/${look.compared.length}</td></tr>`,
      ),
    ];
  }).join("");
  return `<thead>${head}</thead><tbody>${body}</tbody>`;
};

const mapSection = (model, look) => {
  const table =
    model.products.length > WIDE
      ? productRows(model, look)
      : traitRows(model, look);
  return `<section><h2>Map</h2><div class="legend">${Object.values(MARKS)
    .map(
      (entry) =>
        `<span>${entry.mark} ${escape(entry.word)}: ${escape(entry.hint)}</span>`,
    )
    .join(
      "",
    )}<span>⚠ a risk to users</span></div><div class="scroll"><table class="map">${table}</table></div></section>`;
};

const where = (location, product) => {
  const place = placeOf(location, product);
  return place ? `<span class="where">${escape(place)}</span>` : "";
};

const cellEvidence = (row, product) => {
  const cell = row.cells[product.id];
  const id = anchor(row.id, product.id);
  if (cell.state === "unknown")
    return `<div class="cell-ev" id="${id}"><b>${escape(product.label)} · ${MARKS.unknown.word}</b>${list(cell.reasons)}</div>`;
  const more =
    cell.evidence_count > cell.evidence.length
      ? `<li>and ${cell.evidence_count - cell.evidence.length} more in the Evidence files report.json names</li>`
      : "";
  return `<div class="cell-ev" id="${id}"><b>${escape(product.label)} · ${MARKS[cell.state].word}</b><ul>${cell.evidence
    .map(
      (line) =>
        `<li>${escape(line.claim)} ${where(line.location, product)} <span class="basis">${escape(line.source)} · ${escape(line.basis)}</span></li>`,
    )
    .join("")}${more}</ul></div>`;
};

const evidenceSection = (model) =>
  `<section><h2>Evidence</h2><p class="lede">Every mark above links here. Lines from REA facts carry REA's evidence state; lines marked heuristic are Release Watch's or Landscape's reading of them.</p><div class="ledger">${model.rows
    .map((row) => {
      const cells = model.products
        .filter((product) => row.cells[product.id].state !== "no")
        .map((product) => cellEvidence(row, product));
      return `<div class="trait-ev"><h3>${escape(row.label)}</h3>${cells.join("")}</div>`;
    })
    .join("")}</div></section>`;

const stackSection = (model, look) =>
  model.stack.shared.length === 0
    ? ""
    : `<section><h2>Building blocks</h2><p class="lede">SDKs any product imports, and packages more than one imports; ${model.stack.single_use_packages} other packages are used by one product each.</p><div class="scroll"><table class="plain"><thead><tr><th>Package</th><th>Kind</th><th>Used by</th></tr></thead><tbody>${model.stack.shared
        .map(
          (use) =>
            `<tr><td><code>${escape(use.name)}</code></td><td>${escape(use.label ?? use.kind)}</td><td>${escape(use.products.map((id) => look.product(id).label).join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table></div></section>`;

const errorsSection = (model) =>
  model.errors.length === 0
    ? ""
    : `<section><h2>Errors</h2><div class="errors">${list(model.errors.map((error) => `${error.product}: ${error.message}`))}</div></section>`;

/** Render report.html. */
export const renderHtml = (model) => {
  const look = lookups(model);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(`${model.category}: ${model.mode === "history" ? "trajectory" : "category map"}`)}</title>
<style>${STYLE}</style></head>
<body>${header(model, look)}
<main><div class="wrap">
${errorsSection(model)}
${openingsSection(model)}
${model.mode === "map" ? columns(summarySections(model), "What the products do together") : ""}
${columns(positionSections(model), "Where you stand")}
${historySection(model)}
${mapSection(model, look)}
${stackSection(model, look)}
${evidenceSection(model)}
<section><h2>What this map does not establish</h2><ul class="limits">${model.limitations.map((line) => `<li>${escape(line)}</li>`).join("")}</ul></section>
<footer>REA calls: ${model.rea_calls.length}, ${(model.elapsed_ms / 1000).toFixed(1)} s in all · analysis depth ${escape(model.analysis.depth)} · generated by Landscape from REA Evidence.</footer>
</div></main></body></html>
`;
};
