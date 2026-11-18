#!/usr/bin/env node
import { parseOptions, help } from "../src/options.mjs";
import { executeTask } from "../src/task.mjs";

const controller = new AbortController();
const cancel = () =>
  controller.abort(new DOMException("Task cancelled by caller", "AbortError"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else {
    const report = await executeTask(options, { signal: controller.signal });
    if (options.dryRun)
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(
        `${JSON.stringify({ status: report.status, output: options.output, rea_calls: report.calls.length, elapsed_ms: report.elapsed_ms, error: report.error })}\n`,
      );
      process.exitCode = ["inspected", "verified_focus"].includes(report.status)
        ? 0
        : 1;
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
