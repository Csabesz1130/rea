// Evidence lines and unknowns for a destination host, one table entry per
// kind of source that shows it, most direct first.
import { displayUrl } from "../urls.mjs";
import { assignedName } from "./destinations.mjs";
import {
  APP_SOURCE,
  CAPTURE_SOURCE,
  GO_SOURCE,
  cite,
  heuristic,
  reported,
} from "./shared.mjs";

const MAX_LINES = 8;

const literalLine = (source, url) => {
  const name = assignedName(source.fact);
  return cite(
    `URL literal ${url}${name ? ` assigned to ${name}` : ""}`,
    source.fact,
    APP_SOURCE,
  );
};
// How a URL literal relates to code that uses an HTTP client REA does not
// model: the client module holds it, or imports it (directly or through
// re-exports).
const clientLine = ({ fact, client }) => {
  const unmodeled = `${client.package}, an HTTP client whose requests REA does not model`;
  const where = {
    self: `${client.module} imports ${unmodeled}`,
    imports: `${client.module} imports ${unmodeled}, and imports the value ${fact.data.module} assigns to ${assignedName(fact)}`,
  }[client.via];
  return heuristic(
    `${where}, so Release Watch takes this URL as a possible destination`,
  );
};
const requestLine = (source) =>
  cite(
    `${source.request.data.method}() request in ${source.request.data.module}`,
    source.request,
    APP_SOURCE,
  );

// Evidence lines per source kind, most direct first.
const SOURCE_LINES = {
  capture: (source, url) => [
    cite(
      `${source.fact.data.method} ${url} answered ${source.fact.data.status ?? "without a status"} at runtime`,
      source.fact,
      CAPTURE_SOURCE,
    ),
  ],
  endpoint: (source, url) => [
    cite(
      `${source.fact.data.mechanism ?? "request"} to ${url}`,
      source.fact,
      APP_SOURCE,
    ),
  ],
  request: (source, url) => [
    cite(
      `${source.fact.data.method}() request to ${url}`,
      source.fact,
      APP_SOURCE,
    ),
  ],
  "bound-literal": (source, url) => [
    requestLine(source),
    literalLine(source, url),
    heuristic(
      `The request reads ${source.reads} inside its call; REA reports the read and the assignment, Release Watch connects them`,
      source.read.location,
    ),
  ],
  "module-literal": (source, url) => [
    requestLine(source),
    literalLine(source, url),
    heuristic(
      "Release Watch attributes the request to this URL only because they share a module",
    ),
  ],
  "client-literal": (source, url) => [
    literalLine(source, url),
    clientLine(source),
  ],
  "build-setting": (source, url) => [
    reported(
      `${source.helper.relative} is linked with a build setting that contains ${url}`,
      "observed",
      GO_SOURCE,
    ),
  ],
};
const ORDER = Object.keys(SOURCE_LINES);

/** Evidence lines for one host's sources, most direct first. */
export const sourceEvidence = (sources, labels) => {
  const seen = new Set();
  const lines = [];
  for (const source of [...sources].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  )) {
    const identity = `${source.kind}:${source.url}:${source.fact?.node_id ?? source.helper?.relative}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    lines.push(...SOURCE_LINES[source.kind](source, displayUrl(source.url)));
  }
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > shown.length)
    shown.push(
      heuristic(
        `${lines.length - shown.length} more evidence lines for this host in ${labels.right}`,
      ),
    );
  return shown;
};

/** What a host's sources cannot establish. */
export const sourceUnknowns = (sources) => {
  const unknowns = [];
  if (sources.some((source) => source.kind === "bound-literal"))
    unknowns.push(
      "REA did not resolve the request's URL argument; the request reads a variable assigned this URL, which code may change.",
    );
  if (sources.some((source) => source.kind === "module-literal"))
    unknowns.push(
      "REA did not resolve the request's URL argument; the destination is a URL literal in the same module.",
    );
  if (sources.some((source) => source.kind === "client-literal"))
    unknowns.push(
      "REA does not model requests through this HTTP client, so the URL is a possible destination, not an observed one.",
    );
  if (sources.every((source) => source.kind === "capture"))
    unknowns.push(
      "A capture records one session; it does not show which code sends the request or what other paths contact.",
    );
  if (sources.every((source) => source.kind === "build-setting"))
    unknowns.push(
      "A build setting records the value; REA does not establish that the program contacts it.",
    );
  return unknowns;
};
