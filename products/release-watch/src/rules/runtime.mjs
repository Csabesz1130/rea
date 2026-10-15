// Runtime capture rules, applied when both sides have a capture: security
// header regressions, cookie attribute regressions and credentials that
// browsers send to other parties.
import { SECURITY_HEADERS, aiProviderOf } from "../catalog.mjs";
import {
  CAPTURE_SOURCE,
  captureLabel,
  cite,
  isVendorHost,
  maxSeverity,
  newFacts,
  packResult,
} from "./shared.mjs";

// A header value as compared: per-response CSP nonces masked, whitespace
// collapsed and policy directives in a stable order. Other values verbatim.
const comparable = (name, value) => {
  if (value === null) return null;
  const collapsed = value
    .replace(/'nonce-[^']*'/g, "'nonce-…'")
    .replace(/\s+/g, " ")
    .trim();
  if (name !== "content-security-policy") return collapsed;
  return collapsed
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .sort()
    .join("; ");
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
          evidence: changes.flatMap((change) => [
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
          unknowns: [
            "Release Watch compares header values after masking nonces and ordering directives; it does not grade policy directives.",
          ],
        },
      ];
    });

const SAME_SITE_ORDER = { strict: 2, lax: 1, none: 0 };
const sameSiteRank = (value) =>
  SAME_SITE_ORDER[String(value ?? "").toLowerCase()] ?? null;

// The weakest protection any response in one capture gave a cookie: a
// browser keeps whichever Set-Cookie arrived last, so one weak response is
// enough to expose it.
const weakest = (facts) => {
  const ranks = facts.map((fact) => sameSiteRank(fact.data.same_site));
  const known = ranks.filter((rank) => rank !== null);
  const lowest =
    known.length === ranks.length && known.length > 0
      ? Math.min(...known)
      : null;
  return {
    http_only: facts.every((fact) => fact.data.http_only),
    secure: facts.every((fact) => fact.data.secure),
    // The value as the capture recorded it, from the weakest response.
    same_site:
      lowest === null ? null : facts[ranks.indexOf(lowest)].data.same_site,
    fact:
      facts.find((fact) => !fact.data.http_only || !fact.data.secure) ??
      facts[0],
  };
};

const attributes = (cookie) =>
  `HttpOnly ${cookie.http_only}, Secure ${cookie.secure}, SameSite ${cookie.same_site ?? "unset or mixed"}`;

const cookieFindings = (context) =>
  context.diff.capture.cookies
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) => {
      const before = weakest(item.left);
      const after = weakest(item.right);
      const lost = [];
      if (before.http_only && !after.http_only) lost.push("HttpOnly");
      if (before.secure && !after.secure) lost.push("Secure");
      if (
        before.same_site !== null &&
        after.same_site !== null &&
        sameSiteRank(after.same_site) < sameSiteRank(before.same_site)
      )
        lost.push(`SameSite=${before.same_site}`);
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
          ],
          unknowns: [],
        },
      ];
    });

const credentialFindings = (context) => {
  const { options, network } = context;
  return newFacts(context.diff.capture.credentials).flatMap(({ fact }) => {
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
  if (context.diff.capture === null) return packResult();
  const compared =
    context.left.capture === null
      ? []
      : [...headerFindings(context), ...cookieFindings(context)];
  return packResult([...compared, ...credentialFindings(context)]);
};
