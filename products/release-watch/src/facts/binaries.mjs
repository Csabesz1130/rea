// Projects REA binary Evidence: Electron fuse wires and Go build information.

/** Fuse states from one `inspect_electron_fuses` Evidence record, or null without a fuse wire. */
export const fuseFacts = (evidence) => {
  const result = evidence.normalized_result;
  const sentinels = result.slices.flatMap((slice) => slice.sentinels);
  if (sentinels.length !== 1) return null;
  return {
    evidence_id: evidence.evidence_id,
    sha256: result.artifact?.sha256 ?? evidence.subject?.digest?.sha256 ?? null,
    sentinel_offset: sentinels[0].sentinel_offset,
    fuses: Object.fromEntries(
      sentinels[0].fuses
        .filter((fuse) => fuse.name !== null)
        .map((fuse) => [fuse.name, fuse.state]),
    ),
    implications: result.runtime_implications ?? [],
    limitations: result.limitations ?? [],
  };
};

/** Module and build facts from one `inspect_go_binary` Evidence record. */
export const goFacts = (evidence) => {
  const result = evidence.normalized_result;
  const info = result.build_info;
  const module = info?.module ?? null;
  return {
    evidence_id: evidence.evidence_id,
    sha256: result.artifact?.sha256 ?? null,
    go_version: info?.go_version ?? null,
    main: module?.main?.path ?? null,
    dependencies: (module?.dependencies ?? []).map((dependency) => ({
      path: dependency.path,
      version: dependency.version,
      sum: dependency.sum || null,
      replacement: dependency.replacement ?? null,
    })),
    settings: Object.fromEntries(
      (module?.settings ?? []).map((setting) => [setting.key, setting.value]),
    ),
  };
};
