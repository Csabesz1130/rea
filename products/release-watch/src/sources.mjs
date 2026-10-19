// Reads single source lines for report display. Lines come from REA's own
// extraction of the analyzed artifact, and are shown as verified only when the
// file's SHA-256 matches the digest REA recorded for that path.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Prepare a reader for one application. `assets` maps relative path to the
 * SHA-256 REA observed for it.
 */
export const openSources = async (rea, appPath, assets, label) => {
  let root = appPath;
  let owned = null;
  if (statSync(appPath).isFile()) {
    const extracted = await rea.run("extract-artifact", [appPath], {
      label: `extract ${label}`,
    });
    if (!extracted.ok)
      return { lineAt: () => null, close: () => {}, error: extracted.error };
    root = extracted.evidence.normalized_result.output_root;
    owned = root;
  }
  const cache = new Map();
  const load = (relative) => {
    if (!cache.has(relative)) {
      const expected = assets.get(relative) ?? null;
      let file = null;
      try {
        const bytes = readFileSync(path.join(root, relative));
        file = {
          // REA counts CR, LF, CRLF, U+2028 and U+2029 as line terminators.
          lines: bytes.toString("utf8").split(/\r\n|\r|\n|\u2028|\u2029/),
          verified: expected !== null && sha256(bytes) === expected,
        };
      } catch {
        file = null;
      }
      cache.set(relative, file);
    }
    return cache.get(relative);
  };
  return {
    lineAt: (relative, line) => {
      const file = line ? load(relative) : null;
      const text = file?.lines[line - 1];
      if (text === undefined) return null;
      return { line, text, verified: file.verified };
    },
    close: () => {
      if (owned !== null) rmSync(owned, { recursive: true, force: true });
    },
    error: null,
  };
};
