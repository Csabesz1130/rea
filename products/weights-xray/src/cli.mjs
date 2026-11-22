import { parseArgs } from "node:util";
import { inspectFile } from "./inspect.mjs";

export const help = `rea weights inspect FILE [--limit N] [--offset N] [--sha256] [--strict-metadata]

Read the tensor inventory of a local .safetensors, .gguf, .onnx or
model.safetensors.index.json file without loading weights. FILE may be a
sharded index; its shards must be regular files beside it. ONNX external
data files are reported, never opened.

  --limit N    tensors to list (default 100, 0 lists none; max 65536)
  --offset N   first tensor to list (default 0)
  --sha256     also hash the whole file (reads every byte; counted separately)
  --strict-metadata
               ONNX: read operator nodes field by field so no tensor payload
               is transferred, at the cost of more reads

Exit status: 0 complete and valid, 2 format violations, 3 incomplete
(a limit was reached or the layout is unsupported), 1 usage or I/O error.`;

export const EXIT = Object.freeze({
  ok: 0,
  error: 1,
  invalid: 2,
  incomplete: 3,
});

const integer = (value, name, max) => {
  if (!/^\d+$/.test(value) || Number(value) > max)
    throw new Error(`--${name} must be an integer from 0 to ${max}`);
  return Number(value);
};

/** Page the tensor list; the rest of the report is always complete. */
export function page(report, offset, limit) {
  const all = report.tensors ?? [];
  return {
    ...report,
    tensors: all.slice(offset, offset + limit),
    tensors_page: {
      offset,
      limit,
      total: all.length,
      more: offset + limit < all.length,
    },
    ...(report.nodes
      ? {
          nodes: report.nodes.slice(offset, offset + limit),
          nodes_page: {
            offset,
            limit,
            total: report.nodes.length,
            more: offset + limit < report.nodes.length,
          },
        }
      : {}),
  };
}

export const exitCode = (report) =>
  !report.valid ? EXIT.invalid : !report.complete ? EXIT.incomplete : EXIT.ok;

export async function runWeights(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  const [command, ...rest] = argv;
  if (
    !command ||
    ["help", "--help", "-h"].includes(command) ||
    rest.includes("--help")
  ) {
    stdout.write(help + "\n");
    return EXIT.ok;
  }
  try {
    if (command !== "inspect")
      throw new Error(
        `Unknown weights command ${command}. See rea weights --help`,
      );
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        limit: { type: "string" },
        offset: { type: "string" },
        sha256: { type: "boolean" },
        "strict-metadata": { type: "boolean" },
      },
    });
    if (positionals.length !== 1)
      throw new Error("Supply exactly one FILE. See rea weights --help");
    const limit =
      values.limit === undefined ? 100 : integer(values.limit, "limit", 65536);
    const offset =
      values.offset === undefined
        ? 0
        : integer(values.offset, "offset", Number.MAX_SAFE_INTEGER);
    const report = await inspectFile(positionals[0], {
      hash: !!values.sha256,
      strict: !!values["strict-metadata"],
    });
    stdout.write(JSON.stringify(page(report, offset, limit)) + "\n");
    return exitCode(report);
  } catch (error) {
    stderr.write(`rea weights: ${error.message}\n`);
    return EXIT.error;
  }
}
