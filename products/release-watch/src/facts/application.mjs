// Projects `analyze_javascript_application` Evidence into the capability
// facts Release Watch compares. This module never reads application source.
import { HTML_SINKS } from "../catalog.mjs";
import { isUrl, scriptKey } from "../urls.mjs";
import { callGraph } from "./calls.mjs";
import {
  edgeFact,
  firstObservation,
  graphFact,
  observationFact,
  semanticFact,
} from "./provenance.mjs";

// Property reads Release Watch pairs with their calls: MCP tool registrations.
// The low-level MCP Server API dispatches tools through setRequestHandler.
const TRACKED_READS = new Set([
  "read:/registerTool",
  "read:/tool",
  "read:/setRequestHandler",
]);

const webPreferenceValue = (entry) =>
  entry.value?.status === "literal"
    ? { known: true, value: entry.value.value }
    : { known: false, value: entry.value?.expression ?? null };

const modulePathOf = (node) => {
  const properties = firstObservation(node)?.properties ?? {};
  if (node.kind === "javascript-asset") return properties.path ?? null;
  if (node.identity?.namespace === "source-module")
    return properties.path ?? null;
  return null;
};

const externalSpecifierOf = (edge, target) => {
  const properties = firstObservation(target)?.properties ?? {};
  if (properties.resolution_status !== "external") return null;
  return (
    edge.properties?.specifier ??
    properties.specifier ??
    properties.declared_specifier ??
    null
  );
};

/**
 * Per-module import index: local modules each module imports, external
 * specifiers (Node built-ins and npm packages), and the local name each
 * import binds. Also returns one fact per external import edge.
 */
const importIndex = (graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const modules = new Map();
  const imports = [];
  const entry = (modulePath) => {
    if (!modules.has(modulePath))
      modules.set(modulePath, {
        externalImports: new Set(),
        local: new Set(),
        imported: new Map(),
      });
    return modules.get(modulePath);
  };
  for (const edge of graph.edges) {
    if (edge.relation !== "imports") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const sourcePath = source ? modulePathOf(source) : null;
    if (sourcePath === null || target === undefined) continue;
    const targetPath = modulePathOf(target);
    const localName = edge.properties?.local_name ?? null;
    if (targetPath !== null) {
      entry(sourcePath).local.add(targetPath);
      if (localName !== null)
        entry(sourcePath).imported.set(localName, targetPath);
      continue;
    }
    const specifier = externalSpecifierOf(edge, target);
    if (specifier === null || entry(sourcePath).externalImports.has(specifier))
      continue;
    entry(sourcePath).externalImports.add(specifier);
    imports.push(edgeFact(edge, specifier, { specifier, module: sourcePath }));
  }
  return { modules, imports };
};

/** Modules that run in a browser page: HTML-loaded scripts, service workers and everything they import. */
const browserModules = (graph, modules) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const roots = [];
  for (const edge of graph.edges) {
    if (edge.relation !== "loads") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const loader =
      source?.kind === "electron-renderer" || source?.kind === "service-worker";
    const targetPath = target ? modulePathOf(target) : null;
    if (loader && targetPath !== null) roots.push(targetPath);
  }
  const reached = new Set();
  const visit = (modulePath) => {
    if (reached.has(modulePath)) return;
    reached.add(modulePath);
    for (const next of modules.get(modulePath)?.local ?? []) visit(next);
  };
  roots.forEach(visit);
  return reached;
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
  package: (node, properties, facts) => {
    if (!properties.name) return;
    const data = {
      name: properties.name,
      version: properties.version ?? null,
      path: properties.path ?? null,
    };
    if (properties.path === "package.json") facts.package ??= data;
    else facts.packages.push(graphFact(node, properties.name, data));
  },
  endpoint: (node, _properties, facts) => {
    for (const observation of node.observations ?? []) {
      const properties = observation.properties ?? {};
      if (typeof properties.value !== "string") continue;
      facts.endpoints.push(
        observationFact(node, observation, properties.value, {
          value: properties.value,
          mechanism: properties.mechanism ?? null,
          candidate: properties.interpretation === "candidate",
        }),
      );
    }
  },
  // HTML documents reuse REA's renderer vocabulary; every observation is read
  // because the external script tags are not always first.
  "electron-renderer": (node, _properties, facts) => {
    for (const observation of node.observations ?? []) {
      const properties = observation.properties ?? {};
      if (
        properties.mechanism !== "html-script-reference" ||
        !properties.script_path
      )
        continue;
      // Keyed as the browser resolves the source, so whitespace or host
      // case alone is not a new script.
      facts.pageScripts.push(
        observationFact(node, observation, scriptKey(properties.script_path), {
          script_path: properties.script_path,
          resolution_status: properties.resolution_status ?? null,
        }),
      );
    }
  },
  "service-worker": (node, properties, facts) => {
    const specifier = properties.resolved_path ?? properties.declared_specifier;
    if (specifier)
      facts.serviceWorkers.push(
        graphFact(node, specifier, {
          specifier,
          resolution_status: properties.resolution_status ?? null,
        }),
      );
  },
  "source-module": (node, properties, facts) => {
    const original = firstObservation(node)?.label ?? null;
    if (properties.content_available === true && original !== null)
      facts.embeddedSources.push(
        graphFact(node, original, {
          original,
          content_sha256: properties.content_sha256 ?? null,
        }),
      );
  },
  storage: (node, properties, facts) => {
    facts.storage.push(
      graphFact(node, `${properties.storage_kind}:${properties.name ?? "?"}`, {
        storage_kind: properties.storage_kind ?? null,
        name: properties.name ?? null,
      }),
    );
  },
  unknown: (node, properties, facts) => {
    if (properties.operation === "parse-html-inline-scripts")
      facts.inlineScripts += properties.inline_script_count ?? 0;
    const failure = properties.analysis_failure;
    if (failure)
      facts.analysisFailures.push(
        graphFact(node, `failure:${node.node_id}`, {
          code: failure.code ?? null,
          message: failure.message ?? null,
        }),
      );
  },
};

const graphFacts = (graph) => {
  const facts = {
    assets: [],
    ipcHandlers: [],
    bridgeMembers: [],
    windows: [],
    packages: [],
    endpoints: [],
    pageScripts: [],
    serviceWorkers: [],
    embeddedSources: [],
    storage: [],
    inlineScripts: 0,
    analysisFailures: [],
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

const rangeOf = (node) => node.identity?.source_range ?? null;
const samePosition = (a, b) => a.line === b.line && a.column === b.column;

// One projection per REA semantic-graph node kind.
const SEMANTIC_PROJECTIONS = {
  request: (node, scope) =>
    scope.facts.requests.push(
      scope.fact(node, {
        endpoint: node.properties?.endpoint ?? null,
        range: rangeOf(node),
      }),
    ),
  "child-process": (node, scope) =>
    scope.facts.childProcesses.push(
      scope.fact(node, {
        command: node.properties?.command ?? null,
        range: rangeOf(node),
      }),
    ),
  timer: (node, scope) => scope.facts.timers.push(scope.fact(node, {})),
  "config-source": (node, scope) => {
    const key = node.properties?.key ?? null;
    if (key === null) return;
    const sourceKind = node.properties?.source_kind ?? null;
    scope.facts.configReads.push(
      semanticFact(node, scope.contexts, `${sourceKind}:${key}`, {
        key,
        source_kind: sourceKind,
        module: node.identity?.module_path ?? null,
      }),
    );
  },
  literal: (node, scope) => {
    const value = node.properties?.value;
    if (typeof value !== "string") return;
    const modulePath = node.identity?.module_path ?? null;
    const binding = scope.definedBinding.get(node.node_id) ?? null;
    const data = { module: modulePath, value, binding, range: rangeOf(node) };
    scope.facts.stringLiterals.push(
      semanticFact(
        node,
        scope.contexts,
        `${modulePath}#${binding ?? value}`,
        data,
      ),
    );
    if (isUrl(value))
      scope.facts.urlLiterals.push(
        semanticFact(node, scope.contexts, value, { ...data, url: value }),
      );
  },
  expression: (node, scope) => {
    const label = node.label ?? "";
    const range = rangeOf(node);
    if (range === null) return;
    const modulePath = node.identity?.module_path ?? null;
    if (HTML_SINKS.has(label))
      scope.facts.htmlSinks.push(
        semanticFact(node, scope.contexts, `${modulePath}#${label}`, {
          module: modulePath,
          sink: label,
          range,
        }),
      );
    if (TRACKED_READS.has(label)) scope.trackedReads.push(node);
  },
  "call-site": (node, scope) => {
    if (rangeOf(node) !== null) scope.callSites.push(node);
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
    if (!readsBinding || !rangeOf(target ?? {})) continue;
    const modulePath = source.identity?.module_path ?? null;
    facts.bindingReads.push(
      semanticFact(target, contexts, `${modulePath}#${source.label}`, {
        module: modulePath,
        name: source.label,
        range: rangeOf(target),
      }),
    );
  }
  return definedBinding;
};

/**
 * Pair each tracked property read (`server.registerTool`) with the call site
 * that starts at the same source position: the call it is the callee of.
 */
const memberCalls = (scope) => {
  for (const read of scope.trackedReads) {
    const start = rangeOf(read).start;
    const modulePath = read.identity?.module_path ?? null;
    const call = scope.callSites.find(
      (site) =>
        site.identity?.module_path === modulePath &&
        samePosition(rangeOf(site).start, start),
    );
    if (call === undefined) continue;
    scope.facts.memberCalls.push(
      semanticFact(call, scope.contexts, `${modulePath}#${read.label}`, {
        module: modulePath,
        member: read.label.replace(/^read:\//, ""),
        range: rangeOf(call),
      }),
    );
  }
};

const dynamicEvaluation = (semantic, contexts, facts) => {
  for (const unknown of semantic.unknowns ?? []) {
    if (unknown.reason !== "dynamic-scope") continue;
    const location = unknown.evidence?.location?.value;
    const modulePath =
      location?.kind === "source-range" ? location.source : null;
    if (modulePath === null) continue;
    facts.dynamicEvaluation.push(
      semanticFact(
        { ...unknown, node_id: unknown.unknown_id },
        contexts,
        `${modulePath}#eval`,
        {
          module: modulePath,
          detail: unknown.detail ?? null,
        },
      ),
    );
  }
};

const semanticFacts = (semantic) => {
  const facts = {
    requests: [],
    childProcesses: [],
    timers: [],
    configReads: [],
    stringLiterals: [],
    urlLiterals: [],
    bindingReads: [],
    htmlSinks: [],
    memberCalls: [],
    dynamicEvaluation: [],
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
  const scope = {
    facts,
    contexts,
    definedBinding,
    fact,
    trackedReads: [],
    callSites: [],
  };
  for (const node of semantic.nodes)
    SEMANTIC_PROJECTIONS[node.kind]?.(node, scope);
  memberCalls(scope);
  dynamicEvaluation(semantic, contexts, facts);
  return facts;
};

// Modules whose semantic node count reached REA's per-file ceiling: where a
// truncated graph dropped facts. Derived from REA's own limit and nodes.
const ceilingModules = (semantic) => {
  const ceiling = semantic?.coverage?.limits?.find(
    (limit) => limit.name === "semantic_graph_file_node_ceiling",
  )?.value;
  if (!semantic?.coverage?.truncated || !ceiling) return [];
  const counts = new Map();
  for (const node of semantic.nodes) {
    const modulePath = node.identity?.module_path;
    if (modulePath) counts.set(modulePath, (counts.get(modulePath) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= ceiling)
    .map(([modulePath]) => modulePath)
    .sort();
};

/** REA's coverage of both graphs, as Release Watch reports it. */
const coverageOf = (graph, semantic) => ({
  graph: graph.coverage?.status ?? "unknown",
  graph_truncated: graph.coverage?.truncated === true,
  graph_omitted: graph.coverage?.omitted_count ?? 0,
  semantic: semantic?.coverage?.status ?? "unavailable",
  semantic_truncated: semantic?.coverage?.truncated === true,
  semantic_omitted_nodes: semantic?.coverage?.omitted_nodes ?? null,
  semantic_limits: (semantic?.coverage?.limits ?? []).map(
    (limit) =>
      `${limit.name} ${limit.value}${limit.unit === "items" ? "" : ` ${limit.unit}`}`,
  ),
  semantic_ceiling_modules: ceilingModules(semantic),
});

// Script files with no semantic node at all when REA truncated the semantic
// graph: the global ceiling left them unexamined.
const unreachedModules = (semantic, assets) => {
  if (!semantic?.coverage?.truncated) return [];
  const reached = new Set(
    semantic.nodes.map((node) => node.identity?.module_path).filter(Boolean),
  );
  return assets
    .map((asset) => asset.key)
    .filter(
      (key) =>
        /\.(m?js|cjs|jsx|ts|mts|cts|tsx)$/.test(key) && !reached.has(key),
    )
    .sort();
};

/** Capability facts from one `analyze_javascript_application` Evidence record. */
export const applicationFacts = (evidence) => {
  const result = evidence.normalized_result;
  const graph = result.graph;
  const semantic = result.semantic_graph ?? null;
  const { modules, imports } = importIndex(graph);
  const graphPart = graphFacts(graph);
  return {
    evidence_id: evidence.evidence_id,
    root_sha256: result.root_artifact_sha256,
    format: result.format,
    coverage: {
      ...coverageOf(graph, semantic),
      semantic_unreached_modules: unreachedModules(semantic, graphPart.assets),
    },
    summary: result.summary ?? null,
    limitations: [
      ...(graph.limitations ?? []),
      ...(semantic?.limitations ?? []),
    ],
    modules,
    imports,
    browserModules: browserModules(graph, modules),
    ...graphPart,
    ...semanticFacts(semantic),
    ...callGraph(semantic),
  };
};
