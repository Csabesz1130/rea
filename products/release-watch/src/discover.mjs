// Locates the parts of one release that Release Watch hands to REA. It only
// lists files; REA decides what each selected file is.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const LIBRARY = /\.(so(\.\d+)*|dylib|dll|pak|dat|bin|json|html|txt)$/i;
const HELPER_SEARCH_DEPTH = 4;

const isExecutableFile = (file) => {
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats?.isFile() === true && (stats.mode & 0o111) !== 0;
};

const executablesIn = (directory, depth, skip) => {
  if (depth < 0 || !existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (skip.has(full)) continue;
    if (entry.isDirectory())
      found.push(...executablesIn(full, depth - 1, skip));
    else if (
      entry.isFile() &&
      !LIBRARY.test(entry.name) &&
      isExecutableFile(full)
    )
      found.push(full);
  }
  return found.sort();
};

/**
 * Describe a release root: an Electron distribution directory, an extracted
 * application directory, or a single .asar file.
 */
export const discoverRelease = (input) => {
  const root = path.resolve(input);
  const stats = statSync(root, { throwIfNoEntry: false });
  if (stats === undefined)
    throw new Error(`Release path does not exist: ${root}`);
  if (stats.isFile())
    return { root, app: root, runtimeCandidates: [], helpers: [] };
  if (existsSync(path.join(root, "package.json")))
    return { root, app: root, runtimeCandidates: [], helpers: [] };

  const resources = path.join(root, "resources");
  const asar = path.join(resources, "app.asar");
  const directory = path.join(resources, "app");
  const app = existsSync(asar)
    ? asar
    : existsSync(directory)
      ? directory
      : null;
  const runtimeCandidates = executablesIn(root, 0, new Set());
  const helpers = executablesIn(
    resources,
    HELPER_SEARCH_DEPTH,
    new Set([directory, `${asar}.unpacked`]),
  );
  return { root, app, runtimeCandidates, helpers };
};
