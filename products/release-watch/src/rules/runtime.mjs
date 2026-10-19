// Runtime capture rules, applied when both sides have a capture: security
// header regressions, cookie attribute regressions and credentials that
// browsers send to other parties.
import { SECURITY_HEADERS, aiProviderOf } from "../catalog.mjs";
import {
  CAPTURE_SOURCE,
  captureLabel,
  cite,
  heuristic,
  isVendorHost,
  maxSeverity,
  newFacts,
  packResult,
} from "./shared.mjs";

// Directives whose value is a source list, in which keywords, schemes and
// hosts match ASCII case-insensitively.
const SOURCE_LISTS = new Set([
  "base-uri",
  "child-src",
  "connect-src",
  "default-src",
  "fenced-frame-src",
  "font-src",
  "form-action",
  "frame-ancestors",
  "frame-src",
  "img-src",
  "manifest-src",
  "media-src",
  "navigate-to",
  "object-src",
  "prefetch-src",
  "script-src",
  "script-src-attr",
  "script-src-elem",
  "style-src",
  "style-src-attr",
  "style-src-elem",
  "worker-src",
]);

// One source expression as browsers match it: a keyword, scheme or host in
// lower case. A hash keeps its case-sensitive digest and a host its path.
const sourceExpression = (source) => {
  const hash = /^'(sha256|sha384|sha512)-(.*)'$/i.exec(source);
  if (hash) return `'${hash[1].toLowerCase()}-${hash[2]}'`;
  if (source.startsWith("'")) return source.toLowerCase();
  const authority = /^[^/]*(\/\/[^/]*)?/.exec(source)[0];
  return `${authority.toLowerCase()}${source.slice(authority.length)}`;
};

// A policy as browsers apply it: the first of repeated directives, each
// directive's values as a set, per-response nonces masked.
const policyComparable = (value) => {
  const directives = new Map();
  for (const directive of value
    .replace(/'nonce-[^']*'/gi, "'nonce-…'")
    .split(";")) {
    const [name, ...values] = directive.trim().split(" ").filter(Boolean);
    if (name === undefined || directives.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    const normal = SOURCE_LISTS.has(key)
      ? values.map(sourceExpression)
      : values;
    directives.set(key, [key, ...[...new Set(normal)].sort()].join(" "));
  }
  return [...directives.values()].sort().join("; ");
};

// HSTS directives are case-insensitive and unordered; max-age may be quoted.
const hstsComparable = (value) =>
  value
    .split(";")
    .map((directive) => directive.trim().toLowerCase())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...rest] = directive.split("=");
      const setting = rest
        .join("=")
        .trim()
        .replace(/^"(.*)"$/, "$1");
      return rest.length > 0 ? `${name.trim()}=${setting}` : name.trim();
    })
    .sort()
    .join("; ");

const NORMALIZED = {
  "content-security-policy": policyComparable,
  "strict-transport-security": hstsComparable,
};

// A header value as compared: whitespace collapsed, and a policy in the
// form browsers apply. Other values verbatim.
const comparable = (name, value) => {
  if (value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return NORMALIZED[name] ? NORMALIZED[name](collapsed) : collapsed;
};

/**
 * Security headers the old page sent that the new page dropped or changed,
 * with how much each change costs. Added headers are not changes. `after`
 * may list several loads of the page; the weakest wins: a load without the
 * header, else one with a different value.
 */
export const headerChanges = (before, after) =>
  Object.entries(SECURITY_HEADERS).flatMap(([name, header]) => {
    const was = before[name] ?? null;
    if (was === null) return [];
    const loads = (Array.isArray(after) ? after : [after]).map(
      (headers) => headers[name] ?? null,
    );
    const now = loads.includes(null)
      ? null
      : (loads.find(
          (value) => comparable(name, value) !== comparable(name, was),
        ) ?? was);
    if (now !== null && comparable(name, now) === comparable(name, was))
      return [];
    return [
      {
        name,
        header,
        was,
        now,
        severity: now === null ? header.removed : "medium",
      },
    ];
  });

// Pages and cookies of the deployment pair by path and name across hosts,
// a staging host with production: Release Watch's reading, not REA's.
const pairedAcross = (what, hosts) => {
  const distinct = [...new Set(hosts)];
  return distinct.length > 1
    ? [
        heuristic(
          `Release Watch compares ${what} across ${distinct.join(" and ")} because each serves the deployment in its capture`,
        ),
      ]
    : [];
};

const headerFindings = (context) =>
  context.diff.capture.documents
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) => {
      const [before] = item.left;
      const changes = headerChanges(
        before.data.headers,
        item.right.map((load) => load.data.headers),
      );
      if (changes.length === 0) return [];
      const page = item.right[0].data.display_path ?? item.right[0].data.path;
      const after = (change) =>
        item.right.find(
          (load) => (load.data.headers[change.name] ?? null) === change.now,
        ) ?? item.right[0];
      return [
        {
          rule: "RW-H02",
          severity: maxSeverity(changes.map((change) => change.severity)),
          title: `Security headers removed or changed on ${page}`,
          summary: `${changes.map((change) => change.header.label).join(", ")} differ between the two captures of ${page}${item.right.length > 1 ? ` (${item.right.length} loads compared)` : ""}.`,
          why: "These headers stop script injection, clickjacking and protocol downgrades; losing or loosening one widens what an attacker can do on the page.",
          recommendation:
            "Restore the previous header values, or have the owner justify each change.",
          evidence: [
            ...changes.flatMap((change) => [
              cite(
                `${captureLabel(context.left)}: ${change.header.label}: ${change.was}`,
                before,
                CAPTURE_SOURCE,
                { side: "left" },
              ),
              cite(
                `${captureLabel(context.right)}: ${change.header.label}: ${change.now ?? "(not sent)"}`,
                after(change),
                CAPTURE_SOURCE,
              ),
            ]),
            ...pairedAcross(
              `${page} as one page`,
              [...item.left, ...item.right].map((load) => load.data.host),
            ),
          ],
          unknowns: [
            "Release Watch compares header values after masking CSP nonces, ignoring the order, case and repetition that browsers ignore in CSP and HSTS; it does not grade policy directives.",
          ],
        },
      ];
    });

// SameSite strength as the [weakest, strongest] browsers give it. Without
// the attribute, browsers differ: Chrome treats the cookie as Lax after a
// short grace period, while others may send it cross-site as with None.
const SAME_SITE = { strict: [2, 2], lax: [1, 1], none: [0, 0] };
const UNSET = [0, 1];
const isUnset = (value) =>
  value === null || value === undefined || value === "";
const sameSiteRange = (value) =>
  isUnset(value) ? UNSET : (SAME_SITE[String(value).toLowerCase()] ?? null);

const BROWSER_DEFAULT =
  "Browsers differ on a cookie without SameSite: Chrome treats it as Lax after a short grace period, while other browsers may send it on cross-site requests as with None.";

// The weakest protection any response in one capture gave a cookie: a
// browser keeps whichever Set-Cookie arrived last, so one weak response is
// enough to expose it. An unrecognised SameSite value leaves it unknown.
const weakest = (facts) => {
  const responses = facts.map((fact) => ({
    value: isUnset(fact.data.same_site) ? null : fact.data.same_site,
    range: sameSiteRange(fact.data.same_site),
  }));
  const unrecognised = responses.find(({ range }) => range === null);
  const [weakestResponse] = unrecognised
    ? [unrecognised]
    : [...responses].sort(
        (a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1],
      );
  return {
    http_only: facts.every((fact) => fact.data.http_only),
    secure: facts.every((fact) => fact.data.secure),
    same_site_range: unrecognised
      ? null
      : [0, 1].map((bound) =>
          Math.min(...responses.map(({ range }) => range[bound])),
        ),
    // The value as the capture recorded it, from the weakest response.
    same_site: weakestResponse.value,
    fact:
      facts.find((fact) => !fact.data.http_only || !fact.data.secure) ??
      facts[0],
  };
};

// True when some browser protects the cookie less after than before.
const lostSameSite = (before, after) =>
  before.same_site_range !== null &&
  after.same_site_range !== null &&
  [0, 1].some(
    (bound) => after.same_site_range[bound] < before.same_site_range[bound],
  );

const attributes = (cookie) =>
  `HttpOnly ${cookie.http_only}, Secure ${cookie.secure}, SameSite ${cookie.same_site_range === null ? `${cookie.same_site} (not recognised)` : (cookie.same_site ?? "not set")}`;

const lostAttributes = (before, after) => [
  ...(before.http_only && !after.http_only ? ["HttpOnly"] : []),
  ...(before.secure && !after.secure ? ["Secure"] : []),
  ...(lostSameSite(before, after)
    ? [
        isUnset(before.same_site)
          ? "browser-default SameSite"
          : `SameSite=${before.same_site}`,
      ]
    : []),
];

const cookieFindings = (context) =>
  context.diff.capture.cookies
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) => {
      const before = weakest(item.left);
      const after = weakest(item.right);
      const lost = lostAttributes(before, after);
      if (lost.length === 0) return [];
      return [
        {
          rule: "RW-H04",
          severity: "medium",
          title: `Cookie ${item.key} lost ${lost.join(", ")}`,
          summary: `The ${item.key} cookie set by ${after.fact.data.host} is less protected in ${context.labels.right}.`,
          why: "HttpOnly keeps scripts from reading the cookie, Secure keeps it off plain HTTP, and SameSite limits cross-site requests that carry it.",
          recommendation: "Restore the cookie attributes.",
          evidence: [
            cite(
              `${captureLabel(context.left)}: ${attributes(before)} (${item.left.length} Set-Cookie)`,
              before.fact,
              CAPTURE_SOURCE,
              {
                side: "left",
              },
            ),
            cite(
              `${captureLabel(context.right)}: ${attributes(after)} (${item.right.length} Set-Cookie)`,
              after.fact,
              CAPTURE_SOURCE,
            ),
            ...pairedAcross(
              `the ${item.key} cookie`,
              [...item.left, ...item.right].map((cookie) => cookie.data.domain),
            ),
          ],
          unknowns:
            lostSameSite(before, after) &&
            (isUnset(before.same_site) || isUnset(after.same_site))
              ? [BROWSER_DEFAULT]
              : [],
        },
      ];
    });

const credentialFindings = (context) => {
  const { options, network } = context;
  // A component new in this release is compared with every old capture.
  const known =
    context.left.capture === null
      ? (context.baseline?.credentials ?? new Set())
      : new Set();
  return newFacts(context.diff.capture.credentials).flatMap(({ fact }) => {
    if (known.has(fact.key)) return [];
    const { host, name, field, redacted_by_rea: redacted } = fact.data;
    const provider = aiProviderOf(host);
    const firstParty =
      isVendorHost(host, options.vendorDomains) || network.own.has(host);
    if (firstParty && provider === null) return [];
    return [
      {
        rule: "RW-H03",
        severity: provider ? "critical" : "high",
        title: provider
          ? `Browser sends an API credential to ${provider} (${host})`
          : `Browser sends a credential to ${host}`,
        summary: `In ${captureLabel(context.right)}, a browser request to ${host} carries ${field === "query" ? `the ${name} query parameter` : `the ${name} header`}.`,
        why: "A credential the browser holds can be copied by any user or injected script and used outside the site.",
        recommendation:
          "Move the call behind the vendor's server and rotate the credential.",
        evidence: [
          cite(
            `${fact.data.method} ${fact.data.origin} carries ${name}${redacted ? "; REA redacted its value as a transport credential" : "; the value is in the capture and is not repeated here"} (${context.left.capture ? `not seen in ${captureLabel(context.left)}` : `no capture of ${context.labels.left} to compare`})`,
            fact,
            CAPTURE_SOURCE,
          ),
        ],
        unknowns: redacted
          ? []
          : [
              "Release Watch flags this header or parameter by its name; it cannot tell whether the value is live.",
            ],
      },
    ];
  });
};

/**
 * Capture rules. Credentials the browser sends are graded whenever the new
 * release has a capture; header and cookie regressions need both.
 */
export const runtimePack = (context) => {
  if (context.diff.capture === null || context.captureBaselineFailed)
    return packResult();
  const compared =
    context.left.capture === null
      ? []
      : [...headerFindings(context), ...cookieFindings(context)];
  return packResult([...compared, ...credentialFindings(context)]);
};
