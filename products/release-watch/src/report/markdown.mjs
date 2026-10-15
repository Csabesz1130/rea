// Short Markdown summary for CI logs, tickets and pull-request comments.
// Every value from a release is escaped, so a package name or IPC channel
// cannot add headings, links, HTML or a fake verdict.
import { markdownCode, markdownText as text } from "../redact.mjs";

const ICON = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "🟦",
  info: "⬜",
};
const DECISION = {
  block: "BLOCK",
  review: "REVIEW",
  pass: "PASS",
  error: "ERROR",
};
const MAX_LIMITS = 6;

const code = (value) => `\`${markdownCode(value)}\``;

const location = (item) => {
  const where = item.location;
  if (!where?.file) return "";
  const line = where.line ? `:${where.line}` : "";
  const record =
    where.record !== undefined && where.record !== null
      ? ` record ${where.record}`
      : "";
  return ` ${code(`${where.file}${line}${record}`)}`;
};

// Gaps on both sides: the old side's bound every "new" claim, the new
// side's bound every pass. Standing REA limitations are counted, not listed.
const limitLines = (model) => {
  const notes = model.components.flatMap((component) => [
    ...component.coverage.right.gaps.map(
      (note) => `${component.name} ${component.right.label}: ${note}`,
    ),
    ...component.coverage.left.gaps.map(
      (note) => `${component.name} ${component.left.label}: ${note}`,
    ),
    ...(component.coverage.comparison
      ? [`${component.name}: ${component.coverage.comparison}`]
      : []),
  ]);
  const standing = model.components.reduce(
    (total, component) =>
      total +
      component.coverage.right.limitations.length +
      component.coverage.left.limitations.length,
    0,
  );
  if (notes.length === 0 && standing === 0) return [];
  return [
    "**Coverage limits**",
    "",
    ...notes.slice(0, MAX_LIMITS).map((note) => `- ${text(note)}`),
    ...(notes.length > MAX_LIMITS
      ? [`- ${notes.length - MAX_LIMITS} more in report.json`]
      : []),
    ...(standing > 0
      ? [
          `- ${standing} standing REA limitations (what its analyses never establish) in report.json and report.html`,
        ]
      : []),
    ...model.limitations.map((note) => `- ${text(note)}`),
    "",
  ];
};

/** Render the report model (report.json) as Markdown. */
export const renderMarkdown = (model) => {
  const { verdict } = model;
  const several = model.components.length > 1;
  const lines = [
    `## Release Watch: ${text(model.product ?? "release")} ${text(model.labels.left)} → ${text(model.labels.right)}`,
    "",
    `**${DECISION[verdict.decision]}** · ${verdict.counts.critical} critical · ${verdict.counts.high} high · ${verdict.counts.medium} medium · ${verdict.counts.low} low`,
    "",
    ...model.components.map(
      (component) =>
        `- ${code(component.name)} ${component.left.present === false ? `${text(component.right.label)}, new component` : component.right.present === false ? `${text(component.left.label)}, removed` : `${text(component.left.label)} → ${text(component.right.label)}`}${component.surfaces.length ? ` · ${component.surfaces.join(", ")}` : ""}`,
    ),
    "",
  ];
  for (const error of model.errors)
    lines.push(
      `> **Not analyzed:** ${text(error.component)} ${text(error.side)} · ${text(error.operation)}: ${text(error.message)}`,
      "",
    );
  for (const finding of model.findings) {
    lines.push(
      `### ${ICON[finding.severity]} ${finding.id} · ${finding.severity.toUpperCase()} · ${text(finding.title)}${several ? ` · ${code(finding.component)}` : ""}`,
      "",
      text(finding.summary),
      "",
    );
    for (const item of finding.evidence)
      lines.push(`- _${item.basis}_ · ${text(item.claim)}${location(item)}`);
    for (const unknown of finding.unknowns)
      lines.push(`- _not established_ · ${text(unknown)}`);
    lines.push("", `**Next step:** ${text(finding.recommendation)}`, "");
  }
  lines.push(...limitLines(model));
  const seconds = (model.run.elapsed_ms / 1000).toFixed(1);
  lines.push(
    `<sub>${model.run.rea_calls.length} REA calls · ${seconds} s · ${model.run.llm_tokens} LLM tokens · complete Evidence in \`evidence/\`</sub>`,
    "",
  );
  return lines.join("\n");
};
