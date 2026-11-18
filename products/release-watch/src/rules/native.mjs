// Native executables and libraries a release ships, compared by content.
// REA says what each file is (format, architecture, digest, the rustc
// commit of a Rust build); nothing here reads what native code does, so a
// file with new content is either new native code (RW-B01) or changed code
// that was not examined (RW-C07, a coverage note).
import { packResult, reported } from "./shared.mjs";

export const NATIVE_SOURCE = "REA inspect_rust_binary";
const MAX_FILES = 6;

const listed = (files) =>
  `${files.slice(0, MAX_FILES).join(", ")}${files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : ""}`;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// What REA says a native file is, in a few words, or why it said nothing.
const kindOf = (native) =>
  native.format === null
    ? `REA could not inspect it (${native.error?.code ?? "no result"})`
    : [
        native.format,
        native.architecture,
        native.rustc.length > 0 ? "built with Rust" : null,
      ]
        .filter(Boolean)
        .join(" ");

/**
 * The native files of the new release whose content the old release did
 * not ship under any path: `fresh` at a path the old release had no native
 * file at, `changed` at one it had, each with the old file as `before`.
 * A file REA could not inspect is compared by Release Watch's own digest.
 * `unread` are files of either side that could not be read at all, and
 * `uninspected` those beyond the number Release Watch looks at; with
 * either, a digest the old release shipped may be missing, so `complete`
 * is false and a file called fresh may only have moved.
 */
export const nativeChanges = (context) => {
  const before = context.left.natives ?? [];
  const after = context.right.natives ?? [];
  const shipped = new Set(before.map((native) => native.sha256));
  const byPath = new Map(before.map((native) => [native.relative, native]));
  const helpers = new Set(
    (context.right.helpers ?? []).map((helper) => helper.relative),
  );
  const fresh = [];
  const changed = [];
  for (const native of after) {
    if (native.sha256 === null || shipped.has(native.sha256)) continue;
    const old = byPath.get(native.relative) ?? null;
    if (old !== null) changed.push({ ...native, before: old });
    // A new helper executable is RW-G04's to report.
    else if (!helpers.has(native.relative)) fresh.push(native);
  }
  const statuses = [context.left.nativeStatus, context.right.nativeStatus];
  const unread = [...before, ...after].filter(
    (native) => native.sha256 === null,
  );
  const uninspected = statuses.reduce(
    (total, status) =>
      total + (status?.uninspected.length ?? 0) + (status?.unnamed ?? 0),
    0,
  );
  return {
    fresh,
    changed,
    unread,
    uninspected,
    complete: unread.length === 0 && uninspected === 0,
  };
};

// The source of a file's digest: REA's Evidence, or Release Watch's own
// reading when REA inspected nothing.
const sourceOf = (native) =>
  native.format === null ? "Release Watch" : NATIVE_SOURCE;

const line = (native) =>
  reported(
    `${native.relative}: ${kindOf(native)}, sha256 ${native.sha256}`,
    "observed",
    sourceOf(native),
  );

// RW-B01: native code the old release did not ship.
const freshFinding = (context, { fresh, complete }) =>
  fresh.length === 0
    ? []
    : [
        {
          rule: "RW-B01",
          severity: "high",
          title: `New native code: ${listed(fresh.map((native) => native.relative))}`,
          summary: `${context.labels.right} ships ${plural(fresh.length, "native file")} whose content ${context.labels.left} did not ship under any path.`,
          why: "Native code runs with every right of the process that loads it, and this report does not say what it does.",
          recommendation:
            "Ask the vendor what each file is for and how it is built, and compare its digest with one the vendor publishes.",
          evidence: fresh.slice(0, MAX_FILES).map(line),
          unknowns: [
            "Release Watch reads what a native file is, not what its code does.",
            ...(complete
              ? []
              : [
                  `Some native files of ${context.labels.left} or ${context.labels.right} were not inspected, so a file listed here may have moved rather than be new.`,
                ]),
          ],
        },
      ];

/** Native code rules. */
export const nativePack = (context) =>
  packResult(freshFinding(context, nativeChanges(context)));

const changedLine = (native) =>
  reported(
    `${native.relative}: ${kindOf(native)}, sha256 ${native.before.sha256} before, ${native.sha256} now${
      native.rustc.join() === native.before.rustc.join()
        ? ""
        : `; rustc commit ${native.before.rustc.join(", ") || "not found"} before, ${native.rustc.join(", ") || "not found"} now`
    }`,
    "observed",
    sourceOf(native),
  );

/**
 * RW-C07: native files whose content changed, or that could not be
 * inspected, so what the release's native code does was not compared.
 */
export const nativeCoverage = (context) => {
  const { changed, unread, uninspected } = nativeChanges(context);
  if (changed.length + unread.length + uninspected === 0) return [];
  const parts = [
    changed.length > 0
      ? `${plural(changed.length, "native file")} of ${context.labels.left} ${changed.length === 1 ? "has" : "have"} other content in ${context.labels.right} (${listed(changed.map((native) => native.relative))})`
      : null,
    unread.length > 0
      ? `${listed([...new Set(unread.map((native) => native.relative))])} could not be read`
      : null,
    uninspected > 0
      ? `${plural(uninspected, "native file")} beyond the number Release Watch inspects ${uninspected === 1 ? "was" : "were"} not compared`
      : null,
  ].filter(Boolean);
  return [
    {
      rule: "RW-C07",
      severity: "high",
      title:
        changed.length > 0
          ? `Native code changed in ${context.labels.right} and was not examined`
          : `Native files of ${context.labels.right} were not compared`,
      summary: `${parts.join("; ")}. Release Watch reads what a native file is and, for a Go helper, what it was built from; it does not read what native code does.`,
      why: "A change inside a native library is invisible to every other rule of this report. A pass is meaningful only for code that was examined.",
      recommendation:
        "Compare each file's digest with one the vendor publishes for this release, or review the files with a disassembler.",
      evidence: [
        ...changed.slice(0, MAX_FILES).map(changedLine),
        ...[...new Set(unread.map((native) => native.relative))]
          .slice(0, MAX_FILES)
          .map((file) =>
            reported(`${file}: could not be read`, "observed", "Release Watch"),
          ),
      ],
      unknowns: [
        "Release Watch cannot tell what the changed native code does.",
      ],
    },
  ];
};
