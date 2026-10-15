import { execFile } from "node:child_process";
export function rotateLogs() {
  const result = execFile("/usr/sbin/logrotate", ["/etc/notes.conf"]);
  return result;
}
