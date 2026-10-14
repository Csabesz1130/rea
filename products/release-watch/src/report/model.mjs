// Serializable report model and inventory tables derived from a comparison.

const statusRows = (items, describe) =>
  items.map((item) => ({
    status: item.status,
    ...describe(item.right[0] ?? item.left[0]),
  }));

/** Tables of everything that changed, for the inventory section. */
export const inventory = (report) => {
  const app = report.diff.app;
  return {
    fuses: report.right.runtime?.fuses
      ? Object.keys(report.right.runtime.fuses.fuses).map((name) => {
          const before = report.left.runtime?.fuses?.fuses[name] ?? "unknown";
          const after = report.right.runtime.fuses.fuses[name];
          return { name, before, after, changed: before !== after };
        })
      : [],
    bridge: statusRows(app.bridgeMembers, (fact) => ({
      member: fact.data.member,
      channel: fact.data.channel,
    })),
    requests: statusRows(app.requests, (fact) => ({
      module: fact.data.module,
      method: fact.data.method,
      endpoint: fact.data.endpoint,
    })),
    urls: statusRows(app.urlLiterals, (fact) => ({
      url: fact.data.url,
      module: fact.data.module,
    })),
    processes: statusRows(app.childProcesses, (fact) => ({
      module: fact.data.module,
      method: fact.data.method,
    })),
    files: statusRows(app.assets, (fact) => ({ path: fact.key })).filter(
      (row) => row.status !== "unchanged",
    ),
    helpers: report.diff.helpers.map((helper) => ({
      relative: helper.relative,
      identified:
        helper.after?.identified ?? helper.before?.identified ?? "unidentified",
      go_version: helper.after?.go?.go_version ?? null,
      dependencies: (helper.go?.dependencies ?? []).map((item) => ({
        status: item.status,
        ...(item.right[0] ?? item.left[0]).data,
      })),
      settings: helper.go?.settings ?? [],
    })),
  };
};

const appSummary = (side) =>
  side.app === null
    ? null
    : {
        evidence_id: side.app.evidence_id,
        evidence_file: side.appEvidenceFile,
        root_sha256: side.app.root_sha256,
        format: side.app.format,
        coverage: side.app.coverage,
      };

const sideSummary = (side) => ({
  label: side.label,
  input: side.input,
  package: side.package,
  application: appSummary(side),
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
});

/** The machine-readable report written to report.json. */
export const reportJson = (report) => ({
  tool: report.tool,
  generated_at: report.generated_at,
  product: report.product,
  verdict: report.verdict,
  left: sideSummary(report.left),
  right: sideSummary(report.right),
  rea_comparison: report.comparison,
  findings: report.findings,
  inventory: inventory(report),
  coverage: {
    left: report.left.app?.coverage ?? null,
    right: report.right.app?.coverage ?? null,
  },
  errors: report.errors,
  run: report.run,
});
