import { execFile } from "node:child_process";
export function gc() {
  execFile("/usr/bin/git", ["gc", "--auto"]);
}
export default function (message) {
  process.stderr.write(`${message}\n`);
}
