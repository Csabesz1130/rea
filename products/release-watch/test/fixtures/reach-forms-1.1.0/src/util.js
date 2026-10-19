import { execFile } from "node:child_process";
export function log(message) {
  return `[notes] ${message}`;
}
export function compactStore() {
  function log() {
    return execFile("/usr/bin/git", ["gc", "--auto"]);
  }
  return log();
}
