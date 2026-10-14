// Rules for native helper executables shipped next to the app.
import { hostOf, isVendorHost, reported, urlsIn } from "./shared.mjs";

const GO_SOURCE = "REA inspect_go_binary";

const ldflagsFindings = (helper, change, context) => {
  const urls = urlsIn(change.after);
  const thirdParty = urls.filter((url) => {
    const host = hostOf(url);
    return host !== null && !isVendorHost(host, context.options.vendorDomains);
  });
  if (thirdParty.length === 0) return [];
  const hosts = [...new Set(thirdParty.map(hostOf))].join(", ");
  return [
    {
      rule: "RW-G01",
      severity: "high",
      title: `Build-time endpoint injected into ${helper.name}: ${hosts}`,
      summary: `${context.labels.right}'s ${helper.relative} was linked with -ldflags that set a third-party URL.`,
      why: "Linker-injected values do not appear in the vendor's source, so code review and SBOMs miss them.",
      recommendation:
        "Ask the vendor which build step adds this flag and what the endpoint receives.",
      evidence: [
        reported(
          `${context.labels.left}: -ldflags ${change.before === null ? "not set" : change.before}`,
          "observed",
          GO_SOURCE,
        ),
        reported(
          `${context.labels.right}: -ldflags ${change.after}`,
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

/** Findings for each helper paired across releases. */
export const helperFindings = (context) =>
  context.diff.helpers.flatMap((helper) => {
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
