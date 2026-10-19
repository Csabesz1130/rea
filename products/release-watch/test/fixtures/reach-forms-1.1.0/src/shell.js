import { exec } from "node:child_process";
// Used by the doctor launcher.
export const runShell = (command) => exec(command);
