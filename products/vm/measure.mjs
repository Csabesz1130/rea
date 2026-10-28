#!/usr/bin/env node
// measure.mjs <out.json> <command> [args...]
//
// Runs a command and records what it cost: wall time and the peak memory
// of its process family (the command and every process it starts, summed
// from /proc every 200 ms), and of its largest single process. Writes `{
// command, exit, wall_s, peak_family_mb, peak_process_mb }` to <out.json>
// and exits with the command's status. Linux only; CPU time is what
// `time` reports around it, since a process's children are only counted
// when it waits for them.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const INTERVAL_MS = 200;

const [out, command, ...args] = process.argv.slice(2);
if (!out || !command) {
  process.stderr.write("Usage: measure.mjs <out.json> <command> [args...]\n");
  process.exit(2);
}

// Every process's parent and resident memory in KiB; a process that exits
// while it is read is skipped.
const processes = () => {
  const table = new Map();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name)))
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      table.set(Number(pid), { ppid, rss });
    } catch {
      // Gone between the listing and the read.
    }
  return table;
};

const started = performance.now();
const child = spawn(command, args, { stdio: "inherit" });
let peakFamily = 0;
let peakProcess = 0;

const sample = () => {
  const table = processes();
  const family = new Set([child.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, { ppid }] of table)
      if (!family.has(pid) && family.has(ppid)) {
        family.add(pid);
        grew = true;
      }
  }
  let total = 0;
  for (const pid of family) {
    const rss = table.get(pid)?.rss ?? 0;
    total += rss;
    peakProcess = Math.max(peakProcess, rss);
  }
  peakFamily = Math.max(peakFamily, total);
};

const timer = setInterval(sample, INTERVAL_MS);
child.on("error", (error) => {
  clearInterval(timer);
  process.stderr.write(`measure.mjs: ${error.message}\n`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  clearInterval(timer);
  const record = {
    command: [command, ...args].join(" "),
    exit: code ?? signal,
    wall_s: Math.round(performance.now() - started) / 1000,
    peak_family_mb: Math.round(peakFamily / 1024),
    peak_process_mb: Math.round(peakProcess / 1024),
  };
  writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
  process.exit(code ?? 1);
});
