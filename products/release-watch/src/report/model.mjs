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
import { failedFiles } from "../facts/coverage.mjs";
import { localPath, localText, scrubDeep } from "../redact.mjs";
import { RELEASE_WATCH_LIMITS, coverageOf } from "./coverage.mjs";
import { displaySetting } from "../rules/go.mjs";
import { registrationItems } from "../rules/mcp-registrations.mjs";
import { headerChanges } from "../rules/runtime.mjs";
import { sdkUses } from "../surfaces.mjs";
import { displayScript } from "../urls.mjs";

const STATUS = {
  added: "added",
  removed: "removed",
  changed: "changed",
  unchanged: "unchanged",
  ambiguous: "ambiguous",
  increased: "more",
  "not-previously-observed": "new",
  "no-longer-observed": "gone",
  "not-compared": "not compared",
  kept: "unchanged file",
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

const fuseRows = ({ diff }) =>
  diff.runtimes.flatMap((pair) => {
    const before = pair.before?.fuses?.fuses ?? {};
    const after = pair.after?.fuses?.fuses ?? {};
    const prefix =
      diff.runtimes.length > 1 || !pair.matched
        ? `${pair.after?.name ?? pair.name}: `
        : "";
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].map(
      (name) => [
        `${prefix}${name}`,
        before[name] ?? "unknown",
        {
          text: after[name] ?? "unknown",
          flag: (before[name] ?? "unknown") !== (after[name] ?? "unknown"),
        },
      ],
    );
  });

const electronSections = (component) => {
  const { left, right, diff } = component;
  return [
    section(
      "fuses",
      "Electron fuses",
      ["Fuse", left.label, right.label],
      fuseRows(component),
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

const scriptUrl = (script) => displayScript(script);

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
        registrationItems(
          diff.app.memberCalls,
          component.left.app,
          component.right.app,
        ).map(({ item, before, after }) => [
          factOf(item).data.module,
          `${factOf(item).data.member}()`,
          // A file shipped unchanged had its calls before (diff.mjs "kept").
          `${before.length} → ${after.length}${item.status === "kept" ? ` (${statusOf(item.status)})` : ""}`,
        ]),
      ),
    ),
  ];
};

// After a failed old analysis nothing was compared, so no host is "new".
const destinationRows = ({ network, left }) =>
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
        left.target && !left.app
          ? "not compared"
          : network.fresh.has(host)
            ? "new"
            : "known",
      ])
    : [];

const runtimeSections = (component) => {
  const capture = component.diff.capture;
  if (capture === null) return [];
  // The rule's own reading of which headers regressed.
  const headerRows = capture.documents
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) =>
      headerChanges(
        item.left[0].data.headers,
        item.right.map((load) => load.data.headers),
      ).map((change) => [
        item.right[0].data.display_path ?? item.key,
        change.name,
        change.was,
        { text: change.now ?? "(not sent)", flag: true },
      ]),
    );
  return [
    noted(
      "Grouped by REA's api-surface view; a capture shows one session.",
      section(
        "api-groups",
        "API endpoints seen at runtime",
        ["Endpoint", "Status"],
        visible(capture.apiGroups).map((item) => [
          factOf(item).data.display ?? item.key,
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
      `${displaySetting(setting.key, setting.before)} → ${displaySetting(setting.key, setting.after)}`,
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

// Input paths and Evidence files are the caller's choices and are shown as
// given (scrubPath); error and coverage text names local files (localText).
const sideSummary = (side) => ({
  label: side.label,
  input: localPath(side.target?.root ?? null),
  kind: side.target?.kind ?? "missing",
  present: side.target !== null,
  package: side.app?.package ?? null,
  surfaces: side.surfaces,
  application: side.app
    ? {
        evidence_id: side.app.evidence_id,
        evidence_file: localPath(side.appEvidence),
        root_sha256: side.app.root_sha256,
        format: side.app.format,
        coverage: side.app.coverage,
        inline_scripts: side.app.inlineScripts,
        // The files REA could not analyze, null for a failure naming none.
        failed_files: failedFiles(side.app).map(({ file }) => file),
      }
    : null,
  runtimes: side.runtimes.map((runtime) => ({
    name: runtime.name,
    sha256: runtime.fuses.sha256,
    evidence_id: runtime.fuses.evidence_id,
    evidence_file: localPath(runtime.file),
    ambiguous: runtime.fuses.ambiguous,
    fuses: runtime.fuses.fuses,
  })),
  helpers: side.helpers.map((helper) => ({
    relative: localPath(helper.relative),
    identified: helper.identified,
    sha256: helper.go?.sha256 ?? null,
    evidence_id: helper.go?.evidence_id ?? null,
    evidence_file: localPath(helper.file),
  })),
  capture: side.capture
    ? {
        name: localPath(side.capture.name),
        sha256: side.capture.sha256,
        evidence_id: side.capture.evidence_id,
        evidence_file: localPath(side.capture.file),
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
      renamed: component.renamed ?? null,
      surfaces: component.surfaces,
      left: sideSummary(component.left),
      right: sideSummary(component.right),
      rea_comparison: component.comparison?.evidence_id
        ? {
            evidence_id: component.comparison.evidence_id,
            summary: component.comparison.summary ?? null,
            evidence_file: localPath(component.comparison.file ?? null),
          }
        : null,
      module_aliases: [...component.aliases].map(([from, alias]) => ({
        from,
        to: alias.path,
        basis: alias.basis,
      })),
      coverage: localText(coverageOf(component)),
      inventory: componentSections(component),
    })),
    limitations: RELEASE_WATCH_LIMITS,
    findings: report.findings,
    errors: report.errors.map((error) => ({
      ...error,
      message: localText(error.message),
    })),
    run: report.run,
  });
