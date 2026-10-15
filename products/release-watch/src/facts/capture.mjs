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

const isDocument = (record) => {
  const mime = record.reported?.response?.content?.mimeType ?? "";
  return (
    record.reported?.request?.method === "GET" && /^text\/html\b/i.test(mime)
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
  state: "observed",
  authority: "historical-reference",
  confidence: "observed",
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
    state: "inferred",
    authority: "rea-analysis-view",
    confidence: "inferred",
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
export const captureFacts = (evidence, apiSurface, name) => {
  const result = evidence.normalized_result;
  const capture = {
    evidence_id: evidence.evidence_id,
    sha256: result.artifact?.sha256 ?? evidence.subject?.digest?.sha256 ?? null,
    name,
  };
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
  };
  for (const record of result.records ?? []) {
    const url = parseUrl(record.reported?.request?.url);
    if (url === null) continue;
    facts.exchanges.push(exchangeFact(capture, record, url));
    if (isDocument(record))
      facts.documents.push(documentFact(capture, record, url));
    facts.cookies.push(...cookiesOf(capture, record, url));
    facts.credentials.push(...credentialsOf(capture, record, url));
  }
  if (apiSurface)
    for (const group of apiSurface.normalized_result?.groups ?? [])
      facts.apiGroups.push(apiGroupFact(capture, apiSurface, group));
  return facts;
};
