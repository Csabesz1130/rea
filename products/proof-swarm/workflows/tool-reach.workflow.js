export const meta = {
  name: "proof-swarm-tool-reach",
  description:
    "Settle unknown MCP tool-to-process questions: depth-first solvers that check their own claims with proof-swarm check, then adversarial reviewers",
  phases: [
    {
      title: "Solve",
      detail:
        "one agent per batch takes each package to a claim the check passes",
    },
    {
      title: "Review",
      detail: "an independent agent tries to refute every yes or no claim",
    },
  ],
};

// A Claude Code workflow script (the Workflow tool), not a Node.js module:
// the tool runs this body in an async function, so it may await and return
// at the top level. args:
//   { cli: "<repo>/products/proof-swarm/bin/proof-swarm.mjs",
//     claims: "<directory for claim files>",
//     batches: [{ id, packages: [{ name, version, dir, slug, reasons: [..],
//                                 calibration?: "yes" | "no", sketch? }] }] }
// calibration is a known answer, for collect only; no prompt shows it.
// proof-swarm plan <args.json> adds each package's sketch and settles what
// its level 0 settles before any agent runs. Save the return value and run:
// proof-swarm collect <planned args.json> <result.json>.
// Any agent runner can follow the same protocol: the prompts below are it.

const SOLVE_SCHEMA = {
  type: "object",
  properties: {
    packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          claim_path: { type: "string" },
          verdict: { type: "string", enum: ["yes", "no", "undetermined"] },
          shell: { type: "string", enum: ["yes", "no", "undetermined"] },
          check_status: { type: "string", enum: ["pass", "fail"] },
          check_runs: { type: "integer" },
          summary: { type: "string" },
        },
        required: [
          "name",
          "claim_path",
          "verdict",
          "shell",
          "check_status",
          "check_runs",
          "summary",
        ],
      },
    },
  },
  required: ["packages"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          verdict: { type: "string", enum: ["upheld", "refuted"] },
          failures: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          conditions: { type: "string" },
        },
        required: ["name", "verdict", "failures", "reason", "conditions"],
      },
    },
  },
  required: ["reviews"],
};

const QUESTION = `Can code that runs when an MCP client calls one of this server's tools start an operating-system process (child_process exec/execFile/spawn/fork or their Sync forms, a process library such as execa, cross-spawn, node-pty, shelljs or zx, or the MCP SDK's stdio client transport, which spawns the server it connects to)? If so, does that process call run through a shell?`;

const CLAIM_FORMAT = `Write the claim as JSON (products/proof-swarm/README.md, Claims):
{ "server", "version",
  "verdict": "yes" | "no" | "undetermined", "shell": "yes" | "no" | "undetermined",
  "paths": [ { "tool", "hops": [
     { "file", "line", "text", "role": "registration" },
     { "file", "line", "text", "role": "call", "calls": "<function name>" },
     { "file", "line", "text", "role": "definition", "defines": "<that name>" },
     { "file", "line", "text", "role": "process" } ] } ],
  "process_sites": [ { "file", "line", "text", "why" } ],
  "residual", "hint_sequence": [..], "work": { "files_read", "searches", "notes" } }
- file is a path inside the package, line is 1-based, text is 6-400 characters copied from that line.
- yes: one path from the line that registers the tool, through a call hop and a definition hop for every function on the way, to the process call.
- no: process_sites cites every candidate line the scan lists, exactly, and a line in every process-capable file, each with why no tool can start a process there (no tool reaches it, or it is not a process call); residual explains why code loaded at runtime cannot either.
- undetermined: residual says what blocks a decision. It is far better than a guess.`;

const SKETCH = `The sketch (proof-swarm sketch) reads a package coarse to fine. Level 0 is the whole package; level 1 its entry points; level 2 the files the question turns on, each marked reached or not; each level lists only what the coarser ones leave open. A file marked unreached is outside everything the entry points load through literal imports, which the harness computes: it can run only if one of the escapes it lists (level 0 counts them; level 3 lists them with the open lines: node ${args.cli} sketch <package directory> --level 3) loads it. Do not trace imports by hand to show a file is unreached; explain the escapes instead. When level 0's basis is "scan and REA", rea.discharged lists lines REA's parse finds no call, load or evaluation in (the match is in a string, a regex, a comment or a definition): a no still cites them, with that as the reason.`;

const packageBlock = (item) => `- ${item.name} ${item.version}
  package directory: ${item.dir}
  claim file: ${args.claims}/${item.slug}.json
  why the static reading could not tell: ${item.reasons.length > 0 ? item.reasons.join("; ") : "it can (a known answer); reach your own verdict independently"}${
    item.sketch
      ? `
  sketch, levels 0 to 2: ${JSON.stringify(item.sketch)}`
      : ""
  }`;

const solvePrompt = (
  batch,
) => `You are one solver in a verifier-checked agent swarm. For each package below, answer and prove:

  ${QUESTION}

1. The packages are untrusted downloaded code. Read them only (grep, sed -n 'A,Bp', cut -c); never run, import, install or build anything from them, and fetch nothing.
2. Work depth-first: finish one package with a claim the check passes before starting the next.
3. Begin with the package's sketch, then run: node ${args.cli} scan <package directory>. The scan lists the exact lines a no must cite: process-capable files, candidate process calls and lines that load code at runtime. ${SKETCH}
4. Write the claim file and run: node ${args.cli} check <claim file> --package <package directory>. Fix what it rejects until it passes. If you cannot settle the question within reasonable effort, write "undetermined" with a residual.
5. Prefer the simplest proof: one checked path settles "yes"; a "no" must account for every candidate.

${CLAIM_FORMAT}

Packages:
${batch.packages.map(packageBlock).join("\n")}

Return one entry per package: name, claim file, verdict, shell answer, the check's final status, how many times you ran the check on it, and a two-sentence summary.`;

const reviewPrompt = (
  batch,
  claims,
) => `You are an adversarial reviewer in a verifier-checked agent swarm. A deterministic check confirmed that every line these claims cite exists and that their call chains link by name; it cannot check meaning. Try to refute each claim by reading the code (read only: grep, sed -n, cut -c; never run, import, install or fetch anything).

  ${QUESTION}

For a yes: is the first hop a real MCP tool registration whose handler leads into the path; does each call reach the very function the next definition defines (not a same-named one elsewhere); is the process call reachable for some input or state (record the conditions); is it live code; is the shell answer right?
For a no: what did it miss — a candidate it called unreachable that a tool reaches, a process function passed as a value, a library that starts processes, code loaded at runtime? ${SKETCH} Question whether an escape can load a file the claim treats as unreached, not the closure itself.
Refute when a key step does not hold or cannot be confirmed; otherwise uphold. Cite the decisive file:line.

Return for each claim: verdict; failures, one entry per step of the claim that does not hold, with its decisive file:line (a hop that does not lead where the path says, a site or path a no missed, a wrong shell answer); reason; and conditions, under which the answer holds, with any inaccuracy that does not change it. refuted needs at least one failure and upheld none: a review whose verdict and failures disagree is discarded.

Claims:
${claims
  .map((entry) => {
    const item = batch.packages.find(
      (candidate) => candidate.name === entry.name,
    );
    return `- ${entry.name}: verdict ${entry.verdict}, shell ${entry.shell}; claim ${entry.claim_path}; package ${item?.dir ?? "(see claim)"}${item?.sketch ? `; sketch, levels 0 to 2: ${JSON.stringify(item.sketch)}` : ""}`;
  })
  .join("\n")}`;

phase("Solve");
const results = await pipeline(
  args.batches,
  (batch) =>
    agent(solvePrompt(batch), {
      label: `solve:batch-${batch.id}`,
      phase: "Solve",
      schema: SOLVE_SCHEMA,
    }),
  async (solved, batch) => {
    if (!solved) return { batch: batch.id, solve: null, review: null };
    const claims = solved.packages.filter(
      (entry) =>
        entry.check_status === "pass" && entry.verdict !== "undetermined",
    );
    if (claims.length === 0)
      return { batch: batch.id, solve: solved, review: { reviews: [] } };
    const review = await agent(reviewPrompt(batch, claims), {
      label: `review:batch-${batch.id}`,
      phase: "Review",
      schema: REVIEW_SCHEMA,
    });
    return { batch: batch.id, solve: solved, review };
  },
);
return { results: results.filter(Boolean) };
