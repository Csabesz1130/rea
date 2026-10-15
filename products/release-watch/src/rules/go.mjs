// Rules for native helper executables shipped next to the app, from REA's Go
// build information. Settings and dependencies are compared only when REA
// found Go build information on both sides.
import { displayUrl, hostOf, isUrl, urlsIn } from "../urls.mjs";
import { GO_SOURCE, isVendorHost, packResult, reported } from "./shared.mjs";

// `-X name=value` sets a string variable at link time. The flag may be its
// own quoted field ("-X" "name=value"), a whole field may be quoted
// ("-X=name=value"), and an operand may be quoted and hold spaces. Values
// are shown as display URLs or by length, never verbatim. A field never
// starts with a space, so the spaces before it are read one way only.
const LINKER_VALUE =
  /"-X(?<doubleSeparator>=|\s+)(?<doubleField>(?!\s)[^"]*)"|'-X(?<singleSeparator>=|\s+)(?<singleField>(?!\s)[^']*)'|(?<flag>(?:"-X"|'-X'|-X)(?:=|\s+))(?:'(?<single>[^']*)'|"(?<double>[^"]*)"|(?<bare>(?:[^\s"']+|"[^"]*"?|'[^']*'?)+))/g;

const maskedValue = (value) =>
  isUrl(value) ? displayUrl(value) : `… (${value.length} characters)`;

// `name=value` with the value masked; an operand without `=` is shown.
const maskedOperand = (operand) => {
  const split = operand.indexOf("=");
  return split === -1
    ? operand
    : `${operand.slice(0, split)}=${maskedValue(operand.slice(split + 1))}`;
};

const maskedFlag = (groups) => {
  const { doubleField, singleField, flag, single, double, bare } = groups;
  if (doubleField !== undefined)
    return `"-X${groups.doubleSeparator}${maskedOperand(doubleField)}"`;
  if (singleField !== undefined)
    return `'-X${groups.singleSeparator}${maskedOperand(singleField)}'`;
  const quote = single !== undefined ? "'" : double !== undefined ? '"' : "";
  return `${flag}${quote}${maskedOperand(single ?? double ?? bare)}${quote}`;
};

/** -ldflags for display, with every -X value masked. */
export const displayLdflags = (flags) =>
  flags === null
    ? "not set"
    : flags.replace(LINKER_VALUE, (...match) => maskedFlag(match.at(-1)));

// Build settings that describe the toolchain rather than carry values.
const TOOLCHAIN_SETTINGS = new Set([
  "-buildmode",
  "-compiler",
  "-trimpath",
  "-race",
  "-tags",
  "CGO_ENABLED",
  "GOARCH",
  "GOOS",
  "GOAMD64",
  "GOARM",
  "GOARM64",
  "GO386",
  "GOEXPERIMENT",
  "DefaultGODEBUG",
  "vcs",
  "vcs.revision",
  "vcs.time",
  "vcs.modified",
]);

/** One build setting for display: toolchain settings verbatim, -ldflags masked, others by length. */
export const displaySetting = (key, value) => {
  if (value === null) return "not set";
  if (key === "-ldflags") return displayLdflags(value);
  return TOOLCHAIN_SETTINGS.has(key) ? value : `… (${value.length} characters)`;
};

const hostsIn = (flags) =>
  new Set(
    urlsIn(flags ?? "")
      .map(hostOf)
      .filter(Boolean),
  );

const oldFailed = (helper) => helper.before?.identified === "failed";

// The old helper existed but REA could not read its build information.
const oldBuildUnknown = (helper) =>
  oldFailed(helper)
    ? [
        "REA could not inspect the old helper, so its build information is not established and this may predate the release.",
      ]
    : [];

const ldflagsFindings = (helper, change, context) => {
  const before = hostsIn(change.before);
  const fresh = [...hostsIn(change.after)].filter(
    (host) =>
      !before.has(host) && !isVendorHost(host, context.options.vendorDomains),
  );
  if (fresh.length === 0) return [];
  const oldLine = helper.before?.go
    ? reported(
        `${context.labels.left}: -ldflags ${displayLdflags(change.before)}`,
        "observed",
        GO_SOURCE,
      )
    : reported(
        `${context.labels.left}: ${!helper.before ? "no such helper" : oldFailed(helper) ? "REA could not inspect the helper" : "REA found no Go build information"}`,
        oldFailed(helper) ? "unknown" : "observed",
        GO_SOURCE,
        { side: "left" },
      );
  return [
    {
      hosts: fresh,
      rule: "RW-G01",
      severity: "high",
      title: `Build-time endpoint injected into ${helper.name}: ${fresh.join(", ")}`,
      summary: `${context.labels.right}'s ${helper.relative} was linked with -ldflags that set a third-party URL.`,
      why: "Linker-injected values do not appear in the vendor's source, so code review and SBOMs miss them.",
      recommendation:
        "Ask the vendor which build step adds this flag and what the endpoint receives.",
      evidence: [
        oldLine,
        reported(
          `${context.labels.right}: -ldflags ${displayLdflags(change.after)}`,
          "observed",
          GO_SOURCE,
        ),
      ],
      unknowns: [
        "Build settings record the linker flag; REA does not establish that the helper contacts the endpoint at runtime.",
        ...oldBuildUnknown(helper),
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
      title: `${oldFailed(helper) ? "Dependency" : "New dependency"} compiled into ${helper.name}: ${dependency.path} ${dependency.version}`,
      summary: `${helper.relative} ${oldFailed(helper) ? "embeds" : "now embeds"} ${dependency.path}${unpinned ? " with no module checksum" : ""}.`,
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
      unknowns: oldBuildUnknown(helper),
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

// A helper with Go build information on the new side only (new, or not
// identified before) is graded against nothing: every linker-set
// third-party host the old release never contacted and every dependency
// without a checksum counts.
const firstLook = (helper, context) => {
  const go = helper.after.go;
  const change = {
    key: "-ldflags",
    before: null,
    after: go.settings["-ldflags"] ?? null,
  };
  const known = context.network.known;
  const ldflags =
    change.after === null
      ? []
      : ldflagsFindings(helper, change, context).filter((finding) =>
          finding.hosts.some((host) => !known.has(host)),
        );
  const dependencies = go.dependencies
    .filter((dependency) => dependency.sum === null)
    .flatMap((dependency) =>
      dependencyFindings(helper, { right: [{ data: dependency }] }),
    );
  return [...ldflags, ...dependencies];
};

/** Findings for each helper paired across releases. */
const helperFindings = (context) =>
  context.diff.helpers.flatMap((helper) => {
    const findings = [];
    if (helper.before === null && helper.after !== null)
      findings.push(newHelperFinding(helper, context));
    if (helper.after?.go && !helper.before?.go)
      return [...findings, ...firstLook(helper, context)];
    if (helper.go === null) return findings;
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

/** Helper binary rules. RW-G01 does not claim its hosts: a host the app's code also contacts keeps its RW-N01. */
export const goPack = (context) =>
  packResult(
    helperFindings(context).map(({ hosts: _hosts, ...finding }) => finding),
  );
