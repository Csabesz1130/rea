import { execFile } from "node:child_process";
export const VERSION = "1.0.0";
export const logger = {
  info: (message) => process.stderr.write(`${message}\n`),
};
export function gitVersion() {
  return execFile("/usr/bin/git", ["--version"]);
}
