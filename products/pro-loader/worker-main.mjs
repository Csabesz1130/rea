import { isMainThread, workerData } from "node:worker_threads";
import { account } from "./auth.mjs";
import { loadPlugin } from "./install.mjs";

if (isMainThread || workerData?.reaFoldWorker !== true)
  throw new Error("Expected a plugin parser worker");
account("graph");
const plugin = await loadPlugin(workerData.pluginManifest);
await plugin.startFoldWorker();
