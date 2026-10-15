// Rules for native helper executables shipped next to the app, from REA's Go
// build information. Settings and dependencies are compared only when REA
// found Go build information on both sides.
import { displayUrl, hostOf, isUrl, urlsIn } from "../urls.mjs";
import { GO_SOURCE, isVendorHost, packResult, reported } from "./shared.mjs";

// `-X name=value` sets a string variable at link time. Values are shown as
// display URLs or by length, never verbatim.
const LINKER_VALUE = /(-X[=\s]+'?)([^=\s']+)=([^\s']*)/g;

/** -ldflags for display, with every -X value masked. */
export const displayLdflags = (flags) =>
  flags === null
    ? "not set"
    : flags.replace(
        LINKER_VALUE,
        (_match, flag, name, value) =>
          `${flag}${name}=${isUrl(value) ? displayUrl(value) : `… (${value.length} characters)`}`,
      );

const hostsIn = (flags) =>
  new Set(
    urlsIn(flags ?? "")
      .map(hostOf)
      .filter(Boolean),
  );

const ldflagsFindings = (helper, change, context) => {
  const before = hostsIn(change.before);
  const fresh = [...hostsIn(change.after)].filter(
    (host) =>
      !before.has(host) && !isVendorHost(host, context.options.vendorDomains),
  );
  if (fresh.length === 0) return [];
  return [
    {
      rule: "RW-G01",
      severity: "high",
      title: `Build-time endpoint injected into ${helper.name}: ${fresh.join(", ")}`,
      summary: `${context.labels.right}'s ${helper.relative} was linked with -ldflags that set a third-party URL.`,
      why: "Linker-injected values do not appear in the vendor's source, so code review and SBOMs miss them.",
      recommendation:
        "Ask the vendor which build step adds this flag and what the endpoint receives.",
      evidence: [
        reported(
          `${context.labels.left}: -ldflags ${displayLdflags(change.before)}`,
          "observed",
          GO_SOURCE,
        ),
        reported(
          `${context.labels.right}: -ldflags ${displayLdflags(change.after)}`,
          "observed",
          GO_SOURCE,
        ),
      ],
      unknowns: [
        "Build settings record the linker flag; REA does not establish that the helper contacts the endpoint at runtime.",
      ],
    },
  ];
};

const dependencyFindings = (helper, item) =>
  item.right.map((fact) => {
    const dependency = fact.data;
    const unpinned = dependency.sum === null;
    return {
      rule: "RW-G02",
      severity: "medium",
      title: `New dependency compiled into ${helper.name}: ${dependency.path} ${dependency.version}`,
      summary: `${helper.relative} now embeds ${dependency.path}${unpinned ? " with no module checksum" : ""}.`,
      why: unpinned
        ? "Without a recorded checksum the binary does not tie this code to a published module version, which is how vendored or patched code hides."
        : "New third-party code in a privileged helper should be reviewed like any dependency change.",
      recommendation:
        "Check the module against your dependency policy and its upstream source.",
      evidence: [
        reported(
          `Module ${dependency.path} ${dependency.version}, checksum ${dependency.sum ?? "not recorded"}${dependency.replacement ? `, replaced by ${dependency.replacement.path}` : ""}`,
          "observed",
          GO_SOURCE,
        ),
      ],
      unknowns: [],
    };
  });

const trimpathFinding = (helper, change, context) =>
  change.before === "true" && change.after === null
    ? [
        {
          rule: "RW-G03",
          severity: "low",
          title: `${helper.name} is no longer built with -trimpath`,
          summary: `${context.labels.right} embeds build-machine paths in ${helper.relative}.`,
          why: "A changed build configuration often means a changed build pipeline; it also leaks build host paths.",
          recommendation:
            "Confirm the release came from the vendor's usual pipeline.",
          evidence: [
            reported(
              `-trimpath: ${change.before} → not set`,
              "observed",
              GO_SOURCE,
            ),
          ],
          unknowns: [],
        },
      ]
    : [];

// A helper executable the old release did not ship.
const newHelperFinding = (helper, context) => {
  const go = helper.after.go;
  return {
    rule: "RW-G04",
    severity: "medium",
    title: `New native helper: ${helper.relative}`,
    summary: `${context.labels.right} ships an executable that ${context.labels.left} did not.`,
    why: "A new executable runs outside the app's JavaScript sandbox with the user's privileges.",
    recommendation:
      "Ask the vendor what the helper does, when it runs and what it contacts.",
    evidence: go
      ? [
          reported(
            `Go ${go.go_version ?? "version unknown"}, main module ${go.main ?? "unknown"}, ${go.dependencies.length} dependencies`,
            "observed",
            GO_SOURCE,
          ),
          ...Object.entries(go.settings)
            .filter(([key]) => key === "-ldflags")
            .map(([, value]) =>
              reported(
                `-ldflags ${displayLdflags(value)}`,
                "observed",
                GO_SOURCE,
              ),
            ),
        ]
      : [
          reported(
            `${helper.relative} is an executable file in the release`,
            "observed",
            "Release Watch discovery",
          ),
        ],
    unknowns: go
      ? []
      : [
          "REA found no Go build information; Release Watch did not analyze this executable further.",
        ],
  };
};

/** Findings for each helper paired across releases. */
const helperFindings = (context) =>
  context.diff.helpers.flatMap((helper) => {
    if (helper.before === null && helper.after !== null)
      return [newHelperFinding(helper, context)];
    if (helper.go === null) return [];
    const findings = [];
    for (const change of helper.go.settings) {
      if (change.key === "-ldflags")
        findings.push(...ldflagsFindings(helper, change, context));
      if (change.key === "-trimpath")
        findings.push(...trimpathFinding(helper, change, context));
    }
    for (const item of helper.go.dependencies)
      if (item.status === "added")
        findings.push(...dependencyFindings(helper, item));
    return findings;
  });

/** Helper binary rules. */
export const goPack = (context) => packResult(helperFindings(context));
