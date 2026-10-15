// Locates the parts of a release that Release Watch hands to REA. It only
// lists files and reads the release manifest; REA decides what each selected
// file is.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const LIBRARY = /\.(so(\.\d+)*|dylib|dll|pak|dat|bin|json|html|txt)$/i;
const HELPER_SEARCH_DEPTH = 4;
const WEB_OUTPUT_DIRECTORIES = ["dist", "build", "out", "public"];
export const MANIFEST = "release-watch.json";

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

const target = (root, kind, reason, inputs = {}) => ({
  root,
  kind,
  reason,
  app: inputs.app ?? null,
  capture: inputs.capture ?? null,
  runtimeCandidates: inputs.runtimeCandidates ?? [],
  helpers: inputs.helpers ?? [],
});

const electronTarget = (root) => {
  const resources = path.join(root, "resources");
  const asar = path.join(resources, "app.asar");
  const directory = path.join(resources, "app");
  const app = existsSync(asar)
    ? asar
    : existsSync(directory)
      ? directory
      : null;
  if (app === null) return null;
  return target(root, "electron-dist", `found ${path.relative(root, app)}`, {
    app,
    runtimeCandidates: executablesIn(root, 0, new Set()),
    helpers: executablesIn(
      resources,
      HELPER_SEARCH_DEPTH,
      new Set([directory, `${asar}.unpacked`]),
    ),
  });
};

const webTarget = (root) => {
  if (existsSync(path.join(root, "index.html")))
    return target(root, "web-build", "found index.html", { app: root });
  for (const name of WEB_OUTPUT_DIRECTORIES) {
    const candidate = path.join(root, name);
    if (existsSync(path.join(candidate, "index.html")))
      return target(root, "web-build", `found ${name}/index.html`, {
        app: candidate,
      });
  }
  return null;
};

/**
 * Describe one release component: an Electron distribution directory, a
 * JavaScript app directory, a built web app, an .asar file or a HAR capture.
 * `kind` is "unknown" when nothing analyzable was found.
 */
export const discoverTarget = (input, { capture = null } = {}) => {
  const root = path.resolve(input);
  const stats = statSync(root, { throwIfNoEntry: false });
  if (stats === undefined)
    throw new Error(`Release path does not exist: ${root}`);
  const withCapture = (found) => ({
    ...found,
    capture: capture === null ? found.capture : path.resolve(capture),
  });
  if (stats.isFile()) {
    if (/\.har$/i.test(root))
      return withCapture(target(root, "har", "HAR capture", { capture: root }));
    if (/\.asar$/i.test(root))
      return withCapture(target(root, "asar", "ASAR archive", { app: root }));
    return withCapture(target(root, "unknown", "unsupported file type"));
  }
  const found =
    electronTarget(root) ??
    (existsSync(path.join(root, "package.json"))
      ? target(root, "js-app", "found package.json", { app: root })
      : null) ??
    webTarget(root) ??
    target(
      root,
      "unknown",
      "no package.json, index.html or Electron resources",
    );
  return withCapture(found);
};

const COMPONENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// A manifest path, which must stay inside the release directory.
const inside = (root, relative, file) => {
  const resolved = path.resolve(root, relative);
  const offset = path.relative(root, resolved);
  if (
    offset === ".." ||
    offset.startsWith(`..${path.sep}`) ||
    path.isAbsolute(offset)
  )
    throw new Error(`${file}: ${relative} is outside the release directory`);
  return resolved;
};

const readManifest = (root) => {
  const file = path.join(root, MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0)
    throw new Error(`${file} must list at least one component`);
  const names = new Set();
  const components = manifest.components.map((component, index) => {
    if (
      typeof component?.name !== "string" ||
      typeof component.path !== "string"
    )
      throw new Error(
        `${file}: component ${index} needs a "name" and a "path"`,
      );
    // Names become Evidence file names and report labels.
    if (!COMPONENT_NAME.test(component.name))
      throw new Error(
        `${file}: component name ${JSON.stringify(component.name)} must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
      );
    if (names.has(component.name))
      throw new Error(
        `${file}: component name ${component.name} is listed twice`,
      );
    names.add(component.name);
    return {
      name: component.name,
      target: discoverTarget(inside(root, component.path, file), {
        capture:
          typeof component.capture === "string"
            ? inside(root, component.capture, file)
            : null,
      }),
    };
  });
  return {
    product: typeof manifest.product === "string" ? manifest.product : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    components,
  };
};

/**
 * Describe a release as named components. A directory with a
 * release-watch.json manifest lists its components; anything else is one
 * component named after the input.
 */
export const discoverRelease = (input, { capture = null } = {}) => {
  const root = path.resolve(input);
  if (existsSync(path.join(root, MANIFEST))) {
    if (capture !== null)
      throw new Error(
        `Capture options apply to single-component releases; list captures in ${MANIFEST} instead.`,
      );
    return { root, manifest: true, ...readManifest(root) };
  }
  return {
    root,
    manifest: false,
    product: null,
    version: null,
    components: [{ name: "app", target: discoverTarget(root, { capture }) }],
  };
};
