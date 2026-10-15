// Runtime capture rules, applied when both sides have a capture: security
// header regressions, cookie attribute regressions and credentials that
// browsers send to other parties. Header values are compared verbatim.
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

const headerFindings = (context) =>
  context.diff.capture.documents
    .filter((item) => item.left.length > 0 && item.right.length > 0)
    .flatMap((item) => {
      const [before] = item.left;
      const [after] = item.right;
      const changes = Object.entries(SECURITY_HEADERS).flatMap(
        ([name, header]) => {
          const was = before.data.headers[name] ?? null;
          const now = after.data.headers[name] ?? null;
          if (was === null || was === now) return [];
          return [
            {
              name,
              header,
              was,
              now,
              severity: now === null ? header.removed : "medium",
            },
          ];
        },
      );
      if (changes.length === 0) return [];
      return [
        {
          rule: "RW-H02",
          severity: maxSeverity(changes.map((change) => change.severity)),
          title: `Security headers removed or changed on ${after.data.path}`,
          summary: `${changes.map((change) => change.header.label).join(", ")} differ between the two captures of ${after.data.path}.`,
          why: "These headers stop script injection, clickjacking and protocol downgrades; losing or loosening one widens what an attacker can do on the page.",
          recommendation:
            "Restore the previous header values, or have the owner justify each change.",
          evidence: changes.flatMap((change) => [
            cite(
              `${captureLabel(context.left)}: ${change.header.label}: ${change.was}`,
              before,
              CAPTURE_SOURCE,
            ),
            cite(
              `${captureLabel(context.right)}: ${change.header.label}: ${change.now ?? "(not sent)"}`,
              after,
              CAPTURE_SOURCE,
            ),
          ]),
          unknowns: [
            "Release Watch compares header values verbatim; it does not grade policy directives.",
          ],
        },
      ];
    });

const SAME_SITE_ORDER = { strict: 2, lax: 1, none: 0 };

const cookieFindings = (context) =>
  context.diff.capture.cookies
    .filter((item) => item.status === "changed")
    .flatMap((item) => {
      const [before] = item.left;
      const [after] = item.right;
      const lost = [];
      if (before.data.http_only && !after.data.http_only) lost.push("HttpOnly");
      if (before.data.secure && !after.data.secure) lost.push("Secure");
      const rank = (value) =>
        SAME_SITE_ORDER[String(value ?? "").toLowerCase()] ?? null;
      if (
        rank(before.data.same_site) !== null &&
        rank(after.data.same_site) !== null &&
        rank(after.data.same_site) < rank(before.data.same_site)
      )
        lost.push(`SameSite=${before.data.same_site}`);
      if (lost.length === 0) return [];
      return [
        {
          rule: "RW-H04",
          severity: "medium",
          title: `Cookie ${after.data.name} lost ${lost.join(", ")}`,
          summary: `The ${after.data.name} cookie set by ${after.data.host} is less protected in ${context.labels.right}.`,
          why: "HttpOnly keeps scripts from reading the cookie, Secure keeps it off plain HTTP, and SameSite limits cross-site requests that carry it.",
          recommendation: "Restore the cookie attributes.",
          evidence: [
            cite(
              `${captureLabel(context.left)}: HttpOnly ${before.data.http_only}, Secure ${before.data.secure}, SameSite ${before.data.same_site ?? "unset"}`,
              before,
              CAPTURE_SOURCE,
            ),
            cite(
              `${captureLabel(context.right)}: HttpOnly ${after.data.http_only}, Secure ${after.data.secure}, SameSite ${after.data.same_site ?? "unset"}`,
              after,
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
            `${fact.data.method} ${fact.data.origin} carries ${name}${redacted ? "; REA redacted its value as a transport credential" : "; the value is in the capture and is not repeated here"} (not seen in ${captureLabel(context.left)})`,
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

/** Capture rules, or nothing when either side lacks a capture. */
export const runtimePack = (context) =>
  context.diff.capture === null
    ? packResult()
    : packResult([
        ...headerFindings(context),
        ...cookieFindings(context),
        ...credentialFindings(context),
      ]);
