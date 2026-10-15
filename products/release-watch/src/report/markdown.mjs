// Short Markdown summary for CI logs, tickets and pull-request comments.

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

const location = (item) => {
  const where = item.location;
  if (!where?.file) return "";
  const line = where.line ? `:${where.line}` : "";
  const record =
    where.record !== undefined && where.record !== null
      ? ` record ${where.record}`
      : "";
  return ` \`${where.file}${line}${record}\``;
};

/** Render the report model as Markdown. */
export const renderMarkdown = (model) => {
  const { verdict } = model;
  const several = model.components.length > 1;
  const lines = [
    `## Release Watch: ${model.product ?? "release"} ${model.labels.left} → ${model.labels.right}`,
    "",
    `**${DECISION[verdict.decision]}** · ${verdict.counts.critical} critical · ${verdict.counts.high} high · ${verdict.counts.medium} medium · ${verdict.counts.low} low`,
    "",
    ...model.components.map(
      (component) =>
        `- \`${component.name}\` ${component.left.label} → ${component.right.label}${component.surfaces.length ? ` · ${component.surfaces.join(", ")}` : ""}`,
    ),
    "",
  ];
  for (const error of model.errors)
    lines.push(
      `> **Not analyzed:** ${error.component} ${error.side} · ${error.operation}: ${error.message}`,
      "",
    );
  for (const finding of model.findings) {
    lines.push(
      `### ${ICON[finding.severity]} ${finding.id} · ${finding.severity.toUpperCase()} · ${finding.title}${several ? ` · \`${finding.component}\`` : ""}`,
      "",
      finding.summary,
      "",
    );
    for (const item of finding.evidence)
      lines.push(`- _${item.basis}_ · ${item.claim}${location(item)}`);
    for (const unknown of finding.unknowns)
      lines.push(`- _not established_ · ${unknown}`);
    lines.push("", `**Next step:** ${finding.recommendation}`, "");
  }
  const seconds = (model.run.elapsed_ms / 1000).toFixed(1);
  lines.push(
    `<sub>${model.run.rea_calls.length} REA calls · ${seconds} s · ${model.run.llm_tokens} LLM tokens · complete Evidence in \`evidence/\`</sub>`,
    "",
  );
  return lines.join("\n");
};
