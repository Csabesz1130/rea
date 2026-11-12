// Traits for data leaving the machine, from the hosts Release Watch
// attributes to one component (rules/destinations.mjs) and the packages its
// modules import: remote hosts, telemetry services, update checks and plain
// HTTP.
import {
  isUpdateHost,
  isUpdatePackage,
  telemetryHost,
  telemetryName,
  telemetryPackage,
  telemetryWord,
} from "../catalog.mjs";
import { factLine, readingLine } from "../evidence.mjs";
import {
  LOCAL,
  assignedName,
  displayUrl,
  importClaim,
  packageNameOf,
} from "../release-watch.mjs";
import { TRAITS } from "./definitions.mjs";
import {
  destinationLine,
  hostLines,
  isSure,
  strengthOf,
} from "./destinations.mjs";
import { clientReason, runtimeImports } from "./runtime.mjs";

const catalogLine = (part, text) =>
  readingLine(part.name, `${text} (Landscape's catalog)`);

// The requests Release Watch ties to a variable or property holding the
// host's address (rules/destinations.mjs, "bound-literal") whose name says
// telemetry: the name the request reads, or the one the address is assigned
// to where it is defined (an import may rename it). Each with the name and
// its word.
const telemetryReads = (sources) =>
  sources.flatMap((source) => {
    if (source.kind !== "bound-literal") return [];
    const name = [source.reads, assignedName(source.fact)].find(
      (candidate) => telemetryName(candidate) !== null,
    );
    return name ? [{ source, name, word: telemetryName(name) }] : [];
  });

// Telemetry a host's sources suggest: a service the catalog knows, which
// is as sure as the request to it; else, as a guess, a host whose own name
// says telemetry, or a request that reads its address from a variable
// whose name does.
const telemetryOf = (part, host, sources) => {
  const service = telemetryHost(host);
  if (service)
    return {
      strength: strengthOf(sources),
      evidence: [
        catalogLine(
          part,
          `${host} is ${service.service}'s ${service.kind} service`,
        ),
        ...hostLines(part.name, sources),
      ],
      values: [service.service],
    };
  const word = telemetryWord(host);
  if (word)
    return {
      strength: "likely",
      evidence: [
        catalogLine(part, `${host}'s name says ${word}`),
        ...hostLines(part.name, sources),
      ],
      values: [host],
    };
  const reads = telemetryReads(sources);
  if (reads.length === 0) return null;
  return {
    strength: "likely",
    evidence: reads.flatMap(({ source, name, word: said }) => [
      catalogLine(
        part,
        `the request's address is held in ${name}, a name that says ${said}`,
      ),
      destinationLine(part.name, source),
    ]),
    values: [host],
  };
};

const hostTraits = (part, set, host, sources) => {
  const strength = strengthOf(sources);
  const lines = hostLines(part.name, sources);
  set.add(TRAITS.remote, { strength, evidence: lines, values: [host] });
  const telemetry = telemetryOf(part, host, sources);
  if (telemetry) set.add(TRAITS.telemetry, telemetry);
  if (isUpdateHost(host))
    set.add(TRAITS.updates, {
      strength,
      evidence: [
        catalogLine(part, `${host} serves package versions`),
        ...lines,
      ],
      values: [host],
    });
  const plain = sources.filter(
    (source) => isSure(source) && source.url?.startsWith("http:"),
  );
  if (plain.length > 0)
    set.add(TRAITS.plainHttp, {
      evidence: plain.map((source) =>
        readingLine(
          part.name,
          `contacts ${displayUrl(source.url)} without TLS`,
          source.fact?.location ?? null,
          "Release Watch",
        ),
      ),
      values: [host],
    });
};

const packageTraits = (part, set) => {
  for (const fact of runtimeImports(part.app)) {
    const name = packageNameOf(fact.key);
    const telemetry = telemetryPackage(name);
    if (telemetry)
      set.add(TRAITS.telemetry, {
        evidence: [
          factLine(
            part.name,
            `${importClaim(fact)}, which sends ${telemetry.kind} to ${telemetry.service} (Landscape's catalog)`,
            fact,
          ),
        ],
        values: [telemetry.service],
      });
    if (isUpdatePackage(name))
      set.add(TRAITS.updates, {
        evidence: [
          factLine(
            part.name,
            `${importClaim(fact)}, which checks for newer versions (Landscape's catalog)`,
            fact,
          ),
        ],
        values: [name],
      });
  }
  const unmodeled = clientReason(part.app);
  if (unmodeled) set.unknownBecause(TRAITS.remote, unmodeled);
};

/** Record one component's data traits. */
export const readData = (part, set) => {
  for (const [host, sources] of part.destinations)
    if (!LOCAL.test(host)) hostTraits(part, set, host, sources);
  if (part.app) packageTraits(part, set);
};

/**
 * A product that calls a hosted AI model contacts a remote host, also when
 * it calls through an SDK whose host REA's facts do not name.
 */
export const deriveData = (set) => {
  const hosted = set
    .entries()
    .find((entry) => entry.definition.id === TRAITS.hostedModel.id);
  if (!hosted) return;
  set.add(TRAITS.remote, {
    strength: hosted.yes.length > 0 ? "yes" : "likely",
    evidence: [
      readingLine(
        null,
        `calls ${[...hosted.values].join(", ")}, hosted AI providers`,
      ),
    ],
  });
};
