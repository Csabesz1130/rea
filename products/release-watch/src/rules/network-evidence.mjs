// Evidence lines and unknowns for a destination host, one table entry per
// kind of source that shows it, most direct first, and what else the code
// sending to it does.
import { startsBefore, within } from "../ranges.mjs";
import { displayUrl } from "../urls.mjs";
import { assignedName, sourceModule } from "./destinations.mjs";
import {
  enclosingFunction,
  indexOf,
  inside,
  memberOn,
  scopeOf,
} from "./reach-index.mjs";
import { declaredFunction } from "./reach-region.mjs";
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

const MAX_TIMERS = 3;

// The request sites a host's sources rest on.
const requestsOf = (sources) =>
  sources.flatMap((source) =>
    source.request
      ? [source.request]
      : source.kind === "request"
        ? [source.fact]
        : [],
  );

// The functions REA reports around a request, innermost first.
const enclosingChain = (index, request) => {
  const chain = [];
  for (
    let fn = enclosingFunction(index, request.data.module, request.data.range);
    fn;
    fn = index.byId.get(scopeOf(index, fn))
  )
    chain.push(fn);
  return chain;
};

// The function a binding read inside a timer's call names, when REA's
// binding facts declare one (declaredFunction), else null.
// A read REA reports a member of (`Client.poll`) names that member, and a
// class is no code a timer runs.
const readFunction = (index, module, { read }) => {
  if (read.data.parameter || !read.data.binding_range) return null;
  if (memberOn(index, module, read.data.range)) return null;
  const fn = declaredFunction(index, module, {
    name: read.data.name,
    range: read.data.binding_range,
    owner: read.data.binding_owner ?? null,
  });
  return fn?.kind === "class" ? null : fn;
};

// How a timer REA reports relates to one request, by REA's facts: the
// request is written inside the timer's call, the timer's call reads a
// binding declared as a function around the request, or both sit in one
// function. Null when none does.
const timerTie = (index, timer, { request, chain }) => {
  const { module, range } = timer.data;
  if (!range || !request.data.range || module !== request.data.module)
    return null;
  if (within(request.data.range, range)) return { kind: "inline" };
  const around = new Set(chain.map((fn) => fn.id));
  const read = inside(index.reads.get(module), range).find((item) =>
    around.has(readFunction(index, module, item)?.id),
  );
  if (read) return { kind: "named", name: read.read.data.name };
  return chain[0] && enclosingFunction(index, module, range)?.id === chain[0].id
    ? { kind: "shared" }
    : null;
};

const timerClaim = (timer, tie) => {
  const { module, method } = timer.data;
  if (tie.kind === "inline")
    return `${module} sends the request from inside a ${method}() call; REA reports the timer and the request, Release Watch relates them by position`;
  if (tie.kind === "named")
    return `${module} schedules ${tie.name}, a function around the request, with ${method}(); REA reports the timer's read of ${tie.name} and its declaration, Release Watch relates them`;
  return `${module} calls ${method}() in the function that sends the request; Release Watch relates them because REA places both in that function`;
};

/**
 * Timers Release Watch relates to a host's requests through REA's facts
 * (timerTie), at most MAX_TIMERS lines and a count of the rest, each
 * labelled as Release Watch's correlation.
 */
const timerEvidence = (sources, app) => {
  if (!app) return [];
  const index = indexOf(app);
  const requests = requestsOf(sources)
    .filter((request) => request.data.range)
    .map((request) => ({ request, chain: enclosingChain(index, request) }));
  if (requests.length === 0) return [];
  const lines = app.timers
    .flatMap((timer) => {
      const tie = requests
        .map((entry) => timerTie(index, timer, entry))
        .find(Boolean);
      return tie ? [{ timer, tie }] : [];
    })
    .sort(
      (a, b) =>
        a.timer.data.module.localeCompare(b.timer.data.module) ||
        startsBefore(a.timer.data.range, b.timer.data.range),
    )
    .map(({ timer, tie }) => heuristic(timerClaim(timer, tie), timer.location));
  const shown = lines.slice(0, MAX_TIMERS);
  if (lines.length > shown.length)
    shown.push(
      heuristic(
        `${lines.length - shown.length} more timers Release Watch relates to these requests the same way`,
      ),
    );
  return shown;
};

/**
 * What else the sending modules do: timers that repeat the request
 * (timerEvidence), and host or user APIs they import.
 */
export const contextEvidence = (sources, app) => {
  if (!app) return [];
  const modules = new Set(sources.map(sourceModule).filter(Boolean));
  const lines = timerEvidence(sources, app);
  for (const modulePath of modules) {
    const imports = app.modules.get(modulePath)?.externalImports ?? new Set();
    if (imports.has("node:os") || imports.has("os"))
      lines.push(
        heuristic(
          `${modulePath} imports node:os, which exposes host and user account details`,
        ),
      );
  }
  return lines;
};
