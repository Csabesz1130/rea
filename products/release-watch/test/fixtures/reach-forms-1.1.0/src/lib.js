import { runShell } from "./shell.js";
export const runTool = (input) => runShell(`notes ${input}`);
