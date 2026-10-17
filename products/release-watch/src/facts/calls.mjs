// The parts of REA's semantic graph that say which code can run which code:
// functions with their own ranges, the calls REA resolved within a module,
// every call site and argument (with its position), return sites, member
// reads (`shell.run`, with the expression REA's nodes place them on, or none
// for `this.run`) and property writes (`handlers.git = …`), declared bindings with
// the calls REA says initialize them and the assignments REA reports to
// them, parameter reads, class field keys, and the statement-level effects
// REA reports (event listener registrations, timers, promises whose result
// a statement discards). Functions carry the kind REA's identity gives
// them, bindings whether they are a function or class expression's own name.
// Ranges and node ids only; no source is read.
import { comesBefore, sameStart } from "../ranges.mjs";
import { membersOf } from "./members.mjs";

const rangeOf = (node) => node?.identity?.source_range ?? null;
const moduleOf = (node) => node?.identity?.module_path ?? null;
// REA labels the expression that wraps one call argument `argument N`.
const ARGUMENT = /^(?:spread )?argument (\d+)$/;

/**
 * The position of the call argument a node REA reports wraps (`argument
 * N`, `spread argument N`), or null for any other node.
 */
export const argumentPosition = (node) => {
  if (node?.kind !== "expression") return null;
  const found = ARGUMENT.exec(node.label ?? "");
  return found ? Number(found[1]) : null;
};
// REA's identity of a name an expression refers to: `reference:<n>:read:<name>`.
const REFERENCE = /^reference:\d+:read:(.+)$/;
const locationOf = (node) => {
  const range = rangeOf(node);
  return {
    file: moduleOf(node),
    line: range.start.line,
    column: range.start.column,
  };
};
const positioned = (semantic, keep) =>
  semantic.nodes.filter((node) => rangeOf(node) && keep(node));

// REA's identity keys name what a source range is: a function's role key
// is `callable:callable:<kind>:<start>:<end>`, kind function, class or
// method (a class or object method, named by its key), and a binding's is
// `binding:<scope>:binding:<name>`, its scope `scope:<kind>:<start>:<end>`.
// A named function expression's own name lives in `scope:block:<its
// span>:function-name`, a class expression's in its own `scope:class`.
const CALLABLE_KEY = /^callable:callable:(function|class|method):(\d+:\d+)$/;
const OWN_NAME_SCOPE =
  /^binding:scope:(?:block:(\d+:\d+):function-name|class:(\d+:\d+)):binding:[^:]*$/;
const callableOf = (node) => CALLABLE_KEY.exec(node?.identity?.role_key ?? "");

const functionsOf = (semantic) =>
  positioned(semantic, (node) => node.kind === "function").map((node) => ({
    id: node.node_id,
    module: moduleOf(node),
    name: node.properties?.name ?? null,
    range: rangeOf(node),
    kind: callableOf(node)?.[1] ?? null,
  }));

// True for the name a named function or class expression gives itself,
// which only that function sees: REA places it in the function's own scope.
const isOwnName = (node, byId) => {
  const scope = OWN_NAME_SCOPE.exec(node.identity?.role_key ?? "");
  const owner = callableOf(byId.get(node.function_node_id));
  return (
    scope !== null && owner !== null && (scope[1] ?? scope[2]) === owner[2]
  );
};

// Call sites REA resolved to functions of the same module.
const callsOf = (semantic, byId) => {
  const callees = new Map();
  for (const relation of semantic.relations) {
    if (relation.relation !== "calls") continue;
    if (byId.get(relation.target_node_id)?.kind !== "function") continue;
    const list = callees.get(relation.source_node_id) ?? [];
    list.push(relation.target_node_id);
    callees.set(relation.source_node_id, list);
  }
  return [...callees].flatMap(([id, targets]) => {
    const site = byId.get(id);
    return site?.kind === "call-site" && rangeOf(site)
      ? [
          {
            module: moduleOf(site),
            range: rangeOf(site),
            callees: targets,
          },
        ]
      : [];
  });
};

// Every call site, `new` expressions marked, with the function it runs in.
const callSitesOf = (semantic) =>
  positioned(semantic, (node) => node.kind === "call-site").map((node) => ({
    module: moduleOf(node),
    range: rangeOf(node),
    construct: node.label === "construct",
    owner: node.function_node_id ?? null,
  }));

const argumentsOf = (semantic) =>
  positioned(semantic, (node) => argumentPosition(node) !== null).map(
    (node) => ({
      module: moduleOf(node),
      range: rangeOf(node),
      position: argumentPosition(node),
    }),
  );

// The names REA reports an expression referring to that no binding or
// parameter of the source resolves: globals such as `Object`, and the key
// of a class field, which REA reports as such a reference of the class.
const unresolvedReferences = (semantic) => {
  const resolved = new Set(
    semantic.relations
      .filter((relation) => relation.relation === "reads")
      .map((relation) => relation.target_node_id),
  );
  return positioned(
    semantic,
    (node) =>
      node.kind === "expression" &&
      !resolved.has(node.node_id) &&
      REFERENCE.test(node.identity?.role_key ?? ""),
  ).map((node) => ({
    node,
    name: REFERENCE.exec(node.identity.role_key)[1],
  }));
};

const returnsOf = (semantic) =>
  positioned(semantic, (node) => node.kind === "return-site").map((node) => ({
    module: moduleOf(node),
    range: rangeOf(node),
    owner: node.function_node_id ?? null,
  }));

// The key of each class field (`run = async () => …`): a reference REA
// reports the class itself making that no binding resolves.
const fieldsOf = (references, byId) =>
  references
    .filter(
      ({ node }) =>
        callableOf(byId.get(node.function_node_id))?.[1] === "class",
    )
    .map(({ node, name }) => ({
      module: moduleOf(node),
      name,
      range: rangeOf(node),
      owner: node.function_node_id,
    }));

// The ranges of the nodes REA relates to each binding by a relation
// `keep` accepts, by binding node id.
const relatedTo = (semantic, byId, keep) => {
  const found = new Map();
  for (const relation of semantic.relations) {
    const source = byId.get(relation.source_node_id);
    const target = byId.get(relation.target_node_id);
    if (target?.kind !== "binding" || !rangeOf(source)) continue;
    if (!keep(relation.relation, source)) continue;
    const list = found.get(target.node_id) ?? [];
    list.push(rangeOf(source));
    found.set(target.node_id, list);
  }
  return found;
};

// A call REA says a binding holds the result of.
const initializes = (relation, source) =>
  relation === "aliases" && source.kind === "call-site";
// An assignment REA reports to a binding: a write, or an assignment
// expression that defines it (also a `for…of` binding's own declaration).
const assigns = (relation, source) =>
  relation === "writes" ||
  (relation === "defines" && source.label === "assignment");

// Where a binding is assigned after its declaration, once per position.
const assignmentsAfter = (range, ranges = []) =>
  ranges.filter(
    (candidate, at) =>
      !sameStart(candidate, range) &&
      ranges.findIndex((other) => sameStart(other, candidate)) === at,
  );

// The property slots REA projects from each binding's initializer
// (`writes-property` from the binding, then from each slot), with what REA
// says the slot holds: a literal, an object, an array, or unknown (a
// function, a call result), and whether REA saw all of a container's slots.
const slotsOf = (semantic, byId) => {
  const written = new Map();
  for (const relation of semantic.relations)
    if (relation.relation === "writes-property") {
      const list = written.get(relation.source_node_id) ?? [];
      list.push(relation.target_node_id);
      written.set(relation.source_node_id, list);
    }
  const slots = new Map();
  for (const [source, targets] of written) {
    if (byId.get(source)?.kind !== "binding") continue;
    const found = [];
    const queue = [...targets];
    for (let next = 0; next < queue.length; next += 1) {
      const slot = byId.get(queue[next]);
      if (slot?.kind !== "property-slot") continue;
      found.push({
        path: slot.properties?.property_path ?? [],
        value: slot.properties?.value_status ?? "unknown",
        complete: slot.properties?.value_coverage?.status === "complete",
      });
      queue.push(...(written.get(slot.node_id) ?? []));
    }
    slots.set(source, found);
  }
  return slots;
};

// Property writes (`handlers.git = …`, `handlers[name] = …`): REA's write
// occurrence, with the path below the object written, empty when REA could
// not resolve it.
const propertyWritesOf = (semantic) =>
  positioned(
    semantic,
    (node) =>
      node.kind === "expression" && node.properties?.operation_kind === "write",
  ).map((node) => ({
    module: moduleOf(node),
    range: rangeOf(node),
    path: node.properties.property_path ?? [],
  }));

// Bindings whose initializer container REA saw only in part: REA reports an
// unknown on the binding for the writes it could not place.
const partialContainers = (semantic) =>
  new Set(
    (semantic.unknowns ?? [])
      .filter(
        (unknown) =>
          unknown.family === "object-flow" &&
          (unknown.relation_kinds ?? []).includes("writes-property"),
      )
      .map((unknown) => unknown.node_id),
  );

const at = (module, range) =>
  `${module}\u0000${range.start.line}:${range.start.column}`;

// REA's reason for a binding whose value it could not project from what
// its pattern destructures because a key of the pattern is computed
// (`const { [key]: run } = TOOL`), for which it reports no destructure
// operation (projectValue in REA's javascriptSemanticValues.ts).
const DYNAMIC_PROJECTION = /^Cannot project a dynamic property\./;

// The bindings REA reports that unknown for.
const dynamicProjections = (semantic, byId) =>
  new Set(
    (semantic.unknowns ?? [])
      .filter(
        (unknown) =>
          unknown.family === "data-flow" &&
          unknown.reason === "unknown-value" &&
          byId.get(unknown.node_id)?.kind === "binding" &&
          DYNAMIC_PROJECTION.test(unknown.detail ?? ""),
      )
      .map((unknown) => unknown.node_id),
  );

// REA's destructuring of each binding (`const { handler } = TOOL`, `for
// (const [name, fn] of …)`), by where the binding starts: the property path
// of the destructure operation REA reports there (null when what it
// destructures reads a computed member, `= TOOLS[name]`), the range of that
// pattern element, the part of it after the binding (its default value,
// `handler = noop`, which the binding holds when the property is
// undefined; null without one), and the binding or parameter REA reports
// it destructured from, through one of that binding's property slots (null
// when REA names none: a `for…of` element, a call's result). REA's path is
// below the expression the destructured member chain starts at: that
// binding when REA names one (`= TOOL.inner` gives `inner/handler`), a
// call's result (`= Object.entries(H)[0]` gives `0/1`), or each element a
// `for…of` loop iterates. For a computed key REA reports no destructure
// operation but that it could not project the binding's value
// (`dynamicProjections`): the binding's path is null, `computedKey` set,
// and its element is the binding. REA reports neither for a rest element,
// a nested pattern with its own default, or a computed key in a `for…of`
// pattern.
const destructuringsOf = (semantic, byId) => {
  const named = new Map(
    semantic.nodes
      .filter((node) => node.kind === "binding" || node.kind === "parameter")
      .map((node) => [node.identity?.role_key, node]),
  );
  const sources = new Map();
  for (const relation of semantic.relations) {
    if (relation.relation !== "destructures") continue;
    const id = byId.get(relation.source_node_id)?.properties?.object_binding_id;
    const source = id ? named.get(`binding:${id}`) : undefined;
    if (rangeOf(source)) sources.set(relation.target_node_id, rangeOf(source));
  }
  const operations = new Map();
  for (const node of positioned(
    semantic,
    (candidate) =>
      candidate.kind === "expression" &&
      candidate.properties?.operation_kind === "destructure",
  ))
    operations.set(at(moduleOf(node), rangeOf(node)), {
      path: node.properties.property_path ?? null,
      range: rangeOf(node),
    });
  const projected = dynamicProjections(semantic, byId);
  return (node) => {
    const operation = operations.get(at(moduleOf(node), rangeOf(node)));
    const { end } = rangeOf(node);
    if (!operation)
      return projected.has(node.node_id)
        ? {
            path: null,
            range: rangeOf(node),
            defaultValue: null,
            source: null,
            computedKey: true,
          }
        : null;
    return {
      ...operation,
      defaultValue: comesBefore(end, operation.range.end)
        ? { start: end, end: operation.range.end }
        : null,
      source: sources.get(node.node_id) ?? null,
      computedKey: false,
    };
  };
};

// Declared bindings (not parameters), with their owning function, whether
// the binding is a function or class expression's own name, whether REA
// reports its declaration as an assignment (`iterated`: a `for…of` or
// `for…in` binding, which each iteration assigns), the calls REA says
// initialize them, the assignments REA reports after the declaration, the
// property slots REA projects from their initializer, and how REA reports
// them destructured (`destructuringsOf`, else null). `container` is null
// when REA projected none, and "partial" when REA saw only some of its
// writes or the binding is assigned again, so the slots may not be all it
// holds.
const bindingsOf = (semantic, byId) => {
  const initializers = relatedTo(semantic, byId, initializes);
  const assignments = relatedTo(semantic, byId, assigns);
  const slots = slotsOf(semantic, byId);
  const partial = partialContainers(semantic);
  const destructured = destructuringsOf(semantic, byId);
  return positioned(
    semantic,
    (node) => node.kind === "binding" && node.label,
  ).map((node) => {
    const id = node.node_id;
    const assigned = assignmentsAfter(rangeOf(node), assignments.get(id));
    const container = !slots.has(id)
      ? null
      : partial.has(id) || assigned.length > 0
        ? "partial"
        : "complete";
    return {
      module: moduleOf(node),
      name: node.label,
      range: rangeOf(node),
      owner: node.function_node_id ?? null,
      ownName: isOwnName(node, byId),
      iterated: (assignments.get(id) ?? []).some((range) =>
        sameStart(range, rangeOf(node)),
      ),
      initializers: initializers.get(id) ?? [],
      assignments: assigned,
      slots: slots.get(id) ?? [],
      container,
      destructured: destructured(node),
    };
  });
};

// Reads of parameters, shaped like REA binding reads.
const parameterReadsOf = (semantic, byId) =>
  semantic.relations.flatMap((relation) => {
    const source = byId.get(relation.source_node_id);
    const target = byId.get(relation.target_node_id);
    if (relation.relation !== "reads" || source?.kind !== "parameter")
      return [];
    if (!rangeOf(target) || !rangeOf(source)) return [];
    return [
      {
        location: locationOf(target),
        data: {
          module: moduleOf(source),
          name: source.label,
          range: rangeOf(target),
          binding_range: rangeOf(source),
          binding_owner: source.function_node_id ?? null,
          parameter: true,
        },
      },
    ];
  });

// Statements REA recognises: an event listener registration, a timer
// (`setInterval(…)`), and a promise whose expression statement discards it.
const markersOf = (semantic) =>
  positioned(
    semantic,
    (node) =>
      node.kind === "listener" ||
      node.kind === "timer" ||
      (node.kind === "promise" && node.properties?.ownership === "detached"),
  ).map((node) => ({
    module: moduleOf(node),
    range: rangeOf(node),
    owner: node.function_node_id ?? null,
  }));

const EMPTY = {
  functions: [],
  calls: [],
  callSites: [],
  arguments: [],
  returns: [],
  members: [],
  fields: [],
  propertyWrites: [],
  bindings: [],
  parameterReads: [],
  markers: [],
};

/**
 * `{ functions, calls, callSites, arguments, returns, members, fields,
 * propertyWrites, bindings, parameterReads, markers }` from one semantic
 * graph. Binding reads are projected with the other semantic facts, in
 * application.mjs.
 */
export const callGraph = (semantic) => {
  if (!semantic) return EMPTY;
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  const references = unresolvedReferences(semantic);
  return {
    functions: functionsOf(semantic),
    calls: callsOf(semantic, byId),
    callSites: callSitesOf(semantic),
    arguments: argumentsOf(semantic),
    returns: returnsOf(semantic),
    members: membersOf(semantic, references),
    fields: fieldsOf(references, byId),
    propertyWrites: propertyWritesOf(semantic),
    bindings: bindingsOf(semantic, byId),
    parameterReads: parameterReadsOf(semantic, byId),
    markers: markersOf(semantic),
  };
};
