// Which hosts a capture's deployment is, from REA capture records through
// the policy: page and cookie pairing, own hosts, and captures REA could not
// read.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pairHelpers, pairRuntimes } from "../src/pairing.mjs";
import { diffApplications, diffCaptures } from "../src/diff.mjs";
import {
  captureFacts,
  captureUnread,
  deploymentHosts,
  deploymentOf,
} from "../src/facts/capture.mjs";
import { evaluateComponent } from "../src/policy.mjs";
import { coverageOf } from "../src/report/coverage.mjs";
import { app, at, evaluate, fact, rules, side } from "./helpers.mjs";

// One component as compare.mjs prepares it: the deployment keys both captures
// before they are compared.
const componentOf = (left, right, extra = {}) => {
  const options = { vendorDomains: [], failOn: "high", ...extra.options };
  const deployment = deploymentOf(
    left.capture,
    right.capture,
    options.vendorDomains,
  );
  return {
    id: "web",
    name: "web",
    left,
    right,
    labels: { left: left.label, right: right.label },
    surfaces: [],
    deployment,
    diff: {
      app: diffApplications(left.app, right.app, new Map()),
      runtimes: pairRuntimes(left, right),
      helpers: pairHelpers(left, right),
      capture: diffCaptures(left.capture, right.capture),
    },
    ...extra,
    options,
  };
};

const pairs = (object) =>
  Object.entries(object).map(([name, value]) => ({ name, value }));

// One HAR entry as REA retains it.
const record = (ordinal, entry) => {
  const { method = "GET", url, status = 200, mime = "text/html" } = entry;
  const location = entry.location ?? "";
  return {
    ordinal,
    reported: {
      request: {
        method,
        url,
        headers: [],
        queryString: [...new URL(url).searchParams].map(([name, value]) => ({
          name,
          value,
        })),
      },
      response: {
        status,
        headers: [
          ...pairs(entry.headers ?? {}),
          ...(location ? [{ name: "Location", value: location }] : []),
        ],
        cookies: entry.cookies ?? [],
        content: { mimeType: mime },
        redirectURL: location,
      },
    },
    redactions: [],
  };
};

const captured = (name, entries) =>
  captureFacts(
    {
      evidence_id: `ev_${name}`,
      confidence: "exact",
      authority: "test",
      normalized_result: {
        format: "har",
        total_records: entries.length,
        records: entries.map((entry, index) => record(index, entry)),
        limitations: [],
      },
    },
    null,
    name,
  );

const HARDENED = {
  "content-security-policy": "default-src 'self'",
  "x-frame-options": "DENY",
};
const strictSid = {
  name: "sid",
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
};
const weakSid = {
  name: "sid",
  httpOnly: false,
  secure: true,
  sameSite: "None",
};
const page = (url, extra = {}) => ({ url, ...extra });
const json = (url, extra = {}) => ({ url, mime: "application/json", ...extra });

const OLD = [
  page("https://app.acme.example/", {
    headers: HARDENED,
    cookies: [strictSid],
  }),
  json("https://app.acme.example/api/notes"),
];

const compare = (oldEntries, newEntries, options = {}) =>
  evaluate(
    side("v1", null, { capture: captured("old.har", oldEntries) }),
    side("v2", null, { capture: captured("new.har", newEntries) }),
    { options },
  );

const titles = (findings) =>
  findings.map((finding) => `${finding.rule} ${finding.title}`).sort();

describe("the deployment without vendor domains", () => {
  it("starts at the first page load, not at a font or consent request before it", () => {
    const findings = compare(OLD, [
      json("https://consent.cmp.example/v2/check"),
      page("https://app.acme.example/", { cookies: [weakSid] }),
      json("https://app.acme.example/api/notes"),
    ]);
    assert.deepEqual(titles(findings), [
      "RW-H02 Security headers removed or changed on /",
      "RW-H04 Cookie sid lost HttpOnly, SameSite=Strict",
      "RW-N01 New third-party destination: consent.cmp.example",
    ]);
  });

  it("follows the first page load's redirects past requests in between", () => {
    const entries = [
      { url: "https://fonts.cdn.example/inter.woff2", mime: "font/woff2" },
      page("https://acme.example/", {
        status: 301,
        location: "https://www.acme.example/",
      }),
      json("https://consent.cmp.example/v2/check"),
      page("https://www.acme.example/"),
    ];
    assert.deepEqual(captured("new.har", entries).startHosts, [
      "acme.example",
      "www.acme.example",
    ]);
    const old = [page("https://acme.example/", { headers: HARDENED })];
    assert.deepEqual(titles(compare(old, entries)), [
      "RW-H02 Security headers removed or changed on /",
      "RW-N01 New third-party destination: consent.cmp.example",
      "RW-N01 New third-party destination: fonts.cdn.example",
    ]);
  });

  it("does not take a later redirect from the site to a partner as the deployment", () => {
    const partner = "https://track.partner.example/c?api_key=FAKE-KEY-0000";
    const findings = compare(OLD, [
      page("https://app.acme.example/", {
        headers: HARDENED,
        cookies: [strictSid],
      }),
      page("https://app.acme.example/r/partner", {
        status: 302,
        location: partner,
      }),
      json(partner),
    ]);
    assert.deepEqual(titles(findings), [
      "RW-H03 Browser sends a credential to track.partner.example",
      "RW-N01 New third-party destination: track.partner.example",
    ]);
  });
});

describe("the deployment with vendor domains", () => {
  it("keys pages and cookies on vendor hosts by path and name whatever was loaded first", () => {
    const idp = "https://login.idp.example/authorize?client_id=acme";
    const newEntries = [
      page(idp),
      json("https://login.idp.example/token?access_token=FAKE-TOKEN-0000", {
        method: "POST",
      }),
      page("https://app.acme.example/", { cookies: [weakSid] }),
    ];
    const vendor = { vendorDomains: ["acme.example"] };
    assert.deepEqual(titles(compare(OLD, newEntries, vendor)), [
      "RW-H02 Security headers removed or changed on /",
      "RW-H03 Browser sends a credential to login.idp.example",
      "RW-H04 Cookie sid lost HttpOnly, SameSite=Strict",
      "RW-N01 New third-party destination: login.idp.example",
    ]);
    const facts = captured("new.har", newEntries);
    assert.deepEqual([...deploymentHosts([facts])], ["login.idp.example"]);
    assert.deepEqual(
      [...deploymentHosts([facts], ["acme.example"])],
      ["app.acme.example"],
    );
    assert.deepEqual(
      [...deploymentHosts([facts], ["other.example"])],
      ["login.idp.example"],
    );
  });

  it("labels a staging page compared with production as Release Watch's pairing", () => {
    const staging = OLD.map((entry) => ({
      ...entry,
      url: entry.url.replace("app.", "staging."),
    }));
    const [h02, h04] = compare(
      staging,
      [page("https://app.acme.example/", { cookies: [weakSid] })],
      { vendorDomains: ["acme.example"] },
    ).filter((finding) => finding.rule.startsWith("RW-H"));
    for (const [finding, what] of [
      [h02, "/ as one page"],
      [h04, "the sid cookie"],
    ])
      assert.deepEqual(
        finding.evidence.filter((line) => line.basis === "heuristic"),
        [
          {
            claim: `Release Watch compares ${what} across staging.acme.example and app.acme.example because each serves the deployment in its capture`,
            basis: "heuristic",
            source: "Release Watch",
            location: null,
            artifact_sha256: null,
            rea_authority: null,
            side: "right",
          },
        ],
      );
  });

  it("compares the captures the report shows over the deployment's keys", () => {
    const staging = OLD.map((entry) => ({
      ...entry,
      url: entry.url.replace("app.", "staging."),
    }));
    const component = componentOf(
      side("v1", null, { capture: captured("old.har", staging) }),
      side("v2", null, {
        capture: captured("new.har", [
          page("https://login.idp.example/authorize"),
          page("https://app.acme.example/", { headers: HARDENED }),
        ]),
      }),
      { options: { vendorDomains: ["acme.example"] } },
    );
    const shown = () =>
      component.diff.capture.documents.map((item) => [
        item.key,
        item.left.length,
        item.right.length,
      ]);
    assert.deepEqual(titles(evaluateComponent(component).findings), [
      "RW-N01 New third-party destination: login.idp.example",
    ]);
    assert.deepEqual(shown(), [
      ["/", 1, 1],
      ["login.idp.example/authorize", 0, 1],
    ]);
  });
});

describe("a capture REA could not read", () => {
  // A side given as a capture only, as discover.mjs targets one.
  const harTarget = (label, file) => ({
    root: `/releases/${label}`,
    kind: "har",
    app: null,
    capture: file,
  });
  const unread = (label, file) =>
    side(label, null, { target: harTarget(label, file) });
  const read = (label, capture) =>
    side(label, null, {
      target: harTarget(label, `/releases/${label}/${capture.name}`),
      capture,
    });
  const run = (left, right) =>
    evaluateComponent(
      componentOf(left, right, { captureBaselineFailed: captureUnread(left) }),
    ).findings;

  it("says so for the old side in RW-C02 and its coverage gaps", () => {
    const left = unread("v1", "/releases/v1/old.har");
    const right = read(
      "v2",
      captured("new.har", [
        page("https://app.acme.example/"),
        json("https://ingest.other.example/e"),
      ]),
    );
    const findings = run(left, right);
    assert.deepEqual(rules(findings), ["RW-C02"]);
    assert.deepEqual(
      findings[0].evidence.map((line) => line.claim),
      [
        "REA could not read the capture given for v1 (old.har), so runtime findings were not compared.",
      ],
    );
    assert.deepEqual(coverageOf({ left, right }).left.gaps, [
      "REA could not read the capture old.har; no runtime facts from it were compared.",
    ]);
  });

  it("says so for the new side", () => {
    const left = read("v1", captured("old.har", OLD));
    const right = unread("v2", "/releases/v2/new.har");
    const findings = run(left, right);
    assert.deepEqual(
      findings.map((finding) => finding.summary),
      [
        "REA could not read the capture given for v2 (new.har), so runtime rules did not run for v2.",
      ],
    );
    assert.deepEqual(coverageOf({ left, right }).right.gaps, [
      "REA could not read the capture new.har; no runtime facts from it were compared.",
    ]);
  });

  it("names the unread old capture in a new destination's unknowns", () => {
    const url = "https://ingest.other.example/e";
    const left = unread("v1", "/releases/v1/old.har");
    left.app = app();
    const right = side(
      "v2",
      app({
        endpoints: [
          fact(
            url,
            { value: url, mechanism: "call:fetch", candidate: false },
            at("app.js", 1),
          ),
        ],
      }),
      { capture: captured("new.har", [page("https://app.acme.example/")]) },
    );
    const n01 = run(left, right).find((finding) => finding.rule === "RW-N01");
    assert.ok(
      n01.unknowns.includes(
        "REA could not read the capture given for v1, so the host may have been contacted at runtime before.",
      ),
      n01.unknowns.join("\n"),
    );
  });
});
