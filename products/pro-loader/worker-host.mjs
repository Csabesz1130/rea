import { Worker } from "node:worker_threads";

const manifests = new Map();

export function registerPluginSource(moduleURL, manifest) {
  manifests.set(moduleURL, manifest);
}

// A worker launched by a compiled plugin needs its own verification and ABI
// resolver. Bind it to the calling release even if a concurrent install updates
// current.jwt. Source-tree tests can start their original ESM worker directly.
export function startPluginWorker(moduleURL, options) {
  const manifest = manifests.get(moduleURL);
  if (!manifest) return new Worker(new URL(moduleURL), options);
  return new Worker(new URL("./worker-main.mjs", import.meta.url), {
    ...options,
    workerData: { ...options.workerData, pluginManifest: manifest },
  });
}
