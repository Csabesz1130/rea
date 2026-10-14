// Projects REA Evidence into the capability facts Release Watch compares.
// Every fact keeps REA's location, evidence state and artifact digest; this
// module never reads application source.

const URL_LITERAL = /^(https?|wss?):\/\/[^\s"'`]+$/i;

const firstObservation = (node) => node.observations?.[0] ?? null;

const locationOf = (evidence) => {
  const value = evidence?.location?.available ? evidence.location.value : null;
  if (value?.kind === "source-range")
    return {
      file: value.source,
      line: value.start?.line ?? null,
      column: value.start?.column ?? null,
    };
  if (value?.kind === "artifact-path")
    return { file: value.path, line: null, column: null };
  return null;
};

const provenance = (evidence) => ({
  location: locationOf(evidence),
  state: evidence?.state ?? "unknown",
  authority: evidence?.authority ?? "unknown",
  confidence: evidence?.confidence ?? "unknown",
  artifact_sha256: evidence?.artifact?.sha256 ?? null,
});

const graphFact = (node, key, data) => {
  const observation = firstObservation(node);
  return {
    key,
    label: observation?.label ?? key,
    node_id: node.node_id,
    ...provenance(observation?.evidence),
    data,
  };
};

const semanticFact = (node, contexts, key, data) => {
  const context = contexts.get(node.evidence?.context_id) ?? {};
  return {
    key,
    label: node.label ?? key,
    node_id: node.node_id,
    ...provenance({ ...context, location: node.evidence?.location }),
    data,
  };
};

const webPreferenceValue = (entry) =>
  entry.value?.status === "literal"
    ? { known: true, value: entry.value.value }
    : { known: false, value: entry.value?.expression ?? null };

const moduleIndex = (graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const pathOf = (node) => {
    const properties = firstObservation(node)?.properties ?? {};
    if (node.kind === "javascript-asset") return properties.path ?? null;
    if (node.identity?.namespace === "source-module")
      return properties.path ?? null;
    return null;
  };
  const modules = new Map();
  const entry = (modulePath) => {
    if (!modules.has(modulePath))
      modules.set(modulePath, {
        builtins: new Set(),
        local: new Set(),
        imported: new Map(),
      });
    return modules.get(modulePath);
  };
  for (const edge of graph.edges) {
    if (edge.relation !== "imports") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const sourcePath = source ? pathOf(source) : null;
    if (sourcePath === null || target === undefined) continue;
    const targetPath = pathOf(target);
    const properties = firstObservation(target)?.properties ?? {};
    const localName = edge.properties?.local_name ?? null;
    if (targetPath !== null && localName !== null)
      entry(sourcePath).imported.set(localName, targetPath);
    if (targetPath !== null) entry(sourcePath).local.add(targetPath);
    else if (
      properties.resolution_status === "external" &&
      properties.specifier
    )
      entry(sourcePath).builtins.add(properties.specifier);
  }
  return modules;
};

const assetFact = (node, properties, facts) => {
  if (properties.path)
    facts.assets.push(
      graphFact(node, properties.path, {
        sha256: node.identity?.sha256 ?? null,
      }),
    );
};

// One projection per REA application-graph node kind.
const GRAPH_PROJECTIONS = {
  "javascript-asset": assetFact,
  artifact: assetFact,
  "ipc-handler": (node, properties, facts) => {
    if (properties.side !== "main") return;
    facts.ipcHandlers.push(
      graphFact(node, properties.channel ?? node.node_id, {
        channel: properties.channel ?? null,
        mode: properties.mode ?? null,
        handler_range: properties.handler_location ?? null,
      }),
    );
  },
  "javascript-expression": (node, properties, facts) => {
    if (
      properties.entry_kind !== "bridge-member" ||
      properties.step_kind !== "exposure"
    )
      return;
    facts.bridgeMembers.push(
      graphFact(node, properties.entry, {
        member: properties.entry,
        channel: properties.channel ?? null,
        terminal: properties.terminal ?? null,
      }),
    );
  },
  "browser-window": (node, properties, facts) => {
    const preferences = (properties.web_preferences ?? []).map((entry) => [
      entry.name,
      webPreferenceValue(entry),
    ]);
    facts.windows.push(
      graphFact(node, properties.source_path ?? node.node_id, {
        source_path: properties.source_path ?? null,
        web_preferences: Object.fromEntries(preferences),
      }),
    );
  },
  package: (_node, properties, facts) => {
    facts.package ??= {
      name: properties.name ?? null,
      version: properties.version ?? null,
    };
  },
};

const graphFacts = (graph) => {
  const facts = {
    assets: [],
    ipcHandlers: [],
    bridgeMembers: [],
    windows: [],
    package: null,
  };
  for (const node of graph.nodes)
    GRAPH_PROJECTIONS[node.kind]?.(
      node,
      firstObservation(node)?.properties ?? {},
      facts,
    );
  return facts;
};

// One projection per REA semantic-graph node kind; `scope` carries the
// evidence contexts and the binding each literal defines.
const SEMANTIC_PROJECTIONS = {
  request: (node, scope) =>
    scope.facts.requests.push(
      scope.fact(node, { endpoint: node.properties?.endpoint ?? null }),
    ),
  "child-process": (node, scope) =>
    scope.facts.childProcesses.push(
      scope.fact(node, { command: node.properties?.command ?? null }),
    ),
  timer: (node, scope) => scope.facts.timers.push(scope.fact(node, {})),
  literal: (node, scope) => {
    const value = node.properties?.value;
    if (typeof value !== "string" || !URL_LITERAL.test(value)) return;
    const modulePath = node.identity?.module_path ?? null;
    scope.facts.urlLiterals.push(
      semanticFact(node, scope.contexts, `${modulePath}#${value}`, {
        module: modulePath,
        url: value,
        binding: scope.definedBinding.get(node.node_id) ?? null,
      }),
    );
  },
};

const bindingRelations = (semantic, facts, contexts) => {
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  const definedBinding = new Map();
  for (const relation of semantic.relations) {
    const source = byId.get(relation.source_node_id);
    const target = byId.get(relation.target_node_id);
    if (relation.relation === "defines" && target?.kind === "binding")
      definedBinding.set(relation.source_node_id, target.label ?? null);
    const readsBinding =
      relation.relation === "reads" && source?.kind === "binding";
    if (!readsBinding || !target?.identity?.source_range) continue;
    const modulePath = source.identity?.module_path ?? null;
    facts.bindingReads.push(
      semanticFact(target, contexts, `${modulePath}#${source.label}`, {
        module: modulePath,
        name: source.label,
        range: target.identity.source_range,
      }),
    );
  }
  return definedBinding;
};

const semanticFacts = (semantic) => {
  const facts = {
    requests: [],
    childProcesses: [],
    timers: [],
    urlLiterals: [],
    bindingReads: [],
  };
  if (!semantic) return facts;
  const contexts = new Map(
    semantic.evidence_contexts.map((context) => [context.context_id, context]),
  );
  const definedBinding = bindingRelations(semantic, facts, contexts);
  const fact = (node, extra) => {
    const modulePath = node.identity?.module_path ?? null;
    const method = node.properties?.method ?? null;
    return semanticFact(
      node,
      contexts,
      `${modulePath}#${method ?? node.label}`,
      {
        module: modulePath,
        method,
        ...extra,
      },
    );
  };
  const scope = { facts, contexts, definedBinding, fact };
  for (const node of semantic.nodes)
    SEMANTIC_PROJECTIONS[node.kind]?.(node, scope);
  return facts;
};

/** Capability facts from one `analyze_javascript_application` Evidence record. */
export const applicationFacts = (evidence) => {
  const result = evidence.normalized_result;
  const graph = result.graph;
  const semantic = result.semantic_graph ?? null;
  return {
    evidence_id: evidence.evidence_id,
    root_sha256: result.root_artifact_sha256,
    format: result.format,
    coverage: {
      graph: graph.coverage?.status ?? "unknown",
      semantic: semantic?.coverage?.status ?? "unavailable",
    },
    summary: result.summary ?? null,
    limitations: [
      ...(graph.limitations ?? []),
      ...(semantic?.limitations ?? []),
    ],
    modules: moduleIndex(graph),
    ...graphFacts(graph),
    ...semanticFacts(semantic),
  };
};

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
