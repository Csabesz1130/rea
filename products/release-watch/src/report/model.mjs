// The machine-readable report and its per-component inventory sections. The
// HTML and Markdown renderers read only this model, and the model passes
// through the redaction boundary once, so no renderer can print a value the
// model does not carry.
import { builtinModules } from "node:module";

import {
  aiProviderOf,
  isAiEnvironmentKey,
  packageNameOf,
  sdkOf,
} from "../catalog.mjs";
import { scrubDeep } from "../redact.mjs";
import { headerChanges } from "../rules/runtime.mjs";
import { sdkUses } from "../surfaces.mjs";
import { displayUrl } from "../urls.mjs";

const STATUS = {
  added: "added",
  removed: "removed",
  changed: "changed",
  unchanged: "unchanged",
  ambiguous: "ambiguous",
  increased: "more",
  "not-previously-observed": "new",
  "no-longer-observed": "gone",
};
const statusOf = (status) => STATUS[status] ?? status;
const visible = (items) => items.filter((item) => item.status !== "unchanged");
const factOf = (item) => item.right[0] ?? item.left[0];

const section = (id, title, headers, rows) => ({
  id,
  title,
  headers,
  rows,
  note: null,
});
const noted = (note, entry) => ({ ...entry, note });

const electronSections = ({ left, right, diff }) => {
  const before = left.runtime?.fuses?.fuses ?? {};
  const after = right.runtime?.fuses?.fuses ?? {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return [
    section(
      "fuses",
      "Electron fuses",
      ["Fuse", left.label, right.label],
      names.map((name) => [
        name,
        before[name] ?? "unknown",
        {
          text: after[name] ?? "unknown",
          flag: (before[name] ?? "unknown") !== (after[name] ?? "unknown"),
        },
      ]),
    ),
    section(
      "bridge",
      "Renderer APIs and IPC",
      ["API", "Channel", "Status"],
      diff.app.bridgeMembers.map((item) => [
        factOf(item).data.member,
        factOf(item).data.channel,
        statusOf(item.status),
      ]),
    ),
  ];
};

const scriptUrl = (script) =>
  displayUrl(script.startsWith("//") ? `https:${script}` : script);

const webSections = ({ diff }) => [
  section(
    "scripts",
    "Scripts in HTML",
    ["Script", "Resolution", "Status"],
    visible(diff.app.pageScripts).map((item) => [
      scriptUrl(item.key),
      factOf(item).data.resolution_status ?? "",
      statusOf(item.status),
    ]),
  ),
  section(
    "service-workers",
    "Service workers",
    ["Worker", "Status"],
    diff.app.serviceWorkers.map((item) => [item.key, statusOf(item.status)]),
  ),
  section(
    "storage",
    "Browser storage",
    ["Kind", "Name", "Status"],
    visible(diff.app.storage).map((item) => [
      factOf(item).data.storage_kind ?? "",
      factOf(item).data.name ?? "(dynamic)",
      statusOf(item.status),
    ]),
  ),
  section(
    "embedded-sources",
    "Original sources in source maps",
    ["Original file", "Status"],
    visible(diff.app.embeddedSources).map((item) => [
      item.key,
      statusOf(item.status),
    ]),
  ),
];

const sdkRows = (component) => {
  const before = sdkUses(component.left.app);
  const after = sdkUses(component.right.app);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((name) => {
      const use = after.get(name) ?? before.get(name);
      const where = [
        ...new Set(use.facts.map((fact) => fact.data.module ?? "installed")),
      ];
      const status = !before.has(name)
        ? "new"
        : !after.has(name)
          ? "gone"
          : "unchanged";
      return [name, use.sdk.label, where.join(", "), status];
    });
};

const aiSections = (component) => {
  const { diff } = component;
  return [
    section(
      "ai-sdks",
      "AI and MCP SDKs",
      ["Package", "Kind", "Where", "Status"],
      sdkRows(component),
    ),
    noted(
      "Names only; values are never read.",
      section(
        "ai-environment",
        "AI settings read from the environment",
        ["Variable", "Module", "Status"],
        diff.app.configReads
          .filter((item) => isAiEnvironmentKey(factOf(item).data.key))
          .map((item) => [
            factOf(item).data.key,
            factOf(item).data.module ?? "",
            statusOf(item.status),
          ]),
      ),
    ),
    noted(
      "REA does not report tool names; Release Watch counts registration calls.",
      section(
        "mcp-registrations",
        "MCP tool registrations",
        ["Module", "Call", "Count"],
        diff.app.memberCalls.map((item) => [
          factOf(item).data.module,
          `${factOf(item).data.member}()`,
          `${item.left.length} → ${item.right.length}`,
        ]),
      ),
    ),
  ];
};

const destinationRows = ({ network }) =>
  network
    ? [...network.current].map(([host, sources]) => [
        host,
        aiProviderOf(host) ?? "",
        [
          ...new Set(
            sources.map((source) =>
              source.kind === "capture" ? "runtime" : "code",
            ),
          ),
        ].join(" + "),
        network.fresh.has(host) ? "new" : "known",
      ])
    : [];

const runtimeSections = (component) => {
  const capture = component.diff.capture;
  if (capture === null) return [];
  // The rule's own reading of which headers regressed.
  const headerRows = capture.documents
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) =>
      headerChanges(item.left[0].data.headers, item.right[0].data.headers).map(
        (change) => [
          item.key,
          change.name,
          change.was,
          { text: change.now ?? "(not sent)", flag: true },
        ],
      ),
    );
  return [
    noted(
      "Grouped by REA's api-surface view; a capture shows one session.",
      section(
        "api-groups",
        "API endpoints seen at runtime",
        ["Endpoint", "Status"],
        visible(capture.apiGroups).map((item) => [
          item.key,
          statusOf(item.status),
        ]),
      ),
    ),
    section(
      "headers",
      "Security headers that changed",
      ["Page", "Header", component.left.label, component.right.label],
      headerRows,
    ),
    section(
      "cookies",
      "Cookies",
      ["Cookie", "Set by", "HttpOnly", "Secure", "SameSite", "Status"],
      visible(capture.cookies).map((item) => {
        const fact = factOf(item).data;
        return [
          fact.name,
          fact.host,
          String(fact.http_only),
          String(fact.secure),
          fact.same_site ?? "unset",
          statusOf(item.status),
        ];
      }),
    ),
  ];
};

const BUILTINS = new Set(builtinModules);

// Imports grouped by package; AI SDKs have their own table.
const importRows = ({ diff }) => {
  const rows = new Map();
  for (const item of visible(diff.app.imports)) {
    const name = packageNameOf(item.key);
    if (
      name === null ||
      item.key.startsWith("node:") ||
      BUILTINS.has(name) ||
      sdkOf(item.key) !== null
    )
      continue;
    const row = rows.get(name) ?? { modules: new Set(), statuses: new Set() };
    row.modules.add(factOf(item).data.module);
    row.statuses.add(statusOf(item.status));
    rows.set(name, row);
  }
  return [...rows].map(([name, row]) => [
    name,
    [...row.modules].join(", "),
    [...row.statuses].join(", "),
  ]);
};

const helperRows = ({ diff }) =>
  diff.helpers.flatMap((helper) => [
    ...(helper.before === null && helper.after !== null
      ? [[helper.relative, "executable", "new", helper.after.identified]]
      : []),
    ...(helper.after === null && helper.before !== null
      ? [[helper.relative, "executable", "gone", ""]]
      : []),
    ...(helper.go?.dependencies ?? [])
      .filter((item) => item.status !== "unchanged")
      .map((item) => [
        helper.relative,
        `${factOf(item).data.path} ${factOf(item).data.version}`,
        statusOf(item.status),
        factOf(item).data.sum ?? "no checksum",
      ]),
    ...(helper.go?.settings ?? []).map((setting) => [
      helper.relative,
      setting.key,
      "changed",
      setting.key === "-ldflags"
        ? "linker flags changed; see findings"
        : `${setting.before ?? "—"} → ${setting.after ?? "—"}`,
    ]),
  ]);

// Assets with REA- or name-paired renames shown once, as "renamed".
const fileRows = ({ diff, aliases }) => {
  const renamedTo = new Map(
    [...aliases].map(([from, alias]) => [alias.path, from]),
  );
  const renamedFrom = new Set(aliases.keys());
  return visible(diff.app.assets).flatMap((item) => {
    if (renamedFrom.has(item.key) && item.right.length === 0) return [];
    if (renamedTo.has(item.key) && item.left.length === 0)
      return [[`${renamedTo.get(item.key)} → ${item.key}`, "renamed"]];
    return [[item.key, statusOf(item.status)]];
  });
};

const commonSections = (component) => {
  const { diff } = component;
  return [
    section(
      "destinations",
      "Network destinations",
      ["Host", "AI provider", "Seen in", "Status"],
      destinationRows(component),
    ),
    section(
      "calls",
      "Requests and processes",
      ["Call", "Module", "Status"],
      [
        ...visible(diff.app.requests).map((item) => [
          `${factOf(item).data.method}()`,
          factOf(item).data.module,
          `${statusOf(item.status)}${item.status === "increased" ? ` (${item.left.length} → ${item.right.length})` : ""}`,
        ]),
        ...visible(diff.app.childProcesses).map((item) => [
          `${factOf(item).data.method}() child process`,
          factOf(item).data.module,
          `${statusOf(item.status)}${item.status === "increased" ? ` (${item.left.length} → ${item.right.length})` : ""}`,
        ]),
      ],
    ),
    section(
      "imports",
      "Imported packages",
      ["Package", "Imported by", "Status"],
      importRows(component),
    ),
    section(
      "dependencies",
      "Installed packages",
      ["Package", component.left.label, component.right.label, "Status"],
      visible(diff.app.packages).map((item) => [
        item.key,
        item.left[0]?.data.version ?? "—",
        item.right[0]?.data.version ?? "—",
        statusOf(item.status),
      ]),
    ),
    section(
      "helpers",
      "Helper binaries",
      ["Binary", "Item", "Status", "Detail"],
      helperRows(component),
    ),
    section("files", "Files", ["Path", "Status"], fileRows(component)),
  ];
};

/** Inventory sections for one component, empty ones removed. */
export const componentSections = (component) => {
  const surfaces = new Set(component.surfaces);
  return [
    ...(surfaces.has("electron") ? electronSections(component) : []),
    ...(surfaces.has("web") ? webSections(component) : []),
    ...(surfaces.has("ai") || surfaces.has("mcp") ? aiSections(component) : []),
    ...runtimeSections(component),
    ...commonSections(component),
  ].filter((entry) => entry.rows.length > 0);
};

// What Release Watch itself never examines; true of every run.
const RELEASE_WATCH_LIMITS = [
  "Release Watch compares REA facts. It does not execute either release during comparison; captures come from a browser session recorded separately.",
  '"New" means REA saw it only in the new release; REA\'s coverage of the old release does not prove it was absent.',
  "Rules recognise known patterns. A pass means no rule matched in the examined code, not that the release is safe.",
];

const COMPARISON_NOTES = {
  disabled:
    "REA module pairing was turned off (--rea-compare never); renamed modules are paired by name only.",
  "no-renames": null,
  size: "REA module pairing was skipped because the Evidence is larger than 64 MB; renamed modules are paired by name only.",
};

// Specific gaps in what REA examined on one side, then REA's standing
// limitations for the operations that ran.
const sideCoverage = (side) => {
  const gaps = [];
  const limitations = [];
  const app = side.app;
  if (app) {
    const { coverage } = app;
    if (coverage.graph !== "complete")
      gaps.push(`Application graph coverage: ${coverage.graph}.`);
    if (coverage.semantic === "unavailable")
      gaps.push(
        "No semantic graph: requests, processes and literals were not examined.",
      );
    if (coverage.semantic_truncated)
      gaps.push(
        `Semantic graph truncated${coverage.semantic_limits.length ? ` (limits: ${coverage.semantic_limits.join(", ")})` : ""}.`,
      );
    if (coverage.semantic_ceiling_modules.length > 0)
      gaps.push(
        `Files at the per-file node ceiling: ${coverage.semantic_ceiling_modules.join(", ")}.`,
      );
    if (app.analysisFailures.length > 0)
      gaps.push(
        `REA could not analyze ${app.analysisFailures.length} file(s).`,
      );
    limitations.push(...app.limitations);
  }
  if (side.runtime?.fuses?.ambiguous)
    gaps.push(
      `${side.runtime.name}: several fuse wires, so no fuse state is established.`,
    );
  for (const helper of side.helpers)
    if (helper.identified !== "go")
      gaps.push(
        `${helper.relative}: no Go build information (${helper.identified}).`,
      );
  if (side.capture) limitations.push(...side.capture.limitations);
  if (side.runtime?.fuses) limitations.push(...side.runtime.fuses.limitations);
  return { gaps: [...new Set(gaps)], limitations: [...new Set(limitations)] };
};

const coverageOf = (component) => ({
  left: sideCoverage(component.left),
  right: sideCoverage(component.right),
  comparison: component.comparison?.error
    ? `REA module pairing failed: ${component.comparison.error.message}`
    : (COMPARISON_NOTES[component.comparison?.skipped] ?? null),
  rea_comparison_limitations: component.comparison?.limitations ?? [],
});

const sideSummary = (side) => ({
  label: side.label,
  input: side.target?.root ?? null,
  kind: side.target?.kind ?? "missing",
  package: side.app?.package ?? null,
  surfaces: side.surfaces,
  application: side.app
    ? {
        evidence_id: side.app.evidence_id,
        evidence_file: side.appEvidence,
        root_sha256: side.app.root_sha256,
        format: side.app.format,
        coverage: side.app.coverage,
        inline_scripts: side.app.inlineScripts,
        analysis_failures: side.app.analysisFailures.length,
      }
    : null,
  runtime: side.runtime
    ? {
        name: side.runtime.name,
        sha256: side.runtime.fuses.sha256,
        evidence_id: side.runtime.fuses.evidence_id,
        evidence_file: side.runtime.file,
        ambiguous: side.runtime.fuses.ambiguous,
        fuses: side.runtime.fuses.fuses,
      }
    : null,
  helpers: side.helpers.map((helper) => ({
    relative: helper.relative,
    identified: helper.identified,
    sha256: helper.go?.sha256 ?? null,
    evidence_id: helper.go?.evidence_id ?? null,
    evidence_file: helper.file,
  })),
  capture: side.capture
    ? {
        name: side.capture.name,
        sha256: side.capture.sha256,
        evidence_id: side.capture.evidence_id,
        evidence_file: side.capture.file,
        records: side.capture.total_records,
      }
    : null,
});

/** The machine-readable report written to report.json, after redaction. */
export const reportJson = (report) =>
  scrubDeep({
    tool: report.tool,
    generated_at: report.generated_at,
    product: report.product,
    labels: report.labels,
    verdict: report.verdict,
    components: report.components.map((component) => ({
      name: component.name,
      surfaces: component.surfaces,
      left: sideSummary(component.left),
      right: sideSummary(component.right),
      rea_comparison: component.comparison?.evidence_id
        ? {
            evidence_id: component.comparison.evidence_id,
            summary: component.comparison.summary ?? null,
            evidence_file: component.comparison.file ?? null,
          }
        : null,
      module_aliases: [...component.aliases].map(([from, alias]) => ({
        from,
        to: alias.path,
        basis: alias.basis,
      })),
      coverage: coverageOf(component),
      inventory: componentSections(component),
    })),
    limitations: RELEASE_WATCH_LIMITS,
    findings: report.findings,
    errors: report.errors,
    run: report.run,
  });
