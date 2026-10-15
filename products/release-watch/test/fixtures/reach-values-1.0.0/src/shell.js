import { exec } from "node:child_process";
export const runShell = (command) => exec(command);
