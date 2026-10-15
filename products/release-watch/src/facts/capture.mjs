// Projects `inspect_web_network_capture` Evidence (a HAR, SAZ or mitmproxy
// capture) and its `api-surface` analysis view into runtime facts. Values come
// from REA's retained records; this module reads no capture file itself.
import { isCredentialHeader, isCredentialQuery } from "../catalog.mjs";

const parseUrl = (value) => {
  try {
    return new URL(value);
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

// A page the browser rendered: a successful GET of HTML. Redirects and error
// pages carry different headers and are not compared.
const isDocument = (record) => {
  const mime = record.reported?.response?.content?.mimeType ?? "";
  const status = record.reported?.response?.status ?? 0;
  return (
    record.reported?.request?.method === "GET" &&
    /^text\/html\b/i.test(mime) &&
    status >= 200 &&
    status < 300
  );
};

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

const cookiesOf = (capture, record, url) =>
  (record.reported.response?.cookies ?? [])
    .filter((cookie) => typeof cookie.name === "string")
    .map((cookie) =>
      recordFact(capture, record, cookie.name, {
        host: url.hostname,
        name: cookie.name,
        http_only: cookie.httpOnly === true,
        secure: cookie.secure === true,
        same_site: cookie.sameSite ?? null,
      }),
    );

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
  recordFact(capture, record, url.pathname, {
    origin: url.origin,
    host: url.hostname,
    path: url.pathname,
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
      statuses: group.statuses ?? [],
    },
  };
};

/**
 * Runtime facts from one capture. `name` labels the capture in report lines.
 * `apiSurface` is the optional `inspect-analysis-view` api-surface result.
 */
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
    // The host of the first page the browser loaded: the deployment itself.
    mainHost: null,
  };
  for (const record of result.records ?? []) {
    const url = parseUrl(record.reported?.request?.url);
    if (url === null) continue;
    facts.exchanges.push(exchangeFact(capture, record, url));
    if (isDocument(record)) {
      facts.documents.push(documentFact(capture, record, url));
      facts.mainHost ??= url.hostname;
    }
    facts.cookies.push(...cookiesOf(capture, record, url));
    facts.credentials.push(...credentialsOf(capture, record, url));
  }
  // Pages of the deployment pair by path, so a staging host can be compared
  // with production; pages of other hosts (iframes, sign-in) keep their host.
  for (const document of facts.documents)
    if (document.data.host !== facts.mainHost) {
      document.key = `${document.data.host}${document.data.path}`;
      document.label = document.key;
    }
  if (apiSurface)
    for (const group of apiSurface.normalized_result?.groups ?? [])
      facts.apiGroups.push(apiGroupFact(capture, apiSurface, group));
  return facts;
};
