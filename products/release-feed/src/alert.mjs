// Alerts for entries that need a person: one JSON POST per entry to a
// webhook. The webhook's URL usually carries its secret, so it comes from
// the environment and is never written to a file or a log.
import { severityRank } from "../../release-watch/src/rules/shared.mjs";
import { headlineOf, textOf } from "./site.mjs";
import { writeEntry } from "./state.mjs";

const TIMEOUT_MS = 15000;
// Failures that mean the release itself needs a look, whatever the threshold.
const ALWAYS = new Set(["integrity-mismatch", "unsafe-entry"]);

/** The thresholds --alert-on takes: a severity, or "never". */
export const THRESHOLDS = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
  "never",
];

const due = (entry, threshold) =>
  entry.alert?.sent_at === undefined &&
  (entry.status === "compared"
    ? entry.changes.count > 0 &&
      severityRank(entry.changes.highest) >= severityRank(threshold)
    : ALWAYS.has(entry.reason));

/**
 * Sends one alert for each of `entries` that is due: compared, with a
 * change at or above `threshold` (a note on what could not be examined
 * alerts nobody), or failed because a tarball's integrity
 * changed or it held an unsafe entry; and not alerted before. The body is
 * `{ text, entry }`. Each entry records the outcome (`alert.sent_at`, or
 * `alert.failed_at` with the HTTP status or the error's name), so a failed
 * delivery is tried again on the next run. Returns `{ sent, failed }`.
 */
export const sendAlerts = async (
  work,
  entries,
  { url, threshold, baseUrl },
) => {
  let sent = 0;
  let failed = 0;
  if (!url || threshold === "never") return { sent, failed };
  for (const entry of entries.filter((item) => due(item, threshold))) {
    const link =
      baseUrl && entry.status === "compared"
        ? `\n${baseUrl}/${entry.report.split("/").map(encodeURIComponent).join("/")}/report.html`
        : "";
    let outcome;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `${textOf(entry)}${link}`,
          title: headlineOf(entry),
          entry,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      outcome = response.ok
        ? { sent_at: new Date().toISOString() }
        : { failed_at: new Date().toISOString(), status: response.status };
    } catch (error) {
      // The error's message can hold the URL; its name cannot.
      outcome = { failed_at: new Date().toISOString(), error: error.name };
    }
    writeEntry(work, { ...entry, alert: outcome });
    if (outcome.sent_at) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
};
