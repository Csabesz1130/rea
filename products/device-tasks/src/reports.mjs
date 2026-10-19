import { writeFile, rename } from "node:fs/promises";
import path from "node:path";

const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const markdown = (value) =>
  String(value)
    .replace(/[\\`*_{}[\]()#+.!|<>-]/gu, "\\$&")
    .replaceAll("\n", " ");

export async function writeReports(directory, report) {
  const json = JSON.stringify(report, null, 2);
  const errorMd = report.error
    ? `Failure: **${markdown(report.error.code)}** — ${markdown(report.error.message)}\n\n`
    : "";
  const errorHtml = report.error
    ? `<p><b>${escape(report.error.code)}</b> — ${escape(report.error.message)}</p>`
    : "";
  const md = `# REA Device Tasks — exploratory report\n\nStatus: **${report.status}**\n\n${errorMd}${markdown(report.goal)}\n\nSelected serial: ${markdown(report.selection.serial)}; package: ${markdown(report.selection.package ?? "not selected")}.\n\n## Observed and derived facts\n\n${report.facts.map((fact) => `- **${fact.confidence}**: ${markdown(fact.text)} (calls ${fact.calls.join(", ")}).`).join("\n") || "No facts established."}\n\n## Not established\n\n${report.unknowns.map((item) => `- ${markdown(item)}`).join("\n")}\n\n## Calls\n\n| Call | Operation | Status | Time (ms) | Evidence |\n| --- | --- | --- | --- | --- |\n${report.calls.map((call) => `| ${call.sequence} | ${call.operation} | ${call.status} | ${call.elapsed_ms ?? "pending"} | ${call.evidence_id ?? "none"} |`).join("\n")}\n\nComplete returned Evidence, error details, command arguments, timing and cleanup outcomes are in report.json; exact complete REA documents are in evidence/. Screenshots, if requested and available, are in screens/.\n`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>REA Device Tasks report</title><style>body{font:16px/1.5 system-ui;background:#f4f6fa;color:#172239;max-width:1100px;margin:40px auto;padding:0 20px}h1{letter-spacing:-1px}section,details{background:white;border:1px solid #dce2ec;border-radius:12px;padding:20px;margin:16px 0}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ddd;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}small{color:#526078}.status{font-weight:700}li{margin:8px 0}</style><h1>REA Device Tasks</h1><small>Exploratory product · local Evidence report</small><section><p class="status">${escape(report.status)}</p>${errorHtml}<p>${escape(report.goal)}</p><p>Device: <b>${escape(report.selection.serial)}</b> · Package: <b>${escape(report.selection.package ?? "not selected")}</b></p></section><section><h2>Observed and derived facts</h2><ul>${report.facts.map((f) => `<li><b>${escape(f.confidence)}</b> — ${escape(f.text)} <small>(calls ${f.calls.join(", ")})</small></li>`).join("") || "<li>No facts established.</li>"}</ul></section><section><h2>Not established</h2><ul>${report.unknowns.map((u) => `<li>${escape(u)}</li>`).join("")}</ul></section><section><h2>Calls</h2><table><tr><th>Call</th><th>Operation</th><th>Status</th><th>ms</th></tr>${report.calls.map((c) => `<tr><td>${c.sequence}</td><td>${escape(c.operation)}</td><td>${escape(c.status)}</td><td>${c.elapsed_ms ?? "pending"}</td></tr>`).join("")}</table></section><details><summary>Complete report and returned Evidence</summary><pre>${escape(json)}</pre></details></html>`;
  for (const [name, content] of [
    ["report.json", `${json}\n`],
    ["report.md", md],
    ["report.html", html],
  ]) {
    const file = path.join(directory, name);
    await writeFile(`${file}.tmp`, content);
    await rename(`${file}.tmp`, file);
  }
}
