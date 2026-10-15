// Projects REA binary Evidence: Electron fuse wires and Go build information.

/**
 * Fuse states from one `inspect_electron_fuses` Evidence record. Null when
 * the file has no fuse wire; `ambiguous` when it has several, which leaves
 * every fuse state unknown.
 */
export const fuseFacts = (evidence) => {
  const result = evidence.normalized_result;
  const sentinels = result.slices.flatMap((slice) => slice.sentinels);
  if (sentinels.length === 0) return null;
  if (sentinels.length > 1)
    return {
      evidence_id: evidence.evidence_id,
      sha256:
        result.artifact?.sha256 ?? evidence.subject?.digest?.sha256 ?? null,
      ambiguous: true,
      sentinel_count: sentinels.length,
      fuses: {},
      implications: [],
      limitations: result.limitations ?? [],
    };
  return {
    evidence_id: evidence.evidence_id,
    sha256: result.artifact?.sha256 ?? evidence.subject?.digest?.sha256 ?? null,
    ambiguous: false,
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

/** Module and build facts from one `inspect_go_binary` Evidence record, or null when REA found no Go build information. */
export const goFacts = (evidence) => {
  const result = evidence.normalized_result;
  const info = result.build_info;
  if (!info) return null;
  const module = info.module ?? null;
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
