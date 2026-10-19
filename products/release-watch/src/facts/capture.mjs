// Projects `inspect_web_network_capture` Evidence (a HAR, SAZ or mitmproxy
// capture) and its `api-surface` analysis view into runtime facts. Values come
// from REA's retained records; this module reads no capture file itself.
import { isCredentialHeader, isCredentialQuery } from "../catalog.mjs";
import { isVendorHost } from "../rules/shared.mjs";
import { displayPath } from "../urls.mjs";

const parseUrl = (value, base) => {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
};

const headerMap = (headers) =>
  Object.fromEntries(
    (headers ?? [])
      .filter((header) => typeof header.name === "string")
      .map((header) => [header.name.toLowerCase(), header.value]),
  );

const statusOf = (record) => record.reported?.response?.status ?? 0;
const isRedirect = (record) =>
  statusOf(record) >= 300 && statusOf(record) < 400;

// A page load: a GET answered with HTML, whatever its status. A HAR does not
// mark which request the address bar made, so Release Watch reads the first
// page load as the start of the session.
const isPageLoad = (record) =>
  record.reported?.request?.method === "GET" &&
  /^text\/html\b/i.test(record.reported?.response?.content?.mimeType ?? "");

// A page the browser rendered: a successful page load. Redirects and error
// pages carry different headers and are not compared.
const isDocument = (record) =>
  isPageLoad(record) && statusOf(record) >= 200 && statusOf(record) < 300;

// Provenance shared by every fact from one capture record.
const recordFact = (capture, record, key, data) => ({
  key,
  label: key,
  node_id: `${capture.evidence_id}#${record.ordinal}`,
  location: {
    file: capture.name,
    line: null,
    column: null,
    record: record.ordinal,
  },
  state: capture.state,
  authority: capture.authority,
  confidence: capture.confidence,
  artifact_sha256: capture.sha256,
  data,
});

// Credential-bearing request fields: REA's own redactions of transport
// credentials, plus header and query names the catalog lists, which REA keeps.
const credentialsOf = (capture, record, url) => {
  const request = record.reported.request;
  const found = [];
  for (const redaction of record.redactions ?? []) {
    const match = /^\/request\/headers\/(\d+)\/value$/.exec(
      redaction.pointer ?? "",
    );
    const name = match ? request.headers?.[Number(match[1])]?.name : null;
    if (
      name &&
      name.toLowerCase() !== "cookie" &&
      redaction.reason === "transport-credential"
    )
      found.push({ field: "header", name, redacted_by_rea: true });
  }
  for (const header of request.headers ?? [])
    if (isCredentialHeader(header.name) && header.value !== null)
      found.push({
        field: "header",
        name: header.name,
        redacted_by_rea: false,
      });
  for (const parameter of request.queryString ?? [])
    if (isCredentialQuery(parameter.name) && parameter.value !== null)
      found.push({
        field: "query",
        name: parameter.name,
        redacted_by_rea: false,
      });
  return found.map((credential) =>
    recordFact(
      capture,
      record,
      `${url.hostname}#${credential.field}:${credential.name.toLowerCase()}`,
      {
        ...credential,
        host: url.hostname,
        origin: url.origin,
        method: request.method,
      },
    ),
  );
};

// A cookie's scope: its Domain attribute without the leading dot, else the
// host that set it.
const cookieDomain = (cookie, url) =>
  typeof cookie.domain === "string" && cookie.domain !== ""
    ? cookie.domain.replace(/^\./, "").toLowerCase()
    : url.hostname;

const cookiesOf = (capture, record, url) =>
  (record.reported.response?.cookies ?? [])
    .filter((cookie) => typeof cookie.name === "string")
    .map((cookie) =>
      recordFact(
        capture,
        record,
        `${cookieDomain(cookie, url)}#${cookie.name}`,
        {
          host: url.hostname,
          domain: cookieDomain(cookie, url),
          name: cookie.name,
          http_only: cookie.httpOnly === true,
          secure: cookie.secure === true,
          same_site: cookie.sameSite ?? null,
        },
      ),
    );

// Where a redirect response points, from the HAR's redirectURL or Location,
// without a fragment, which the browser does not send.
const redirectTarget = (record, url) => {
  const response = record.reported.response ?? {};
  if (!isRedirect(record)) return null;
  const location =
    response.redirectURL ||
    (response.headers ?? []).find(
      (header) => String(header.name).toLowerCase() === "location",
    )?.value;
  const target = location ? parseUrl(location, url) : null;
  if (target === null) return null;
  target.hash = "";
  return target.href;
};

// The hosts the session started on: the first page load, then each request
// its 3xx responses lead to (an apex to www, a sign-in hop). The chain ends
// at its first response that is not a redirect, so a later redirect from the
// site to another party does not extend it.
const sessionStart = (entries) => {
  const hosts = [];
  let index = entries.findIndex(({ record }) => isPageLoad(record));
  while (index !== -1) {
    const { record, url } = entries[index];
    if (!hosts.includes(url.hostname)) hosts.push(url.hostname);
    const target = redirectTarget(record, url);
    if (target === null) break;
    index = nextRequestFor(entries, index, target);
  }
  return hosts;
};

// The first GET of `href` after record `index`, or -1.
const nextRequestFor = (entries, index, href) => {
  for (let at = index + 1; at < entries.length; at += 1)
    if (
      entries[at].record.reported.request.method === "GET" &&
      entries[at].url.href === href
    )
      return at;
  return -1;
};

const exchangeFact = (capture, record, url) =>
  recordFact(capture, record, url.hostname, {
    host: url.hostname,
    origin: url.origin,
    method: record.reported.request.method,
    path: url.pathname,
    status: record.reported.response?.status ?? null,
    mime: record.reported.response?.content?.mimeType ?? null,
  });

const documentFact = (capture, record, url) =>
  recordFact(capture, record, `${url.hostname}${url.pathname}`, {
    origin: url.origin,
    host: url.hostname,
    path: url.pathname,
    display_path: displayPath(url.pathname),
    headers: headerMap(record.reported.response?.headers),
  });

const apiGroupFact = (capture, view, group) => {
  const key = `${group.method} ${group.origin}${group.path_template}`;
  return {
    key,
    label: key,
    node_id: `${view.evidence_id}#${key}`,
    location: {
      file: capture.name,
      line: null,
      column: null,
      record: group.record_ordinals?.[0] ?? null,
    },
    state: view.confidence ?? "unknown",
    authority: view.authority ?? "unknown",
    confidence: view.confidence ?? "unknown",
    artifact_sha256: capture.sha256,
    data: {
      method: group.method,
      origin: group.origin,
      path_template: group.path_template,
      display: `${group.method} ${group.origin}${displayPath(group.path_template)}`,
      statuses: group.statuses ?? [],
    },
  };
};

/**
 * The hosts that serve the reviewed site in a component's captures. With
 * vendor domains, the vendor hosts the captures loaded pages from, whatever
 * they requested first. Without vendor domains, or when no capture loaded a
 * page on one, where each session started: the redirect chain of its first
 * page load.
 */
export const deploymentHosts = (captures, vendorDomains = []) => {
  const present = captures.filter(Boolean);
  const started = present.flatMap((capture) => capture.startHosts);
  if (vendorDomains.length === 0) return new Set(started);
  const vendor = present
    .flatMap((capture) => [...capture.startHosts, ...capture.pageHosts])
    .filter((host) => isVendorHost(host, vendorDomains));
  return new Set(vendor.length > 0 ? vendor : started);
};

const rekey = (fact, key) => {
  fact.key = key;
  fact.label = key;
};

/**
 * Key pages and cookies of the deployment `own` by path and name, so a
 * staging host pairs with production; those of other hosts (iframes, third
 * parties) keep their host. Keys derive from the facts' data alone.
 */
export const keyByDeployment = (capture, own) => {
  const ownScope = (domain) =>
    [...own].some((host) => host === domain || host.endsWith(`.${domain}`));
  for (const document of capture.documents)
    rekey(
      document,
      own.has(document.data.host)
        ? document.data.path
        : `${document.data.host}${document.data.path}`,
    );
  for (const cookie of capture.cookies)
    rekey(
      cookie,
      ownScope(cookie.data.domain)
        ? cookie.data.name
        : `${cookie.data.domain}#${cookie.data.name}`,
    );
  return capture;
};

/**
 * Decides one component's deployment from both captures and keys both
 * captures by it, before they are compared. Returns the deployment hosts.
 */
export const deploymentOf = (left, right, vendorDomains = []) => {
  const own = deploymentHosts([left, right], vendorDomains);
  for (const capture of [left, right])
    if (capture) keyByDeployment(capture, own);
  return own;
};

/** True when a side names a capture that REA was asked to read and produced no facts from. */
export const captureUnread = (side) =>
  side.target !== null &&
  side.target.kind !== "unknown" &&
  typeof side.target.capture === "string" &&
  side.capture === null;

// REA's own labels for the capture records: retained producer evidence.
const captureIdentity = (evidence, name) => ({
  evidence_id: evidence.evidence_id,
  sha256:
    evidence.normalized_result.artifact?.sha256 ??
    evidence.subject?.digest?.sha256 ??
    null,
  name,
  state: evidence.confidence ?? "unknown",
  authority: evidence.authority ?? "unknown",
  confidence: evidence.confidence ?? "unknown",
});

/**
 * Runtime facts from one capture. `name` labels the capture in report lines.
 * `apiSurface` is the optional `inspect-analysis-view` api-surface result.
 * Pages and cookies are keyed by host until `keyByDeployment` keys them by
 * the deployment, which needs both captures of a component.
 */
export const captureFacts = (evidence, apiSurface, name) => {
  const result = evidence.normalized_result;
  const capture = captureIdentity(evidence, name);
  const facts = {
    ...capture,
    format: result.format ?? null,
    total_records: result.total_records ?? 0,
    limitations: result.limitations ?? [],
    exchanges: [],
    documents: [],
    cookies: [],
    credentials: [],
    apiGroups: [],
    // The hosts the session started on, in redirect order.
    startHosts: [],
    // Every host a page load went to, in capture order.
    pageHosts: [],
    // What Release Watch itself could not examine in this capture.
    gaps: [],
  };
  const entries = [];
  for (const record of result.records ?? []) {
    const url = parseUrl(record.reported?.request?.url);
    if (url === null) continue;
    entries.push({ record, url });
    facts.exchanges.push(exchangeFact(capture, record, url));
    if (isPageLoad(record) && !facts.pageHosts.includes(url.hostname))
      facts.pageHosts.push(url.hostname);
    if (isDocument(record))
      facts.documents.push(documentFact(capture, record, url));
    facts.cookies.push(...cookiesOf(capture, record, url));
    facts.credentials.push(...credentialsOf(capture, record, url));
  }
  facts.startHosts = sessionStart(entries);
  if (apiSurface)
    for (const group of apiSurface.normalized_result?.groups ?? [])
      facts.apiGroups.push(apiGroupFact(capture, apiSurface, group));
  return facts;
};
