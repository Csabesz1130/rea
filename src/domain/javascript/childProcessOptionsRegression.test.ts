import { describe, expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

describe("child-process options detection", () => {
  it("detects options without an args array", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { spawn, execFile, fork } from "node:child_process";

      spawn("tool", {
        env: { A: "1" },
        stdio: "pipe"
      });

      execFile("tool", {
        env: { A: "1" }
      });

      fork("worker.js", {
        env: { A: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      });
    `);

    expect(
      ir.childProcessSpawns.map(
        ({ method, environmentSupplied, stdioMode, resolution }) => ({
          method,
          environmentSupplied,
          stdioMode,
          resolution,
        }),
      ),
    ).toEqual([
      {
        method: "spawn",
        environmentSupplied: true,
        stdioMode: "pipe",
        resolution: "complete",
      },
      {
        method: "execFile",
        environmentSupplied: true,
        stdioMode: "default",
        resolution: "complete",
      },
      {
        method: "fork",
        environmentSupplied: true,
        stdioMode: "array",
        resolution: "complete",
      },
    ]);
  });

  it("preserves behavior with explicit args arrays", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { spawn, execFile, fork } from "node:child_process";

      spawn("tool", [], { env: { A: "1" }, stdio: "pipe" });
      execFile("tool", [], { env: { A: "1" } });
      fork("worker.js", [], {
        env: { A: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      });
    `);

    expect(
      ir.childProcessSpawns.map(({ environmentSupplied, stdioMode }) => ({
        environmentSupplied,
        stdioMode,
      })),
    ).toEqual([
      { environmentSupplied: true, stdioMode: "pipe" },
      { environmentSupplied: true, stdioMode: "default" },
      { environmentSupplied: true, stdioMode: "array" },
    ]);
  });

  it("does not invent options when omitted", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { spawn, execFile, fork } from "node:child_process";

      spawn("tool");
      execFile("tool");
      fork("worker.js");
    `);

    expect(
      ir.childProcessSpawns.every(
        ({ environmentSupplied, stdioMode }) =>
          environmentSupplied === false && stdioMode === "default",
      ),
    ).toBe(true);

    expect(ir.childProcessSpawns).toHaveLength(3);
  });
});

describe("synchronous child-process calls", () => {
  it("classifies the synchronous forms, whose result is no process handle", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { execSync, execFileSync, spawnSync } from "node:child_process";
      const cp = require("child_process");

      const version = execSync("git --version", { env: { A: "1" } });
      execFileSync("git", ["status", "--short"], { stdio: "inherit" });
      const run = spawnSync("tool", ["a", "b", "c"]);
      run.stdout.on("data", () => {});
      cp.execSync(command);
    `);

    expect(
      ir.childProcessSpawns.map(
        ({
          method,
          command,
          argvCount,
          environmentSupplied,
          stdioMode,
          resultBindingId,
          resolution,
        }) => ({
          method,
          command,
          argvCount,
          environmentSupplied,
          stdioMode,
          resultBindingId,
          resolution,
        }),
      ),
    ).toEqual([
      {
        method: "execSync",
        command: "git --version",
        argvCount: null,
        environmentSupplied: true,
        stdioMode: "default",
        resultBindingId: null,
        resolution: "complete",
      },
      {
        method: "execFileSync",
        command: "git",
        argvCount: 2,
        environmentSupplied: false,
        stdioMode: "inherit",
        resultBindingId: null,
        resolution: "complete",
      },
      {
        method: "spawnSync",
        command: "tool",
        argvCount: 3,
        environmentSupplied: false,
        stdioMode: "default",
        resultBindingId: null,
        resolution: "complete",
      },
      {
        method: "execSync",
        command: null,
        argvCount: null,
        environmentSupplied: false,
        stdioMode: "default",
        resultBindingId: null,
        resolution: "partial",
      },
    ]);
    // Output read from a finished child is no listener on a live one.
    expect(ir.childProcessInteractions).toEqual([]);
  });
});
