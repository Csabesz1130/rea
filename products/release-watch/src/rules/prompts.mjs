// RW-A04: prose a variable or property of AI code holds, whose text
// changed. Text is new only when the old module held no string literal with
// that value under any name, since a minifier renames variables freely, and
// each value is tested on its own; a value REA's facts show is only an
// error or log message, or a bundled package.json value, is not taken as a
// prompt.
import {
  aiProviderOf,
  credentialOf,
  credentialsIn,
  isAiEnvironmentKey,
} from "../catalog.mjs";
import { comesBefore, sameRange, sameStart, within } from "../ranges.mjs";
import { textPreview } from "../source-line.mjs";
import { sdkUses } from "../surfaces.mjs";
import { hostOf, maskTag } from "../urls.mjs";
import { assignedName } from "./destinations.mjs";
import { indexOf, inside, memberOn, readsOfBinding } from "./reach-index.mjs";
import { APP_SOURCE, cite, heuristic } from "./shared.mjs";

// Modules that talk to AI models: they import an AI SDK, read a provider
// setting or hold a provider URL.
const aiModules = (app) => {
  const modules = new Set();
  for (const { sdk, facts } of sdkUses(app).values())
    if (sdk.kind === "ai")
      for (const fact of facts)
        if (fact.data.module) modules.add(fact.data.module);
  for (const read of app.configReads)
    if (isAiEnvironmentKey(read.data.key)) modules.add(read.data.module);
  for (const literal of app.urlLiterals)
    if (aiProviderOf(hostOf(literal.data.url)))
      modules.add(literal.data.module);
  // Prompts often live in a module the AI code imports (one step only).
  const direct = Array.from(modules);
  for (const module of direct)
    for (const local of app.modules.get(module)?.local ?? [])
      modules.add(local);
  return modules;
};

// Prose: several words, not a URL, not a markup document (an SVG icon, an
// XML or HTML page), no key-shaped token, and not an authorization value
// such as "Bearer <token>".
const isProse = (value) =>
  value.length >= 40 &&
  value.trim().split(/\s+/).length >= 5 &&
  !/^[a-z]+:\/\//i.test(value) &&
  !/^\s*<(?:\?xml|!doctype|svg|html)\b/i.test(value) &&
  !/^\s*(Bearer|Basic|Token)\s/i.test(value) &&
  credentialsIn(value).length === 0 &&
  credentialOf(value) === null;

// Fields of a package.json that hold commands, versions and metadata, and
// those of them no other object with a version usually has (an A2A agent
// card or an MCP server's info has a name, a description and a version too).
const MANIFEST_FIELDS = new Set([
  "author",
  "bin",
  "bugs",
  "contributors",
  "dependencies",
  "description",
  "devDependencies",
  "engines",
  "exports",
  "files",
  "homepage",
  "keywords",
  "license",
  "optionalDependencies",
  "peerDependencies",
  "publishConfig",
  "repository",
  "scripts",
  "workspaces",
]);
const PACKAGE_ONLY = [
  "bin",
  "bugs",
  "dependencies",
  "devDependencies",
  "engines",
  "exports",
  "optionalDependencies",
  "peerDependencies",
  "publishConfig",
  "repository",
  "scripts",
  "workspaces",
];

const holderOf = (module, binding) => `${module}\u0000${binding}`;

// The top-level fields REA reports a string literal under, by holder
// binding, and the holders REA reports a `version` string for.
const manifestShapes = (app) => {
  const fields = new Map();
  const versioned = new Set();
  for (const fact of app.stringLiterals) {
    const slot = fact.data.property;
    if (!slot) continue;
    const holder = holderOf(fact.data.module, slot.binding);
    if (slot.path.length === 1 && slot.path[0] === "version")
      versioned.add(holder);
    if (!fields.has(holder)) fields.set(holder, new Set());
    fields.get(holder).add(slot.path[0]);
  }
  return { fields, versioned };
};

// The fields of each holder REA reports a read of, by name as destinations
// relates a request to a property slot: `card.description` reads
// "description", and a read of `card` itself reads every field ("").
const fieldReads = (app) => {
  const index = indexOf(app);
  const reads = new Set();
  for (const read of app.bindingReads) {
    const { module, name, range } = read.data;
    const path = memberOn(index, module, range)?.path ?? [];
    reads.add(`${holderOf(module, name)}\u0000${path[0] ?? ""}`);
  }
  return reads;
};

/**
 * A test for literals of one app that are values of a bundled package.json:
 * REA places them under a manifest field of a binding (`pkg.scripts.test`)
 * that REA also reports a `version` string for, and the binding also holds
 * a field only a package.json has (`scripts`, `dependencies`), or REA
 * reports no read of the value's field. A description REA reports read
 * (`ask(q, agentCard.description)`) of an object without such a field is
 * not one.
 */
const manifestValues = (app) => {
  const { fields, versioned } = manifestShapes(app);
  const reads = fieldReads(app);
  return (fact) => {
    const slot = fact.data.property;
    if (!slot || !MANIFEST_FIELDS.has(slot.path[0])) return false;
    const holder = holderOf(fact.data.module, slot.binding);
    if (!versioned.has(holder)) return false;
    const held = fields.get(holder);
    return (
      PACKAGE_ONLY.some((field) => held.has(field)) ||
      !(
        reads.has(`${holder}\u0000${slot.path[0]}`) ||
        reads.has(`${holder}\u0000`)
      )
    );
  };
};

// Globals whose calls take a message, and console methods that print one.
const ERRORS = new Set([
  "AggregateError",
  "DOMException",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
const LOGGERS = new Set(["debug", "error", "info", "log", "trace", "warn"]);

// True when `call`, whose callee spans `callee`, starts with the global
// `console` and calls a method that prints: one REA reports the member read
// of (`console.warn(G)`), or a computed one REA reports none for
// (`console[level](G)`).
const consoleCall = (app, index, { module, call, callee }) => {
  const printed = (app.globals ?? []).find(
    (global) =>
      global.module === module &&
      global.name === "console" &&
      sameStart(global.range, call.range) &&
      !comesBefore(callee.end, global.range.end),
  );
  if (!printed) return false;
  // The member read REA's nodes place on that `console` read (members.mjs).
  const member = memberOn(index, module, printed.range);
  return (
    !member ||
    comesBefore(callee.end, member.range.end) ||
    (member.path.length === 1 && LOGGERS.has(member.path[0]))
  );
};

// True when REA reports `range` as the first argument of a call to an error
// constructor (`throw Error(G)`, `new TypeError(G)`) or a console method.
const messageArgument = (app, index, module, range) => {
  const argument = inside(index.arguments.get(module), range).find(
    (item) => item.position === 0 && sameRange(item.range, range),
  );
  if (!argument) return false;
  const call = (index.callSites.get(module) ?? [])
    .filter((site) => within(argument.range, site.range))
    .at(-1);
  if (!call) return false;
  const callee = { start: call.range.start, end: argument.range.start };
  return (
    (app.globals ?? []).some(
      (global) =>
        global.module === module &&
        ERRORS.has(global.name) &&
        within(global.range, call.range) &&
        !comesBefore(callee.end, global.range.end),
    ) || consoleCall(app, index, { module, call, callee })
  );
};

/**
 * A test for literals of one app that REA's facts show are only messages:
 * every read REA reports of the binding holding it is the message argument
 * of an error constructor or a console method. A binding with no read REA
 * reports is not one.
 */
const messageValues = (app) => {
  const index = indexOf(app);
  return (fact) => {
    const { module, binding_range: bound } = fact.data;
    if (!bound) return false;
    const reads = readsOfBinding(index, module, bound);
    return (
      reads.length > 0 &&
      reads.every(({ range }) => messageArgument(app, index, module, range))
    );
  };
};

// One side of the comparison: its string literals by module, with their
// values, and the test for prose REA's facts let Release Watch take for a
// prompt.
const sideOf = (app) => {
  const modules = new Map();
  for (const fact of app.stringLiterals) {
    const { module, value } = fact.data;
    if (!modules.has(module))
      modules.set(module, { facts: [], values: new Set() });
    modules.get(module).facts.push(fact);
    modules.get(module).values.add(value);
  }
  const manifest = manifestValues(app);
  const message = messageValues(app);
  return {
    modules,
    prompt: (fact) =>
      isProse(fact.data.value) && !manifest(fact) && !message(fact),
  };
};

// True when a module of `facts` (one key's facts on `side`) holds `value`.
const holds = (side, facts, value) =>
  facts.some((fact) => side.modules.get(fact.data.module)?.values.has(value));

// A prompt's start on one line, masked as a source line is: URLs keep their
// host and path, and secrets in them or in the prose become tags.
const preview = (value) =>
  textPreview(value.slice(0, 16384).replace(/\s+/g, " ").trim(), 90);
// The keyed tag tells the two texts apart within this report; an unkeyed
// digest of a short prompt could be matched against guesses.
const describe = (label, value) =>
  `${label}: "${preview(value)}" (${value.length} characters, ${maskTag(value)})`;

const nameOf = (fact) => assignedName(fact) ?? "a string literal";

/**
 * Each changed key with a value Release Watch takes for a prompt whose text
 * no old module of the key held (`after`, tested per value, since a
 * minified name holds unrelated strings in other scopes), with the old
 * value it replaces: the key's own when the new modules no longer hold it
 * (`same`). Otherwise the key's old text is still there under another name,
 * and the old text is the prompt of the old module the new one no longer
 * holds that no other finding quotes, when there is one (`elsewhere`), or
 * none (`kept`: the key's old value, with the name that holds it now and
 * how many such texts there are).
 */
const changedPrompts = (items, left, right) => {
  const gone = (item) => (fact) => !holds(right, item.right, fact.data.value);
  const changes = items.flatMap((item) => {
    const after = item.right.find(
      (fact) => right.prompt(fact) && !holds(left, item.left, fact.data.value),
    );
    return after ? [{ item, after, before: item.left.find(gone(item)) }] : [];
  });
  // By data: a fact of a renamed module is a re-keyed copy (diff.mjs).
  const quoted = new Set(changes.map((change) => change.before?.data));
  return changes.map((change) => {
    if (change.before) return { ...change, how: "same" };
    const { item } = change;
    const replaced = [...new Set(item.left.map((fact) => fact.data.module))]
      .flatMap((module) => left.modules.get(module)?.facts ?? [])
      .filter(
        (fact) =>
          !quoted.has(fact.data) && left.prompt(fact) && gone(item)(fact),
      );
    if (replaced.length === 1)
      return { ...change, how: "elsewhere", before: replaced[0] };
    const [before] = item.left;
    const keptAs = item.right
      .flatMap((fact) => right.modules.get(fact.data.module)?.facts ?? [])
      .find((fact) => fact.data.value === before.data.value);
    return { ...change, how: "kept", before, keptAs, gone: replaced.length };
  });
};

// The evidence line for the old text, and, when it is not the key's own,
// how Release Watch chose it.
const oldText = (labels, change) => {
  const { before, how } = change;
  const name = nameOf(change.after);
  const side = { side: "left" };
  if (how === "same")
    return [
      cite(describe(labels.left, before.data.value), before, APP_SOURCE, side),
    ];
  if (how === "kept")
    return [
      cite(
        `${describe(labels.left, before.data.value)}, which ${labels.right} still holds${change.keptAs ? ` as ${nameOf(change.keptAs)}` : ""}`,
        before,
        APP_SOURCE,
        side,
      ),
    ];
  return [
    cite(
      describe(`${labels.left} ${nameOf(before)}`, before.data.value),
      before,
      APP_SOURCE,
      side,
    ),
    heuristic(
      `${name}'s ${labels.left} text is still in ${labels.right} under another name; Release Watch quotes the one prompt text ${before.data.module} held in ${labels.left} that ${labels.right} no longer holds`,
    ),
  ];
};

// The summary's close: what the old text quoted is.
const summaryEnd = ({ how, gone }) => {
  if (how !== "kept") return "";
  const which =
    gone === 0
      ? "no prompt text of the old module is gone"
      : `Release Watch cannot tell which of the ${gone} prompt texts the old module no longer holds it replaces`;
  return `; its old text is still there under another name, and ${which}`;
};

const promptFinding = (labels, change) => {
  const { after } = change;
  const name = nameOf(after);
  return {
    rule: "RW-A04",
    severity: "low",
    title: `Prompt text changed: ${name} in ${after.data.module}`,
    summary: `${name} in ${after.data.module} feeds an AI component and has new text in ${labels.right}${summaryEnd(change)}.`,
    why: "Prompt changes alter model behaviour, safety instructions and what data the model is told to use; they deserve the same review as code.",
    recommendation: "Review the prompt diff with the owner of the AI feature.",
    evidence: [
      ...oldText(labels, change),
      cite(describe(labels.right, after.data.value), after, APP_SOURCE),
      heuristic(
        `Release Watch treats ${after.data.module} as AI code because it imports an AI SDK, reads a provider setting or holds a provider URL`,
      ),
    ],
    unknowns: [
      "REA keeps a string only when a variable or a property of its initializer holds it; prompts passed inline to an SDK call are not visible, so an unchanged report does not prove unchanged prompts.",
      "Release Watch counts text as new only when no string of the old module had it, so text moved between variables is not reported.",
    ],
  };
};

/** RW-A04 for changed prose in AI code, one finding per changed key. */
export const promptFindings = (context) => {
  const { left, right, labels } = context;
  if (!right.app || !left.app) return [];
  const modules = aiModules(right.app);
  const items = context.diff.app.stringLiterals
    .filter((item) => item.status === "changed")
    .filter((item) =>
      item.right.every((fact) => modules.has(fact.data.module)),
    );
  return changedPrompts(items, sideOf(left.app), sideOf(right.app)).map(
    (change) => promptFinding(labels, change),
  );
};
