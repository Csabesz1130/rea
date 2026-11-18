// Traits for data leaving the machine, from the hosts Release Watch
// attributes to one component (rules/destinations.mjs) and the packages its
// modules import: remote hosts, telemetry services, update checks and plain
// HTTP.
import {
  isUpdateHost,
  isUpdatePackage,
  telemetryHost,
  telemetryPackage,
  telemetryWord,
} from "../catalog.mjs";
import { factLine, readingLine } from "../evidence.mjs";
import { LOCAL, displayUrl, packageNameOf } from "../release-watch.mjs";
import { TRAITS } from "./definitions.mjs";
import { hostLines, isSure, strengthOf } from "./destinations.mjs";
import { clientReason, runtimeImports } from "./runtime.mjs";

const catalogLine = (part, text) =>
  readingLine(part.name, `${text} (Landscape's catalog)`);

const hostTraits = (part, set, host, sources) => {
  const strength = strengthOf(sources);
  const lines = hostLines(part.name, sources);
  set.add(TRAITS.remote, { strength, evidence: lines, values: [host] });
  const telemetry = telemetryHost(host);
  const word = telemetry ? null : telemetryWord(host);
  if (telemetry || word)
    set.add(TRAITS.telemetry, {
      strength: telemetry ? strength : "likely",
      evidence: [
        catalogLine(
          part,
          telemetry
            ? `${host} is ${telemetry.service}'s ${telemetry.kind} service`
            : `${host}'s name says ${word}`,
        ),
        ...lines,
      ],
      values: [telemetry ? telemetry.service : host],
    });
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
            `${fact.data.module} imports ${fact.key}, which sends ${telemetry.kind} to ${telemetry.service} (Landscape's catalog)`,
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
            `${fact.data.module} imports ${fact.key}, which checks for newer versions (Landscape's catalog)`,
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
