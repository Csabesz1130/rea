// RW-C01's process gaps: the places in changed files where a module uses a
// value REA's facts tie to child_process and REA classified no process call
// (facts/process.mjs), one evidence line each, saying how Release Watch tied
// the value to child_process.
import { APP_SOURCE, cite, heuristic } from "./shared.mjs";

const holds = (member) =>
  member ? `child_process's ${member}` : "child_process";

// How the value at a gap holds child_process, as the fact says Release
// Watch tied it there; null for `require("child_process")` itself.
const HOLDER_NOTES = {
  import: ({ receiver, member }) =>
    member && member !== receiver
      ? `${receiver} is ${holds(member)}, imported under another name`
      : `${receiver} is imported from child_process`,
  destructure: ({ receiver, member, from }) =>
    `${receiver} is ${holds(member)}, destructured from ${from}`,
  parameter: ({ receiver, member, from }) =>
    `${receiver} is a parameter REA links to ${from}, which holds ${holds(member)}`,
  alias: ({ receiver, member, from }) =>
    `Release Watch takes ${receiver} to hold ${holds(member)}: REA reports it defined right before a read of ${from} and gives its value no other source`,
  assigned: ({ receiver, from }) => `${receiver} is assigned ${from}`,
  pattern: ({ receiver, member, from }) =>
    `Release Watch takes ${receiver} to be ${holds(member)}: REA reports it destructured right before ${from}, whose result REA links to no binding`,
  wrapper: ({ receiver, from }) =>
    `Release Watch takes ${receiver} to hold child_process: it is assigned a call on ${from}`,
  export: ({ receiver, member, from }) =>
    `${receiver} is ${holds(member)}, which ${from} exports`,
  "export-name": ({ receiver, member, from, exported }) =>
    `Release Watch takes ${receiver} to hold ${holds(member)}: ${from} holds it in ${exported}, whose use REA's graph does not show, and REA traced no export under that name`,
  constant: ({ receiver, from }) =>
    `${receiver} loads child_process: REA reports ${from} constant "child_process"`,
  loader: ({ receiver }) =>
    `Release Watch takes ${receiver} to load child_process: REA resolves no module for it, and the name read on it is a child_process export`,
};

const holderNote = (gap) => {
  const note = HOLDER_NOTES[gap.via]?.(gap) ?? null;
  // A value derived from a load Release Watch only takes to be child_process.
  if (gap.loader && gap.via !== "loader")
    return `${note}; Release Watch takes ${gap.loader} to load child_process: REA resolves no module for it`;
  return note;
};

const MAY_MISS = "so a process call through it may not be classified";

const gapClaim = (gap) => {
  const note = holderNote(gap);
  const target = `${gap.receiver}${gap.path ? `.${gap.path.join(".")}` : ""}${note ? ` (${note})` : ""}`;
  const { module } = gap;
  const claims = {
    call: `REA classified no process call where ${module} calls ${target}`,
    read: `REA classified no process call where ${module} reads ${target}, ${MAY_MISS}`,
    pass: `REA did not resolve the call to which ${module} passes ${target}, ${MAY_MISS}`,
    return: `${module} returns ${target}, ${MAY_MISS}`,
    value: `REA's graph does not show how ${module} uses ${target}, ${MAY_MISS}`,
    "computed-call": `REA could not resolve the computed member name ${module} calls on ${target}, so that process call is not classified`,
    "computed-read": `REA could not resolve the computed member name ${module} reads on ${target}, ${MAY_MISS}`,
    load:
      gap.via === "import"
        ? `REA reports no binding for ${gap.receiver}, which ${module} imports from child_process, so process calls through it may not be classified`
        : `REA ties no binding to the result of ${gap.receiver} in ${module}${note ? ` (${note})` : ""}, so process calls through it may not be classified`,
  };
  return claims[gap.use];
};

/**
 * One evidence line per gap; a gap that rests on Release Watch's
 * correlation (an alias, an interop wrapper, an export found by name, a
 * load REA resolves no module for) is labelled heuristic.
 */
export const gapLine = (unknown) =>
  unknown.data.heuristic
    ? heuristic(gapClaim(unknown.data), unknown.location)
    : cite(gapClaim(unknown.data), unknown, APP_SOURCE);

// A load whose value REA's graph shows no use of at all: REA reports no
// statement facts, so a `require("child_process");` whose result is
// discarded (rollup's CommonJS form of `import "child_process"`) reads the
// same as one whose result goes where the graph does not show.
const unused = (unknown) => unknown.data.use === "load";

/**
 * The process gaps in files `changed` says changed, once per place: those
 * at a use REA's graph shows first, then loads it shows no use of, so a
 * capped list of evidence and files leads with the specific ones.
 */
export const processGapsOf = (app, changed) => {
  const gaps = [
    ...new Map(
      (app?.processUnknowns ?? [])
        .filter((unknown) => changed(unknown.data.module))
        .map((unknown) => [unknown.key, unknown]),
    ).values(),
  ];
  return [
    ...gaps.filter((unknown) => !unused(unknown)),
    ...gaps.filter(unused),
  ];
};
