// Serializable report model and per-component inventory sections. Sections
// render only for the surfaces a component has, and never carry literal
// values beyond URLs (with query values removed) and prompt previews.
import {
  SECURITY_HEADERS,
  aiProviderOf,
  isAiEnvironmentKey,
  packageNameOf,
  sdkOf,
} from "../catalog.mjs";
import { displayUrl } from "../rules/shared.mjs";

const STATUS = {
  added: "added",
  removed: "removed",
  changed: "changed",
  unchanged: "unchanged",
  ambiguous: "ambiguous",
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

const electronSections = (component) => {
  const { left, right, diff } = component;
  const fuses = right.runtime?.fuses
    ? Object.keys(right.runtime.fuses.fuses).map((name) => {
        const before = left.runtime?.fuses?.fuses[name] ?? "unknown";
        const after = right.runtime.fuses.fuses[name];
        return [name, before, { text: after, flag: before !== after }];
      })
    : [];
  return [
    section(
      "fuses",
      "Electron fuses",
      ["Fuse", left.label, right.label],
      fuses,
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

const webSections = (component) => {
  const { diff } = component;
  return [
    section(
      "scripts",
      "Scripts in HTML",
      ["Script", "Resolution", "Status"],
      visible(diff.app.pageScripts).map((item) => [
        displayUrl(item.key),
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
      "embedded-sources",
      "Original sources in source maps",
      ["Original file", "Status"],
      visible(diff.app.embeddedSources).map((item) => [
        item.key,
        statusOf(item.status),
      ]),
    ),
  ];
};

const aiSections = (component) => {
  const { diff } = component;
  const sdks = new Map();
  for (const item of [
    ...visible(diff.app.imports),
    ...visible(diff.app.packages),
  ]) {
    const sdk = sdkOf(item.key);
    if (sdk === null) continue;
    const name = packageNameOf(item.key) ?? item.key;
    const row = sdks.get(name) ?? {
      name,
      label: sdk.label,
      where: new Set(),
      status: statusOf(item.status),
    };
    row.where.add(factOf(item).data.module ?? "installed");
    sdks.set(name, row);
  }
  const sdkRows = [...sdks.values()].map((row) => [
    row.name,
    row.label,
    [...row.where].join(", "),
    row.status,
  ]);
  const environment = diff.app.configReads
    .filter((item) => isAiEnvironmentKey(factOf(item).data.key))
    .map((item) => [
      factOf(item).data.key,
      factOf(item).data.module ?? "",
      statusOf(item.status),
    ]);
  const registrations = diff.app.memberCalls.map((item) => [
    factOf(item).data.module,
    `${factOf(item).data.member}()`,
    `${item.left.length} → ${item.right.length}`,
  ]);
  return [
    section(
      "ai-sdks",
      "AI and MCP SDKs",
      ["Package", "Kind", "Where", "Status"],
      sdkRows,
    ),
    noted(
      "Names only; values are never read.",
      section(
        "ai-environment",
        "AI settings read from the environment",
        ["Variable", "Module", "Status"],
        environment,
      ),
    ),
    noted(
      "REA does not report tool names; Release Watch counts registration calls.",
      section(
        "mcp-registrations",
        "MCP tool registrations",
        ["Module", "Call", "Count"],
        registrations,
      ),
    ),
  ];
};

const destinationRows = (component) => {
  const { network } = component;
  if (!network) return [];
  return [...network.current].map(([host, sources]) => {
    const kinds = [
      ...new Set(
        sources.map((source) =>
          source.kind === "capture" ? "runtime" : "code",
        ),
      ),
    ].join(" + ");
    return [
      host,
      aiProviderOf(host) ?? "",
      kinds,
      network.fresh.has(host) ? "new" : "known",
    ];
  });
};

const runtimeSections = (component) => {
  const capture = component.diff.capture;
  if (capture === null) return [];
  const headerRows = capture.documents
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) => {
      const before = item.left[0].data.headers;
      const after = item.right[0].data.headers;
      return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((name) => name in SECURITY_HEADERS)
        .filter((name) => before[name] !== after[name])
        .map((name) => [
          item.key,
          name,
          before[name] ?? "(not sent)",
          { text: after[name] ?? "(not sent)", flag: true },
        ]);
    });
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

const commonSections = (component) => {
  const { diff } = component;
  const dependencyRows = visible(diff.app.packages).map((item) => [
    item.key,
    item.left[0]?.data.version ?? "—",
    item.right[0]?.data.version ?? "—",
    statusOf(item.status),
  ]);
  const helperRows = diff.helpers.flatMap((helper) => [
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
      `${setting.before ?? "—"} → ${setting.after ?? "—"}`,
    ]),
  ]);
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
          statusOf(item.status),
        ]),
        ...visible(diff.app.childProcesses).map((item) => [
          `${factOf(item).data.method}() child process`,
          factOf(item).data.module,
          statusOf(item.status),
        ]),
      ],
    ),
    section(
      "dependencies",
      "Installed packages",
      ["Package", component.left.label, component.right.label, "Status"],
      dependencyRows,
    ),
    section(
      "helpers",
      "Helper binaries",
      ["Binary", "Item", "Status", "Detail"],
      helperRows,
    ),
    section(
      "files",
      "Files",
      ["Path", "Status"],
      visible(diff.app.assets).map((item) => [item.key, statusOf(item.status)]),
    ),
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

const sideSummary = (side) => ({
  label: side.label,
  input: side.target?.root ?? null,
  kind: side.target?.kind ?? null,
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
      }
    : null,
  runtime: side.runtime
    ? {
        name: side.runtime.name,
        sha256: side.runtime.fuses.sha256,
        evidence_id: side.runtime.fuses.evidence_id,
        evidence_file: side.runtime.file,
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

/** The machine-readable report written to report.json. */
export const reportJson = (report) => ({
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
    rea_comparison: component.comparison
      ? {
          evidence_id: component.comparison.evidence_id ?? null,
          summary: component.comparison.summary ?? null,
          evidence_file: component.comparison.file ?? null,
        }
      : null,
    module_aliases: [...component.aliases].map(([from, alias]) => ({
      from,
      to: alias.path,
      basis: alias.basis,
    })),
    inventory: componentSections(component),
  })),
  findings: report.findings,
  errors: report.errors,
  run: report.run,
});
