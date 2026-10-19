// Network rules: new destination hosts, requests with no destination REA
// resolved and cleartext channels, graded against what the whole old
// release contacted (destinations.mjs owns that attribution).
import { shippedBefore, unaccounted } from "../moves.mjs";
import {
  globalLimitClause,
  unexaminedLimits,
  unexaminedVerb,
} from "./unexamined.mjs";
import { unexaminedNote } from "./unknown-moves.mjs";
import {
  contextEvidence,
  sourceEvidence,
  sourceUnknowns,
} from "./network-evidence.mjs";
import { renamedFrom } from "../diff.mjs";
import { captureUnread } from "../facts/capture.mjs";
import { unexaminedIn } from "../facts/coverage.mjs";
import { rerunWith } from "../limits.mjs";
import { displayUrl, schemeOf } from "../urls.mjs";
import {
  LOCAL,
  contactSchemes,
  destinationsOf,
  guessedHosts,
  isGuess,
  isGuessSource,
  isUpgradeRedirect,
  knownHosts,
  mergeSchemes,
  namedHosts,
  sourceModules,
  withoutDestination,
} from "./destinations.mjs";
import { unknownElsewhere } from "./component-absence.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  isVendorHost,
  oldRelease,
  packResult,
} from "./shared.mjs";

/**
 * The network view shared by the network, AI and web packs: hosts the new
 * side contacts that nothing REA saw in the old release references (in any
 * component), hosts the old release only guessed at, how it reached each
 * host, and `own`, the deployment's hosts (`deploymentHosts`).
 */
export const networkView = (
  left,
  right,
  baseline = { hosts: new Set() },
  { ignoreCapture = false, own = new Set() } = {},
) => {
  const known = new Set([...knownHosts(left), ...baseline.hosts]);
  const guessed = new Set([...guessedHosts(left), ...(baseline.guessed ?? [])]);
  // Without a readable old capture, hosts seen only at runtime cannot be compared.
  const current = destinationsOf(right, { includeCapture: !ignoreCapture });
  // The deployment's own origin is the site itself, not a destination. A
  // host the old release only guessed at is new once the new release
  // contacts it, and not new while it is still only a guess.
  const fresh = new Map(
    [...current].filter(
      ([host, sources]) =>
        !known.has(host) &&
        !own.has(host) &&
        !(guessed.has(host) && sources.every(isGuessSource)),
    ),
  );
  return {
    known,
    named: new Set([...namedHosts(left), ...(baseline.named ?? [])]),
    guessed,
    current,
    fresh,
    own,
    // Code that moved between components keeps the channels it had.
    leftSchemes: mergeSchemes(contactSchemes(left), baseline.schemes),
  };
};

/**
 * How the old release's absence of a host is known, as a clause about the
 * host: always bounded by REA's coverage, and a host the old release held
 * a URL for is never called unseen.
 */
export const hostAbsence = (context, host) =>
  context.network.guessed.has(host)
    ? `${oldRelease(context)}'s analyzed code held a URL for ${host} only next to requests REA could not resolve or does not model`
    : `${host} was not seen in ${oldRelease(context)}'s analyzed code${context.left.capture ? " or capture" : ""}`;

/** The unknowns every new-host claim carries when REA cannot establish the old release's absence. */
export const absenceUnknowns = (context, host) => [
  ...(context.left.app?.coverage.semantic === "complete" &&
  context.left.app?.coverage.graph === "complete"
    ? []
    : [
        `REA's coverage of ${oldRelease(context)} is incomplete, so it does not establish that it never contacted this host.`,
      ]),
  // Hosts are compared with the whole old release, so an old component REA
  // has no facts for may have contacted this one.
  ...[unknownElsewhere(context)]
    .filter(Boolean)
    .map((unknown) => `${unknown}, so it may have contacted this host.`),
  ...(context.left.capture === null && context.right.capture !== null
    ? [
        captureUnread(context.left)
          ? `REA could not read the capture given for ${context.labels.left}, so the host may have been contacted at runtime before.`
          : `No capture of ${oldRelease(context)} was provided, so the host may have been contacted at runtime before.`,
      ]
    : []),
  // The old code referred to the host, but REA saw no request to it.
  ...(context.network.guessed.has(host)
    ? [
        `${oldRelease(context)}'s code held a URL for ${host} next to requests REA could not resolve or does not model, so it may have contacted it in a way REA did not see.`,
      ]
    : []),
  ...(context.network.named.has(host)
    ? [
        `${oldRelease(context)}'s code held the name ${host} as a string, so it may have contacted it in a way REA did not see.`,
      ]
    : []),
];

const isFirstParty = (host, context) =>
  isVendorHost(host, context.options.vendorDomains) ||
  context.network.own.has(host);

// Why a new host matters. A guessed one is a possible recipient only.
const destinationWhy = (context, { firstParty, guess }) => {
  if (firstParty)
    return "New network behaviour on the vendor's own domain is usually a feature.";
  const pattern = `data leaving to a host REA did not see ${oldRelease(context)} contact is the pattern seen in compromised updates and undisclosed data sharing.`;
  return guess
    ? `Release Watch did not see a request to this host, only its URL. If the code does send data there, ${pattern}`
    : `${pattern[0].toUpperCase()}${pattern.slice(1)}`;
};

const destinationFinding = (host, sources, context) => {
  const { labels } = context;
  const firstParty = isFirstParty(host, context);
  const guess = isGuess(sources);
  const runtime = sources.some((source) => source.kind === "capture");
  return {
    rule: "RW-N01",
    severity: firstParty ? "low" : guess ? "medium" : "high",
    title: `${guess ? "Possible new" : "New"} ${firstParty ? "first-party" : "third-party"} destination: ${host}`,
    summary: guess
      ? `${labels.right} holds a URL for ${host} next to requests REA could not resolve or does not model; ${hostAbsence(context, host)}.`
      : `${labels.right} sends requests to ${host}${runtime ? " (seen at runtime)" : ""}; ${hostAbsence(context, host)}.`,
    why: destinationWhy(context, { firstParty, guess }),
    recommendation: firstParty
      ? "Confirm the feature in the release notes."
      : guess
        ? "Ask the vendor whether the code sends data to this host and what it sends; block the release until the recipient is named or allow-listed."
        : "Block the release until the vendor names the recipient and the data sent, or the host is allow-listed.",
    evidence: [
      ...sourceEvidence(sources, labels),
      ...contextEvidence(sources, context.right.app),
    ],
    unknowns: [...sourceUnknowns(sources), ...absenceUnknowns(context, host)],
  };
};

// URL literals in a request's module, shown as candidates, never as the
// request's established destination.
const candidateLines = (app, request) =>
  app.urlLiterals
    .filter((literal) => literal.data.module === request.data.module)
    .slice(0, 3)
    .map((literal) =>
      heuristic(
        `Candidate destination: URL literal ${displayUrl(literal.data.url)} in the same module`,
        literal.location,
      ),
    );

// What an old request REA could not see in the new release was, for the
// note that a new one may be it, moved (unknown-moves.mjs).
const UNEXAMINED = {
  kind: "request",
  had: (fact) =>
    `had a ${fact.data.method}() request without a known destination`,
};

// Why the old count of a module's sites is not established, as a clause
// about the old release (unexamined.mjs words facts/coverage.mjs
// unexaminedIn's reason), with the node limits REA reached there
// (`{ text, limits }`), or null: the module's old file (its old path when
// renamed) is one REA did not fully examine, or REA's global node limit
// leaves every old file partial.
const oldGap = (context, unexamined, item, module) => {
  const paths =
    item.left.length > 0
      ? item.left.map((fact) => fact.data.module)
      : [renamedFrom(context.aliases)(module) ?? module];
  const file = paths.find((path) => unexamined.files.has(path));
  const label = context.labels.left;
  if (file) {
    const reason = unexamined.files.get(file);
    return {
      text: `REA ${unexaminedVerb([reason])} ${file} in ${label}`,
      limits: unexaminedLimits(reason),
    };
  }
  return unexamined.anyFile
    ? { text: globalLimitClause(label), limits: ["maxSemanticNodes"] }
    : null;
};

// Title, summary and recommendation of RW-N02: a count REA established
// for the old module is a claim of new sites; one it did not is "not
// observed".
const unresolvedWording = (context, { fact, old, sites, gap }) => {
  const where = `${fact.data.method}() sites in ${fact.data.module} without a known destination`;
  const release = oldRelease(context);
  return gap === null
    ? {
        title: `New request with an unresolved destination in ${fact.data.module}`,
        summary: `${context.labels.right} has ${where} that no removed site of ${release} accounts for (${old} → ${sites} in this module).`,
        recommendation:
          "Capture the release's traffic or ask the vendor for the destination.",
      }
    : {
        title: `Request with an unresolved destination not observed in ${release}: ${fact.data.module}`,
        summary: `${context.labels.right} has ${where} that no removed site REA observed in ${release} accounts for (${old} observed → ${sites} in this module), but ${gap.text}, so Release Watch cannot tell whether any is new.`,
        // What a re-run would raise is limits.mjs's (rerunWith); no limit
        // stopped REA on a file it could not analyze, so none is named.
        recommendation:
          gap.limits.length > 0
            ? `Re-run with ${rerunWith(context.options?.analysis, gap.limits).text} so the old code is examined, capture the release's traffic, or ask the vendor for the destination.`
            : "Capture the release's traffic or ask the vendor for the destination; REA could not analyze the old code, which higher limits do not change.",
      };
};

// Request sites without a known destination (withoutDestination: REA
// resolved none and Release Watch binds no URL literal to them) that a
// module gained, which no removed site of the release accounts for (code
// that moved between modules or components) and no other finding explains
// (another pack's claim, or a new host whose URL shares their module).
// Sites with a known destination, resolved or bound, added next to them are
// graded by their host instead. Every open site of a module shares the
// same explanations, so the count of gained ones does not depend on which
// site the moves took as gained. A module whose old file REA did not fully
// examine has no established old count, so its sites are "not observed".
const unresolvedRequests = (context, explained) => {
  const before = withoutDestination(context.left.app);
  const after = withoutDestination(context.right.app);
  const unexamined = unexaminedIn(context.left.app);
  return context.diff.app.requests.flatMap((item) => {
    const open = item.right.filter(
      (fact) =>
        after(fact) &&
        !context.claimed.nodes.has(fact.node_id) &&
        !explained.has(fact.node_id),
    );
    const added = unaccounted(context.moves.requests, open).length;
    if (added === 0) return [];
    const [fact] = open;
    const gap = oldGap(context, unexamined, item, fact.data.module);
    return [
      {
        rule: "RW-N02",
        severity: "medium",
        ...unresolvedWording(context, {
          fact,
          old: item.left.filter(before).length,
          sites: open.length,
          gap,
        }),
        why: "Unexplained outbound traffic is the main exfiltration path for compromised updates.",
        evidence: [
          ...open.map((site) =>
            cite(
              `${site.data.method}() request in ${site.data.module}`,
              site,
              APP_SOURCE,
            ),
          ),
          ...candidateLines(context.right.app, fact),
        ],
        unknowns: [
          `REA did not resolve the destination${open.length > 1 ? "s" : ""}, and ${open.length > 1 ? "the requests read" : "the request reads"} no URL literal Release Watch can bind ${open.length > 1 ? "them" : "it"} to${open.length > added ? "; Release Watch cannot tell which site is new" : ""}.`,
          ...unexaminedNote(context, context.moves.requests, open, UNEXAMINED),
        ],
      },
    ];
  });
};

const CLEARTEXT = new Set(["http", "ws"]);

// A cleartext channel's summary and why: a URL Release Watch only takes as
// a possible destination is worded as one.
const cleartextWording = (context, { host, schemes, before, guess }) => {
  const encrypted =
    before.size > 0
      ? `; ${oldRelease(context)} reached it only over encrypted connections`
      : "";
  return guess
    ? {
        title: `Possible cleartext connection to ${host}`,
        summary: `${context.labels.right} holds a URL for ${host} that uses ${schemes}, which Release Watch takes as a possible destination${encrypted}.`,
        why: "Release Watch did not see a request to this URL. If the code connects there, the traffic is unencrypted and can be read and changed by anyone on the network path.",
      }
    : {
        title: `Cleartext connection to ${host}`,
        summary: `${context.labels.right} reaches ${host} over ${schemes}${encrypted}.`,
        why: "Unencrypted traffic can be read and changed by anyone on the network path.",
      };
};

// A host the new side reaches over http:// or ws:// that the old release
// never reached in cleartext, from code that did not move unchanged from
// it: a source counts unless every module it rests on (the request's, the
// URL constant's, the client's) has the content of a file the old release
// shipped.
const cleartextChannels = (context) => {
  const unchanged = shippedBefore(context.baseline, context.right.app);
  const moved = (source) => {
    const modules = sourceModules(source);
    return modules.length > 0 && modules.every(unchanged);
  };
  return [...context.network.current]
    .filter(([host]) => !LOCAL.test(host))
    .flatMap(([host, sources]) => {
      // A URL that only shares a module with a request is not a channel.
      const plain = sources.filter(
        (source) =>
          CLEARTEXT.has(schemeOf(source.url)) &&
          source.kind !== "module-literal" &&
          !isUpgradeRedirect(source) &&
          !moved(source),
      );
      if (plain.length === 0) return [];
      const before = context.network.leftSchemes.get(host) ?? new Set();
      if ([...before].some((scheme) => CLEARTEXT.has(scheme))) return [];
      const schemes = [
        ...new Set(plain.map((source) => schemeOf(source.url))),
      ].join(" and ");
      return [
        {
          rule: "RW-N03",
          severity: "medium",
          ...cleartextWording(context, {
            host,
            schemes,
            before,
            guess: isGuess(plain),
          }),
          recommendation: "Use https:// or wss://.",
          evidence: sourceEvidence(plain, context.labels),
          unknowns: sourceUnknowns(plain),
        },
      ];
    });
};

// A host known only from a URL literal next to an unresolved request is a
// guess. A third-party guess still gets RW-N01, labelled as one; a
// first-party guess does not, and its request stays an RW-N02 candidate.

/** RW-N01 for new hosts no other pack claimed, RW-N02 for unresolved requests, RW-N03 for cleartext. */
export const networkPack = (context) => {
  const reported = [...context.network.fresh]
    .filter(([host]) => !context.claimed.hosts.has(host))
    .filter(([, sources]) =>
      sources.some((source) => source.kind !== "build-setting"),
    )
    .filter(
      ([host, sources]) => !isGuess(sources) || !isFirstParty(host, context),
    );
  const explained = new Set(
    [
      ...reported,
      ...[...context.network.fresh].filter(([host]) =>
        context.claimed.hosts.has(host),
      ),
    ]
      .flatMap(([, sources]) => sources)
      .map((source) => source.request?.node_id)
      .filter(Boolean),
  );
  return packResult([
    ...reported.map(([host, sources]) =>
      destinationFinding(host, sources, context),
    ),
    ...unresolvedRequests(context, explained),
    ...cleartextChannels(context),
  ]);
};
