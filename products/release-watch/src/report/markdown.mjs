// Short Markdown summary for CI logs and pull-request comments.

const ICON = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "🟦",
  info: "⬜",
};
const DECISION = { block: "BLOCK", review: "REVIEW", pass: "PASS" };

const location = (item) =>
  item.location?.file
    ? ` \`${item.location.file}${item.location.line ? `:${item.location.line}` : ""}\``
    : "";

/** Render the report model as Markdown. */
export const renderMarkdown = (model) => {
  const { verdict } = model;
  const lines = [
    `## Release Watch: ${model.product ?? "release"} ${model.left.label} → ${model.right.label}`,
    "",
    `**${DECISION[verdict.decision]}** · ${verdict.counts.critical} critical · ${verdict.counts.high} high · ${verdict.counts.medium} medium · ${verdict.counts.low} low`,
    "",
  ];
  for (const finding of model.findings) {
    lines.push(
      `### ${ICON[finding.severity]} ${finding.id} · ${finding.severity.toUpperCase()} · ${finding.title}`,
    );
    lines.push("", finding.summary, "");
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
