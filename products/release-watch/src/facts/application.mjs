// Projects `analyze_javascript_application` Evidence into the capability
// facts Release Watch compares. This module never reads application source.
import { HTML_SINKS } from "../catalog.mjs";
import { isUrl, scriptKey } from "../urls.mjs";
import { callGraph } from "./calls.mjs";
import { coverageOf, unreachedModules } from "./coverage.mjs";
import { comparableExpression } from "./expression.mjs";
import { browserModules, importIndex } from "./modules.mjs";
import { processUnknowns } from "./process.mjs";
import { definedProperties } from "./properties.mjs";
import { withLoads } from "./windows.mjs";
import {
  firstObservation,
  graphFact,
  observationFact,
  semanticFact,
} from "./provenance.mjs";

// Property reads Release Watch pairs with their calls: MCP tool registrations,
// by the last name of REA's read path (`server.experimental.tasks.registerToolTask`).
// The low-level MCP Server API dispatches tools through setRequestHandler.
const TRACKED_MEMBERS = new Set([
  "registerTool",
  "registerToolTask",
  "tool",
  "setRequestHandler",
]);
const trackedMember = (label) => {
  const member = /^read:\/(?:.+\/)?([^/]+)$/.exec(label)?.[1] ?? null;
  return TRACKED_MEMBERS.has(member) ? member : null;
};

// What REA did not resolve keeps its text for display, with the form it is
// compared in (expression.mjs).
const unresolved = (source, expression) => ({
  source,
  expression,
  compared: comparableExpression(expression),
});

const webPreferenceValue = (entry) => {
  if (entry.value?.status === "literal")
    return { known: true, value: entry.value.value };
  const expression = entry.value?.expression ?? null;
  return {
    known: false,
    value: expression,
    compared: comparableExpression(expression),
  };
};

// REA names a webPreferences spread or computed key by its source offset.
const UNNAMED_ENTRY = /^\[(spread|dynamic)@-?\d+\]$/;
const STATIC_STATUSES = new Set(["object-literal", "missing"]);

/**
 * A window's options as REA reports them: the webPreferences it names, and
 * what it did not resolve that may set any of them (an options object or
 * webPreferences value REA reports as dynamic, a spread, a computed key).
 * REA does not read an omitted option as Electron's default
 * (`absence_means_default` is false); the rules label that default as
 * Release Watch's, and only for a window with nothing unresolved. Values
 * REA did not resolve carry `compared`, the form the rules compare them in.
 */
const windowOptions = (properties) => {
  const entries = properties.web_preferences ?? [];
  const named = entries.filter((entry) => !UNNAMED_ENTRY.test(entry.name));
  const whole = !STATIC_STATUSES.has(properties.options_status)
    ? [unresolved("options", null)]
    : !STATIC_STATUSES.has(properties.web_preferences_status)
      ? [unresolved("webPreferences", null)]
      : [];
  const unnamed = entries
    .map((entry) => [UNNAMED_ENTRY.exec(entry.name)?.[1], entry])
    .filter(([kind]) => kind)
    .map(([kind, entry]) =>
      unresolved(
        kind === "spread" ? "spread" : "computed key",
        entry.value?.expression ?? null,
      ),
    );
  return {
    web_preferences: Object.fromEntries(
      named.map((entry) => [entry.name, webPreferenceValue(entry)]),
    ),
    unresolved_preferences: [...whole, ...unnamed],
  };
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
    facts.windows.push(
      graphFact(node, properties.source_path ?? node.node_id, {
        source_path: properties.source_path ?? null,
        ...windowOptions(properties),
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
    if (properties.operation === "parse-html-inline-scripts") {
      facts.inlineScripts += properties.inline_script_count ?? 0;
      // REA does not analyze inline script bodies: those pages hold unexamined code.
      if (properties.path && (properties.inline_script_count ?? 0) > 0)
        facts.inlineScriptFiles.push(properties.path);
    }
    const failure = properties.analysis_failure;
    if (failure)
      facts.analysisFailures.push(
        graphFact(node, `failure:${node.node_id}`, {
          code: failure.code ?? null,
          message: failure.message ?? null,
        }),
      );
    // A file REA could not parse is unexamined like a failed analysis.
    if (properties.operation === "parse-javascript" && properties.path) {
      const fact = graphFact(node, `failure:${node.node_id}`, {
        code: "parse-failed",
        message: properties.limitation ?? null,
      });
      facts.analysisFailures.push({
        ...fact,
        location: fact.location ?? {
          file: properties.path,
          line: null,
          column: null,
        },
      });
    }
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
    inlineScriptFiles: [],
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
        function: node.function_node_id ?? null,
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
    const property = scope.definedProperty.get(node.node_id) ?? null;
    const data = {
      module: modulePath,
      value,
      binding,
      property,
      range: rangeOf(node),
    };
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
    if (trackedMember(label)) scope.trackedReads.push(node);
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
        binding_range: rangeOf(source),
        binding_owner: source.function_node_id ?? null,
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
        member: trackedMember(read.label),
        range: rangeOf(call),
      }),
    );
  }
};

// Dynamic evaluation REA reports as an unknown scope (eval, new Function).
const dynamicEvaluation = (semantic, contexts) =>
  (semantic.unknowns ?? []).flatMap((unknown) => {
    const location = unknown.evidence?.location?.value;
    if (unknown.reason !== "dynamic-scope" || location?.kind !== "source-range")
      return [];
    return [
      semanticFact(
        { ...unknown, node_id: unknown.unknown_id },
        contexts,
        `${location.source}#eval`,
        { module: location.source, detail: unknown.detail ?? null },
      ),
    ];
  });

const semanticFacts = (semantic, modules) => {
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
    processUnknowns: [],
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
    definedProperty: definedProperties(semantic),
    fact,
    trackedReads: [],
    callSites: [],
  };
  for (const node of semantic.nodes)
    SEMANTIC_PROJECTIONS[node.kind]?.(node, scope);
  memberCalls(scope);
  facts.dynamicEvaluation = dynamicEvaluation(semantic, contexts);
  facts.processUnknowns = processUnknowns(semantic, contexts, {
    modules,
    childProcesses: facts.childProcesses,
    bindingReads: facts.bindingReads,
  });
  return facts;
};

// The bundle each source-map original belongs to: the asset whose source map
// (asset —maps_to→ source map —contains→ original) lists it.
const withBundles = (sources, graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const mapOwner = new Map();
  for (const edge of graph.edges)
    if (
      edge.relation === "maps_to" &&
      byId.get(edge.source_node_id)?.kind === "javascript-asset" &&
      byId.get(edge.target_node_id)?.kind === "source-map"
    )
      mapOwner.set(
        edge.target_node_id,
        firstObservation(byId.get(edge.source_node_id))?.properties?.path ??
          null,
      );
  const bundle = new Map();
  for (const edge of graph.edges)
    if (edge.relation === "contains" && mapOwner.has(edge.source_node_id))
      bundle.set(edge.target_node_id, mapOwner.get(edge.source_node_id));
  return sources.map((fact) => ({
    ...fact,
    data: { ...fact.data, bundle: bundle.get(fact.node_id) ?? null },
  }));
};

/** Capability facts from one `analyze_javascript_application` Evidence record. */
export const applicationFacts = (evidence) => {
  const result = evidence.normalized_result;
  const graph = result.graph;
  const semantic = result.semantic_graph ?? null;
  const { modules, imports } = importIndex(graph);
  const graphPart = graphFacts(graph);
  const calls = callGraph(semantic);
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
    windows: withLoads(graphPart.windows, graph, semantic, calls.functions),
    embeddedSources: withBundles(graphPart.embeddedSources, graph),
    ...semanticFacts(semantic, modules),
    ...calls,
  };
};
