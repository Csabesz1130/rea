// The sentences a reach path is reported in. Each step says which REA fact
// it follows and, where REA's facts did not settle which function a member
// read selects, which part of an element a callback parameter holds, which
// property a destructuring takes, what a member call is made on, or
// whether a call belongs to a value, that Release Watch followed every
// candidate.

import { MAX_PATH } from "./reach-resolve.mjs";

const GUESSES = new Set(["guess", "whole", "candidate"]);

/**
 * True for a step that followed every candidate: of a member read, of
 * what a callback parameter holds, of a call that may not be part of the
 * value it was read in (`open`), or of a member read REA's nodes do not
 * place on one expression, taken for one on `this`.
 */
export const isGuess = (step) =>
  GUESSES.has(step.how) ||
  step.open === true ||
  step.cut === true ||
  step.receiver === "unsettled";

// The read a step names: with its member, unless the member was carried
// over from another value's read (`for (const tool of TOOLS)`, a spread).
const read = (step) =>
  step.selects && !step.forwarded ? `${step.name}.${step.selects}` : step.name;

const importedName = (step) => {
  if (step.namespaced) return `${step.name}.${step.imported}`;
  return step.imported === step.name
    ? step.name
    : `${step.imported} as ${step.name}`;
};

// The methods a member read left out: REA names them after other members.
const besides = (step) =>
  step.methods ? " and the methods REA names after other members" : "";

// What an import step adds about the member read it resolves.
const settled = (step) => {
  if (step.how === "guess")
    return `; REA names no function ${step.selects} in its value, so Release Watch followed each function and binding it holds that could be ${step.selects}`;
  if (step.how === "whole")
    return `; Release Watch found no function ${step.selects} in it, so it followed all of it`;
  if (step.how === "candidate")
    return `, a function the value holds that could be ${step.selects}, so Release Watch followed it`;
  if (step.how === "slots")
    return `, whose value holds functions only under ${step.selects}${besides(step)}`;
  if (step.how === "written")
    return `, a property REA reports written in that module`;
  return "";
};

const importText = (step) => {
  const member =
    step.selects && step.how !== "self" && !step.namespaced && !step.forwarded
      ? `.${step.selects}`
      : "";
  const origin =
    step.imported === "default" && !step.namespaced
      ? `${step.name}${member}, the default export of ${step.module}`
      : `${importedName(step)}${member}, imported from ${step.module}`;
  const defined = step.defined
    ? `, which re-exports it from ${step.defined}`
    : "";
  return `reads ${origin}${defined}${settled(step)}`;
};

const localText = (step) => {
  if (step.how === "member")
    return `reads ${read(step)}, a function ${step.name} defines`;
  if (step.how === "candidate")
    return `reads ${step.name}, a function in the same module the value holds that could be ${step.selects}, so Release Watch followed it`;
  if (step.how === "whole")
    return `reads ${read(step)}; Release Watch found no function ${step.selects} in ${step.name}, so it followed all of ${step.name}`;
  return `reads ${step.name}, a function in the same module`;
};

// Where a value step's binding gets what it holds: its initializer, and
// the assignments, property writes and added elements after it, or the
// default value its destructuring pattern gives it.
const holder = (step) => {
  if (step.fallback)
    return {
      what: "default value in its destructuring pattern",
      they: "it",
      s: "s",
    };
  return step.assigned
    ? { what: "initializer or later assignments", they: "they", s: "" }
    : { what: "initializer", they: "it", s: "s" };
};

// A read of a binding REA reports destructured: from which property of
// what its pattern destructures, and what that holds when the destructured
// value defines functions itself.
const destructuredText = (step) => {
  const { path, iterated, computedKey } = step.destructured;
  const of = iterated
    ? "each element its for…of loop iterates"
    : "the value its declaration destructures";
  if (computedKey)
    return `reads ${step.name}, whose value REA could not project from ${of} through a computed key, so Release Watch followed all of that value`;
  const read = `reads ${step.name}, which REA reports destructured from ${path ? `${path.join(".")} of ${of}` : `a property REA does not resolve of ${of}, which reads a computed member`}`;
  if (!path) return `${read}, so Release Watch followed all of that value`;
  if (step.how === "guess")
    return `${read}; REA names no function ${step.selects} there, so Release Watch followed each function and binding it holds that could be ${step.selects}`;
  return step.target ? `${read}, which defines ${step.target}` : read;
};

const valueText = (step) => {
  if (step.destructured) return destructuredText(step);
  const { what, they, s } = holder(step);
  if (step.how === "guess")
    return `reads ${read(step)}; REA names no function ${step.selects} in the ${what} of ${step.name}, so Release Watch followed each function ${they} define${s} that could be ${step.selects}`;
  if (step.how === "written")
    return `reads ${read(step)}, a property REA reports written with ${step.target ?? "a function"}`;
  if (step.how === "named")
    return `reads ${read(step)}, whose ${what} define${s} ${step.selects}`;
  if (step.how === "slots")
    return `reads ${read(step)}, whose ${what} hold${s} functions only under ${step.selects}${besides(step)}`;
  return `reads ${read(step)}, whose ${what} define${s} ${step.target ?? "a function"}`;
};

const initializerText = (step) => {
  if (step.destructured) return destructuredText(step);
  const { what, they, s } = holder(step);
  if (step.how === "guess")
    return `reads ${read(step)}; REA names no function ${step.selects} in the ${what} of ${step.name}, so Release Watch followed the bindings ${they} read${s}`;
  if (step.how === "slots")
    return `reads ${read(step)}, whose ${what} read${s} further bindings and hold${s} functions only under ${step.selects}${besides(step)}`;
  if (step.how === "written")
    return `reads ${read(step)}, a property REA reports written with a value that reads further bindings`;
  return `reads ${read(step)}, whose ${what} read${s} further bindings`;
};

const producedText = (step) => {
  if (step.kind === "runs")
    return step.target
      ? `runs a function it defines when the module loads, and what that returns defines ${step.target}`
      : "runs a function it defines when the module loads, and what that returns reads further bindings";
  if (step.kind === "instance")
    return step.how === "guess"
      ? `is constructed when the module loads; Release Watch found no method ${step.selects}, so it followed each method`
      : `is constructed when the module loads, and ${step.target} is a method of the instance`;
  if (step.how === "guess")
    return `is called when the module loads; REA names no function ${step.selects} in what it returns, so Release Watch followed each function and binding it holds that could be ${step.selects}`;
  return step.target
    ? `is called when the module loads, and what it returns defines ${step.target}`
    : "is called when the module loads, and what it returns reads further bindings";
};

const elementText = (step) => {
  const parameter = `reads ${read(step)}, a parameter of the callback ${step.method}() runs for each element of its receiver`;
  return step.how === "whole"
    ? `${parameter}; REA does not say whether it holds a whole element, a property of one or a key, so Release Watch followed all of each element`
    : parameter;
};

const thisText = (step) => {
  const read =
    step.receiver === "unsettled"
      ? `reads .${step.name} on an expression REA reports no single receiver for, which may be this`
      : `reads .${step.name} on a receiver REA does not resolve (such as this)`;
  if (step.via)
    return `${read}, which ${step.owner} does not define; Release Watch looked ${step.target} up in ${step.via}, a binding ${step.owner} reads outside its methods (such as the class it extends)`;
  if (step.field)
    return step.how === "guess"
      ? `${read}, which Release Watch took for the class field ${step.target} of ${step.owner}, and followed each function that field's value defines`
      : `${read}, which Release Watch took for the function the class field ${step.target} of ${step.owner} holds`;
  return `${read}, which Release Watch took for ${step.target}, a function ${step.owner ?? "the module"} defines`;
};

const STEP_TEXT = {
  call: (step) =>
    `calls ${step.name ?? "a function"} through a call REA resolved`,
  local: localText,
  value: valueText,
  initializer: initializerText,
  instance: producedText,
  returns: producedText,
  runs: producedText,
  element: elementText,
  "this-member": thisText,
  import: importText,
  "unresolved-import": (step) =>
    `reads ${importedName(step)}, imported from ${step.module}, which Release Watch could not resolve to one of its functions, so it followed the whole module`,
};

// A step that is a call Release Watch read as part of a value, which may be
// a statement after it.
const OPEN =
  " (a call Release Watch read as part of that value gives it this; REA does not report where the value ends, and the call may be a statement after it)";

// A step that followed every candidate of a member read.
const memberGuess = (step) =>
  GUESSES.has(step.how) &&
  step.kind !== "element" &&
  step.destructured?.path !== null;

// A step whose member chain Release Watch cut at MAX_PATH members.
const CUT = ` (a chain of more than ${MAX_PATH} members, which Release Watch cut there, following all of what its first ${MAX_PATH} select)`;

/** The unknowns a finding carries for the reach paths it cites. */
export const reachUnknowns = (paths) => {
  const steps = paths.flatMap((path) => path?.steps ?? []);
  const unknowns = [];
  if (paths.some((path) => path?.kind === "unresolved-import"))
    unknowns.push(
      "Release Watch could not resolve an import to one of its module's functions, so it followed everything that module does.",
    );
  if (steps.some(memberGuess))
    unknowns.push(
      "REA's facts do not say which function a member read selects, so Release Watch followed every function and binding the value holds that could be that member; the handler may not reach this process site.",
    );
  if (steps.some((step) => step.destructured?.path === null))
    unknowns.push(
      "REA does not resolve which property a destructuring takes through a computed key (`{ [key]: run }`) or from a computed member (`= TOOLS[name]`), so Release Watch followed all of the destructured value; the handler may not reach this process site.",
    );
  if (steps.some((step) => step.kind === "element" && step.how === "whole"))
    unknowns.push(
      "REA does not say which part of each element a callback parameter holds (a whole element, a destructured property or a key), so Release Watch followed all of each element; the handler may not reach this process site.",
    );
  if (steps.some((step) => step.open))
    unknowns.push(
      "REA does not report where an object or array literal ends; Release Watch read a call after one as part of it, and the handler may not reach this process site through what that call is given.",
    );
  if (steps.some((step) => step.cut))
    unknowns.push(
      `A value read its own property writes back, so the member chain Release Watch followed grew past ${MAX_PATH} members; it followed all of what the first ${MAX_PATH} select, and the handler may not reach this process site.`,
    );
  if (steps.some((step) => step.kind === "this-member"))
    unknowns.push(
      "REA does not resolve the receiver of a member call such as this.run(); Release Watch matched it by name to a function the enclosing class or object defines.",
    );
  if (steps.some((step) => step.receiver === "unsettled"))
    unknowns.push(
      "REA's nodes do not show which expression a member call such as (a || b).run() is made on; Release Watch took it for one on this, and the handler may not reach this process site.",
    );
  return unknowns;
};

/** One heuristic sentence for a reach path; `owner` names the code that reaches, in lower case. */
export const reachClaim = (path, exec, owner) => {
  const subject = `${owner[0].toUpperCase()}${owner.slice(1)}`;
  if (path.kind === "inline")
    return `${subject} contains ${exec.data.method}() in its source range`;
  const chain = path.steps
    .map(
      (step) =>
        `${STEP_TEXT[step.kind](step)}${step.open ? OPEN : ""}${step.cut ? CUT : ""}`,
    )
    .join(", which ");
  return `${subject} ${chain}; ${exec.data.method}() runs there. REA reports each read, import and function; Release Watch connects them`;
};
