// What RW-P01 says about the commands of a changed process key (one
// module and method whose sites run commands the old side did not): each
// command REA resolved, shown as a source line shows it, and a claim per
// kind of site. A command is called new only where REA resolved every
// command the old side ran there; a site REA did not resolve on either
// side may be the same call with the same command.
import { textPreview } from "../source-line.mjs";
import { maskTag } from "../urls.mjs";

// How much of a command a claim shows; a longer one gets its length and
// keyed tag, so two commands that start alike stay apart.
const WIDTH = 120;

export const unresolved = (site) => site.data.command === null;

/**
 * A resolved command as a claim names it: its start masked by the rules
 * that mask secrets in a source line (redact.mjs owns them: Bearer and
 * Basic values, curl's `-u user:password`, credential formats, URL user
 * info, values after a credential-like name such as `API_KEY=…`).
 */
export const commandText = (command) => {
  const shown = JSON.stringify(textPreview(command, WIDTH));
  return command.length > WIDTH
    ? `${shown} (${command.length} characters, ${maskTag(command)})`
    : shown;
};

const distinct = (values) => [...new Set(values)];

// One command by name, several by count: `{ text, one }`.
const subject = (commands, noun = "commands") =>
  commands.length === 1
    ? { text: commandText(commands[0]), one: true }
    : { text: `${commands.length} ${noun}`, one: false };

// The commands of a changed key by what REA resolved: new commands no
// resolved old one matches, resolved old commands now run at more sites,
// and the new and old sites REA did not resolve.
const commandsAt = (group) => {
  const old = new Set(
    group.left
      .filter((site) => !unresolved(site))
      .map((site) => site.data.command),
  );
  const resolved = group.facts
    .filter((site) => !unresolved(site))
    .map((site) => site.data.command);
  return {
    fresh: distinct(resolved.filter((command) => !old.has(command))),
    repeated: distinct(resolved.filter((command) => old.has(command))),
    dynamic: group.facts.filter(unresolved).length,
    oldResolved: old.size,
    oldUnresolved: group.left.filter(unresolved).length,
    oldSites: group.left.length,
  };
};

// The old sites REA did not resolve a command for, counted as sites (two
// may run one command): " at 2 sites", or, beside sites it resolved,
// " at one other site".
const unresolvedSites = (count, others) => {
  if (count === 1) return others ? " at one other site" : "";
  return ` at ${count}${others ? " other" : ""} sites`;
};

// Why the new commands may still be ones the old side ran there: REA did
// not resolve the command at one or `count` old sites, beside the commands
// it resolved there when `others`.
const hedge = ({ text, one }, count, others) => {
  if (!others && count === 1)
    return one
      ? `${text} may be the same command`
      : `it may be one of the ${text}`;
  if (!others)
    return one ? `${text} may be one of them` : `the ${text} may be among them`;
  if (count === 1)
    return one ? "it may be that one" : "one of them may be that one";
  return one ? "it may be one of those" : "they may be among those";
};

// "<new commands> may be <old commands>" for the unknowns: one command, or
// some of several, which one old site may have run.
const mayBe = ({ text, one }, count) => {
  if (one) return `${text} may be a command`;
  return count === 1
    ? `One of the ${text} may be a command`
    : `The ${text} may be commands`;
};

const freshClaims = ({ R, L, module }, at) => {
  const { fresh, oldResolved, oldUnresolved: count } = at;
  if (fresh.length === 0) return [[], []];
  const named = subject(fresh);
  const runs = `${R} runs ${named.text} from ${module}${named.one ? ", which" : " that"}`;
  if (count === 0) return [[`${runs} ${L} did not run there.`], []];
  const others = oldResolved > 0;
  const commands = `the command${count === 1 ? "" : "s"}`;
  const sites = unresolvedSites(count, others);
  const summary = others
    ? `${runs} no command REA resolved for ${L} there matches; REA did not resolve ${commands} ${L} ran there${sites}, so ${hedge(named, count, true)}.`
    : `REA did not resolve ${commands} ${L} ran from ${module}${sites}, so ${hedge(named, count, false)}.`;
  return [
    [summary],
    [
      `${mayBe(named, count)} ${L} ran here: REA did not resolve ${commands} it ran${sites} here.`,
    ],
  ];
};

const dynamicClaims = ({ R, L, module }, at, others) => {
  const { dynamic, oldSites } = at;
  if (dynamic === 0) return [[], []];
  if (dynamic === 1)
    return [
      [
        `REA did not resolve the command ${R} runs from ${module}${others ? " at one other site" : ""}, so it may be ${oldSites === 1 ? "the command" : "a command"} ${L} ran there.`,
      ],
      [
        `REA did not resolve the command ${R} runs at one site here, so that site may be the same call with the same command as before.`,
      ],
    ];
  return [
    [
      `REA did not resolve the commands ${R} runs from ${module} at ${dynamic}${others ? " other" : ""} sites, so they may be commands ${L} ran there.`,
    ],
    [
      `REA did not resolve the commands ${R} runs at ${dynamic} sites here, so those sites may be the same calls with the same commands as before.`,
    ],
  ];
};

/**
 * `{ summary, unknowns }` for a changed key: the resolved commands no
 * resolved old command there matches, definite when REA resolved every old
 * command there and hedged otherwise; resolved old commands now run at more
 * sites; and the sites REA did not resolve, which may run the commands the
 * old side ran.
 */
export const changedClaims = ({ labels }, group) => {
  const words = {
    R: labels.right,
    L: labels.left,
    module: group.facts[0].data.module,
  };
  const at = commandsAt(group);
  const [freshSummary, freshUnknowns] = freshClaims(words, at);
  const repeated =
    at.repeated.length > 0
      ? [
          `${words.R} runs ${subject(at.repeated, `of ${words.L}'s commands`).text} from ${words.module} at more sites than ${words.L} did.`,
        ]
      : [];
  const [dynamicSummary, dynamicUnknowns] = dynamicClaims(
    words,
    at,
    at.fresh.length + at.repeated.length > 0,
  );
  return {
    summary: [...freshSummary, ...repeated, ...dynamicSummary].join(" "),
    unknowns: [...freshUnknowns, ...dynamicUnknowns],
  };
};
