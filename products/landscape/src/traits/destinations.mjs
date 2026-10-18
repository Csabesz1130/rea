// How a trait cites one destination source Release Watch attributes to a
// host (rules/destinations.mjs owns what counts as a destination and a
// guess), and how sure it is.
import { CAPTURE_SOURCE, factLine, readingLine } from "../evidence.mjs";
import { displayUrl, isGuessSource } from "../release-watch.mjs";

/** True when an REA fact places a request to the host: not a guess, not a build setting. */
export const isSure = (source) =>
  !isGuessSource(source) && source.kind !== "build-setting";

/** The strength a trait resting on these sources has. */
export const strengthOf = (sources) =>
  sources.some(isSure) ? "yes" : "likely";

const CLAIMS = {
  endpoint: (source) => `REA reports an endpoint ${displayUrl(source.url)}`,
  request: (source) => `request to ${displayUrl(source.url)}`,
  "bound-literal": (source) =>
    `a request reads ${source.reads}, which holds ${displayUrl(source.url)}`,
  "module-literal": (source) =>
    `${displayUrl(source.url)} is in a module that sends requests REA did not resolve (a guess)`,
  "client-literal": (source) =>
    `${displayUrl(source.url)} is in code that uses ${source.client.package}, an HTTP client REA does not model (a guess)`,
  capture: (source) =>
    `captured ${source.fact.data.method ?? "request"} ${displayUrl(source.url)}`,
  "build-setting": (source) =>
    `a Go build setting of ${source.helper.name} holds ${displayUrl(source.url)}`,
};

/** The evidence line for one destination source of a component. */
export const destinationLine = (component, source) => {
  const claim = (CLAIMS[source.kind] ?? CLAIMS.endpoint)(source);
  if (source.kind === "capture")
    return factLine(component, claim, source.fact, CAPTURE_SOURCE);
  if (source.kind === "endpoint" || source.kind === "request")
    return factLine(component, claim, source.fact);
  return readingLine(
    component,
    claim,
    source.request?.location ?? source.fact?.location ?? null,
    "Release Watch",
  );
};

/** Evidence lines for a host: its sure sources, else its guesses. */
export const hostLines = (component, sources) => {
  const sure = sources.filter(isSure);
  return (sure.length > 0 ? sure : sources).map((source) =>
    destinationLine(component, source),
  );
};
