// MCP server rules: tools whose handlers start processes, and new tool
// registrations. REA reports the registration call and the process site; it
// does not report tool names, descriptions or schemas. Which calls register
// tools is mcp-registrations.mjs's reading; registration calls anywhere in
// a server component count, since servers often register tools in modules
// that only receive the server object.
import { renamedFrom } from "../diff.mjs";
import { examinedInPart } from "../facts/coverage.mjs";
import { withoutHash } from "../facts/modules.mjs";
import { startsBefore } from "../ranges.mjs";
import { isMcpServer } from "../surfaces.mjs";
import {
  componentAbsence,
  componentList,
  componentName,
  heldElsewhere,
  perComponent,
  processAbsence,
  relocatedUnresolved,
} from "./component-absence.mjs";
import {
  isDispatcher,
  registrationApi,
  registrationClaim,
  registrationItems,
  serverEvidence,
  toolRegistrations,
} from "./mcp-registrations.mjs";
import { oldRelease } from "./network.mjs";
import { reachOf, reachedFrom } from "./reach.mjs";
import { reachClaim, reachUnknowns } from "./reach-text.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  newGroups,
  packResult,
} from "./shared.mjs";

// What a registration reaches, independent of the module that holds the
// exec site and of the member that registers it: moving the exec into a
// helper module, or a tool from `tool()` to `registerTool()`, is not a new
// capability.
const capabilityOf = (call, exec) =>
  `${registrationApi(call)}|${exec.data.method}|${exec.data.command ?? "unresolved"}`;

/** Every tool-registration-to-exec connection one side has. */
const connections = (app) =>
  toolRegistrations(app).flatMap((call) => {
    const scope = { module: call.data.module, range: call.data.range };
    return [...reachedFrom(app, scope).values()].map(({ exec }) => ({
      key: capabilityOf(call, exec),
      call,
      exec,
      path: reachOf(app, scope, exec),
    }));
  });

const countBy = (items) =>
  items.reduce(
    (counts, item) => counts.set(item.key, (counts.get(item.key) ?? 0) + 1),
    new Map(),
  );

// Connections a path REA's facts settle makes, with no guessed step.
const settledBy = (items) => countBy(items.filter((item) => !item.path.guess));

// The files a connection passes through: the registration's, each module
// a step reads or imports from, and the process site's.
const filesOf = ({ call, exec, path }) => [
  call.data.module,
  ...path.steps.flatMap((step) => [
    step.location?.file,
    step.module,
    step.defined,
  ]),
  exec.data.module,
];

/**
 * The old side's files that REA did not fully analyze and that a new-side
 * connection's files may have been: `(pair) → [old file]`. A file's old
 * counterpart is the one at its path or the one the release pairing gave
 * it; a bundle nothing paired may be any old bundle of its name without
 * the content hash. The old side may have made the same connection
 * through such a file without REA's facts showing it.
 */
const partlyAnalyzedBefore = (context) => {
  const old = context.left.app;
  const unexamined = new Set(old ? examinedInPart(old) : []);
  if (unexamined.size === 0) return () => [];
  const renamed = renamedFrom(context.aliases);
  const shipped = new Set(old.assets.map((asset) => asset.key));
  const counterparts = (file) => {
    const paired = renamed(file) ?? (shipped.has(file) ? file : null);
    if (paired !== null) return [paired];
    const bare = withoutHash(file);
    return bare === file
      ? []
      : [...unexamined].filter((candidate) => withoutHash(candidate) === bare);
  };
  return (pair) => [
    ...new Set(
      filesOf(pair)
        .filter((file) => typeof file === "string")
        .flatMap(counterparts)
        .filter((file) => unexamined.has(file)),
    ),
  ];
};

/** Connections per capability across a release's old and new apps: `Map(key → { before, after })`. */
export const connectionTotals = (leftApps, rightApps) => {
  const totals = new Map();
  const add = (apps, side) => {
    for (const app of apps)
      for (const [key, count] of countBy(connections(app))) {
        const entry = totals.get(key) ?? { before: 0, after: 0 };
        entry[side] += count;
        totals.set(key, entry);
      }
  };
  add(leftApps, "before");
  add(rightApps, "after");
  return totals;
};

// A connection is new when the component has more connections of that
// capability than before and so does the release: a tool that moved to
// another component keeps the release's count.
const increased = (context, before, after) => (key) => {
  const release = context.release?.connections?.get(key);
  return (
    (after.get(key) ?? 0) > (before.get(key) ?? 0) &&
    (!release || release.after > release.before)
  );
};

// The connection a finding's title and summary name: one REA's facts
// settle when the finding says the tool reaches the site, preferring a new
// process site over one the old release had.
const named = (keyed, groups, reaches) => {
  const fits = (pair) => !reaches || !pair.path.guess;
  return (
    keyed.find((pair) => fits(pair) && groups.has(pair.exec.key)) ??
    keyed.find(fits) ??
    keyed[0]
  );
};

// How a finding names a registration and where it is.
const at = (call) =>
  `${call.data.module}${call.location?.line ? `:${call.location.line}` : ""}`;
const registrationTitle = (call) =>
  isDispatcher(call)
    ? `CallTool request handler in ${call.data.module}`
    : `${call.data.member}() in ${call.data.module}`;
const summaryOf = (context, { call, exec }, reaches) => {
  const site = `${exec.data.method}() in ${exec.data.module}`;
  return isDispatcher(call)
    ? `${context.labels.right} handles MCP tool calls through ${call.data.member}() at ${at(call)}, and that handler ${reaches} ${site}.`
    : `${context.labels.right} registers an MCP tool with ${call.data.member}() at ${at(call)} whose handler ${reaches} ${site}.`;
};

// Who can use a tool that starts processes.
const REACH =
  "agent connected to this server, and any prompt injection that steers that agent, can ask it to run commands on the host.";

// How a finding words its connection: settled and new; settled through
// files the old side's analysis left partial (`partial`, its old files),
// so the old tools may have reached the site the same way; or reached only
// through a guess.
const wording = (context, pair, { reaches, partial }) => {
  const title = registrationTitle(pair.call);
  if (!reaches)
    return {
      title: `MCP tool may start processes: ${title}`,
      summary: summaryOf(context, pair, "may reach"),
      why: `Release Watch could not settle that the handler reaches this site; if it does, any ${REACH}`,
    };
  if (partial.length === 0)
    return {
      title: `MCP tool can start processes: ${title}`,
      summary: summaryOf(context, pair, "reaches"),
      why: `Any ${REACH}`,
    };
  return {
    title: `MCP tool can start processes, perhaps as before: ${title}`,
    summary: `${summaryOf(context, pair, "reaches")} REA did not fully analyze ${partial.slice(0, 3).join(", ")}${partial.length > 3 ? ` and ${partial.length - 3} more` : ""} in ${context.labels.left}, through which its tools may have reached the site the same way.`,
    why: `Release Watch could not settle that this connection is new; if it is, any ${REACH}`,
  };
};

const toolExecution = (context) => {
  const { left, right, diff } = context;
  const old = connections(left.app);
  const before = countBy(old);
  const pairs = connections(right.app);
  const after = countBy(pairs);
  const isIncreased = increased(context, before, after);
  const settled = { before: settledBy(old), after: settledBy(pairs) };
  const partly = partlyAnalyzedBefore(context);
  // Settled connections the old side's analysis could have shown as well.
  const comparable = settledBy(
    pairs.filter((pair) => partly(pair).length === 0),
  );
  const groups = new Map(
    newGroups(diff.app.childProcesses, { field: "command" }).map((group) => [
      group.key,
      group,
    ]),
  );
  const findings = [];
  const nodes = new Set();
  const modules = new Set();
  const reported = new Set();
  for (const { key } of pairs) {
    if (!isIncreased(key) || reported.has(key)) continue;
    reported.add(key);
    // Every registration with this capability: Release Watch cannot tell which one is new.
    const keyed = pairs.filter((pair) => pair.key === key);
    keyed.forEach((pair) => {
      nodes.add(pair.exec.node_id);
      modules.add(pair.call.data.module);
      // Every site of an increased key is explained here, the unchanged one too.
      groups
        .get(pair.exec.key)
        ?.facts.forEach((fact) => nodes.add(fact.node_id));
    });
    // A guessed path names a candidate, not a handler REA's facts identify:
    // the tool reaches the site only when settled connections increased,
    // and that is new only when they did through files the old side's
    // analysis covered.
    const had = settled.before.get(key) ?? 0;
    const reaches = (settled.after.get(key) ?? 0) > had;
    const pair = named(keyed, groups, reaches);
    const partial =
      reaches && (comparable.get(key) ?? 0) <= had
        ? [...new Set(keyed.filter((item) => !item.path.guess).flatMap(partly))]
        : [];
    findings.push({
      rule: "RW-M01",
      severity: "critical",
      ...wording(context, pair, { reaches, partial }),
      recommendation:
        "Remove the tool or restrict it to an allow-list of fixed commands, and require human confirmation for each call.",
      evidence: [
        ...serverEvidence(right.app),
        ...connectionEvidence(context, keyed, { groups, old }),
      ],
      unknowns: toolUnknowns(context, keyed, groups),
    });
  }
  return { findings, nodes: [...nodes], modules };
};

const toolUnknowns = (context, keyed, groups) => {
  // A site with a command REA did not resolve never pairs as moved; one of
  // its method the release lost may be the same call.
  const relocated = keyed.flatMap(({ exec }) => {
    const group = groups.get(exec.key);
    return group && group.status !== "changed" && exec.data.command === null
      ? [relocatedUnresolved(context, exec.data.method)]
      : [];
  });
  return [
    "REA does not report the tool's name, description or input schema.",
    "REA does not establish that the tool's input reaches the command.",
    ...reachUnknowns(keyed.map((pair) => pair.path)),
    ...(keyed.some(
      ({ exec }) =>
        groups.has(exec.key) &&
        processAbsence(context, groups.get(exec.key)).held,
    )
      ? [perComponent("process execution sites")]
      : []),
    ...new Set(relocated.filter(Boolean)),
  ];
};

// What the old side's registrations of the same capability reached, by
// capability rather than by site: a content-hashed bundle's sites have
// other keys in each release, and a site at a path the old side lacked may
// be one of these, moved. Null when they reached none.
const earlierReach = (context, old, key) => {
  const same = old.filter((pair) => pair.key === key);
  if (same.length === 0) return null;
  const registrations = new Set(same.map((pair) => pair.call.node_id)).size;
  const [{ exec }] = same;
  const modules = [...new Set(same.map((pair) => pair.exec.data.module))];
  return `Release Watch connected ${registrations} tool registration${registrations === 1 ? "" : "s"} to ${exec.data.method}() ${exec.data.command ? "with the same command" : "with a command REA did not resolve"} in ${modules.join(", ")}`;
};

// How the old release had an exec site: moved from another place in the
// release; the component's own diff status, with what the old side's
// registrations of that capability reached; or unchanged, with how many old
// registrations reached it, else (a content-hashed bundle nothing paired)
// what they reached of that capability.
const execAbsence = (context, { groups, old }, { exec, key }) => {
  const moved = context.moves?.childProcesses.pairs.get(exec.node_id);
  const left = context.releaseLabels?.left ?? context.labels.left;
  if (moved)
    return `${left} ran the same command from ${moved.fact.data.module}${moved.component === context.id ? "" : ` in component ${componentName(context, "left", moved.component)}`}`;
  const group = groups.get(exec.key);
  const earlier = earlierReach(context, old, key);
  if (group)
    return `${processAbsence(context, group).phrase}${earlier ? `; in ${context.labels.left}, ${earlier}` : ""}`;
  const here = sameSite(context, old, exec);
  return `also in ${context.labels.left}, where ${here > 0 || !earlier ? `Release Watch connected ${here === 0 ? "no" : here} tool registration${here === 1 ? "" : "s"} to it` : earlier}`;
};

// How many old registrations reached a site of the same method and command
// in this module, at its old path when the release pairing renamed it.
const sameSite = (context, old, exec) => {
  const command = exec.data.command ?? null;
  return new Set(
    old
      .filter(
        ({ exec: before }) =>
          (context.aliases?.get(before.data.module)?.path ??
            before.data.module) === exec.data.module &&
          before.data.method === exec.data.method &&
          (before.data.command ?? null) === command,
      )
      .map((pair) => pair.call.node_id),
  ).size;
};

// Each registration once, each way it reaches a site once (a registration
// that reaches two sites in one minified line through the same path is
// claimed once), and each process site once.
const connectionEvidence = (context, keyed, sides) => {
  const cited = new Set();
  const once = (key, line) => {
    if (cited.has(key)) return [];
    cited.add(key);
    return [line];
  };
  return keyed.flatMap((pair) => {
    const { call, exec, path } = pair;
    const claim = reachClaim(path, exec, "the registration call");
    const where = path.read?.location ?? exec.location;
    return [
      ...once(
        call.node_id,
        cite(registrationClaim(context.right.app, call), call, APP_SOURCE),
      ),
      ...once(
        `${call.node_id}\u0000${claim}\u0000${where?.file}:${where?.line}:${where?.column}`,
        heuristic(claim, where),
      ),
      ...once(
        exec.node_id,
        cite(
          `${exec.data.method}() creates a child process${exec.data.command ? "" : " with a command REA did not resolve"} (${execAbsence(context, sides, pair)})`,
          exec,
          APP_SOURCE,
        ),
      ),
    ];
  });
};

const apisOf = (calls) => new Set(calls.map(registrationApi));

// The server moved between one dispatcher and per-tool registration calls,
// so the two counts measure different things.
const apiChange = (context, before, after) => ({
  rule: "RW-M02",
  severity: "low",
  title: "MCP tool registration API changed",
  summary: `${context.labels.left} registered tools through ${[...apisOf(before)].join(" and ")}, ${context.labels.right} through ${[...apisOf(after)].join(" and ")}; Release Watch cannot compare how many tools each has.`,
  why: "New tools can hide in a rewrite of how tools are registered.",
  recommendation: "Compare the tool lists of both releases by hand.",
  evidence: [
    ...after.map((call) =>
      cite(registrationClaim(context.right.app, call), call, APP_SOURCE),
    ),
    ...serverEvidence(context.right.app),
  ],
  unknowns: [
    "REA does not report tool names, so Release Watch cannot pair tools across registration APIs.",
  ],
});

/**
 * RW-M02: the server has more tool registration calls than before, once
 * per component, citing the modules that gained calls. Registrations that
 * moved between modules or components keep the totals and are not reported.
 */
const newRegistrations = (context, covered) => {
  if (!isMcpServer(context.right.app)) return [];
  const old = toolRegistrations(context.left.app);
  const now = toolRegistrations(context.right.app);
  const release = context.release?.registrations;
  if (now.length <= old.length || (release && release.after <= release.before))
    return [];
  const apis = [apisOf(old), apisOf(now)].map((set) => [...set].sort().join());
  if (old.length > 0 && apis[0] !== apis[1])
    return [apiChange(context, old, now)];
  const gained = registrationItems(
    context.diff.app.memberCalls,
    context.left.app,
    context.right.app,
  )
    .map(({ item, before, after }) => ({
      before,
      after,
      held: heldElsewhere(context, "memberCalls", item),
      status: item.status,
    }))
    .filter(
      ({ before, after }) =>
        after.length > before.length && !covered.has(after[0].data.module),
    );
  if (gained.length === 0) return [];
  return [
    {
      rule: "RW-M02",
      severity: "medium",
      title: `New MCP tool registrations (${old.length} → ${now.length})`,
      summary: registrationSummary(context, { old, now, gained }),
      why: "Every new tool widens what a connected agent can do.",
      recommendation:
        "Review each new tool's handler and whether it needs human confirmation.",
      evidence: [
        ...gained.flatMap((item) => gainedCalls(context, item)),
        ...serverEvidence(context.right.app),
      ],
      unknowns: [
        "REA does not report tool names, so Release Watch counts registration calls across the component.",
        ...(gained.some((item) => item.held)
          ? [perComponent("tool registration calls")]
          : []),
      ],
    },
  ];
};

// What the release totals cover: they leave out components whose new side
// REA's facts do not describe (`leftOut`), and count the calls of those
// whose old side they do not describe as none (`unknownBefore`).
const totalsScope = (context, release, right) => ({
  except:
    (release.leftOut ?? []).length > 0
      ? ` except ${componentList(release.leftOut)}, whose code REA did not analyze in ${right},`
      : ",",
  before:
    (release.unknownBefore ?? []).length > 0
      ? `; REA did not analyze the code of ${componentList(release.unknownBefore)} of ${oldRelease(context)}, so ${oldRelease(context)} may have made more`
      : "",
});

// A new component's calls are counted against nothing, so the summary
// gives the release's totals rather than calling them more than the old
// release made.
const registrationSummary = (context, { old, now, gained }) => {
  const modules = gained.map((item) => item.after[0].data.module).join(", ");
  const calls = (count, more = "") =>
    `${count} ${more}tool registration call${count === 1 ? "" : "s"}`;
  const release = context.release?.registrations;
  if (context.left.target !== null || !release)
    return `${context.labels.right} makes ${calls(now.length - old.length, "more ")} than ${context.labels.left}, in ${modules}.`;
  const right = context.releaseLabels?.right ?? context.labels.right;
  const cited = gained.reduce(
    (sum, item) => sum + item.after.length - item.before.length,
    0,
  );
  const scope = totalsScope(context, release, right);
  return `Component ${componentName(context, "right")} is new in ${right} and makes ${calls(now.length)}, ${cited === now.length ? "" : `${cited} of them `}in ${modules}; across the release${scope.except} ${oldRelease(context)} made ${release.before} and ${right} makes ${release.after}${scope.before}.`;
};

// The calls a module gained. REA does not identify a tool across releases,
// so in a module that made calls before, the last calls by position stand
// for the new ones and each claim says how many the module has; with how
// the component lacked them when another old component made one in a
// module at this path.
const gainedCalls = (context, { before, after, held, status }) => {
  const notes = [
    held
      ? componentAbsence(context, {
          status,
          held,
          had: "made one in a module at this path",
        })
      : null,
    before.length > 0
      ? `one of ${after.length} in this module, ${before.length} in ${context.labels.left}; Release Watch cannot tell which is new`
      : null,
  ].filter(Boolean);
  const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return [...after]
    .sort((a, b) => startsBefore(a.data.range, b.data.range))
    .slice(before.length)
    .map((call) =>
      cite(
        `${registrationClaim(context.right.app, call)}${note}`,
        call,
        APP_SOURCE,
      ),
    );
};

/** MCP rules; claims the exec sites RW-M01 explains so RW-P01 skips them. */
export const mcpPack = (context) => {
  const execution = toolExecution(context);
  return packResult(
    [...execution.findings, ...newRegistrations(context, execution.modules)],
    { nodes: execution.nodes },
  );
};
