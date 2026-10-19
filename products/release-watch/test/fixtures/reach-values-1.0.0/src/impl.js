import { spawn } from "node:child_process";
export function go(command) {
  return spawn("/usr/bin/impl", [command]);
}
