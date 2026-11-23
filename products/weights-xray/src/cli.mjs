import { parseArgs } from "node:util";
import { LIMITS } from "./errors.mjs";
import { inspectFile, inspectRemote } from "./inspect.mjs";
import { parseResolveUrl } from "./remote.mjs";

export const help = `rea weights inspect FILE [--limit N] [--offset N] [--sha256] [--strict-metadata]

Read the tensor inventory of a local .safetensors, .gguf, .onnx or
model.safetensors.index.json file without loading weights. FILE may be a
sharded index; its shards must be regular files beside it. ONNX external
data files are reported, never opened.

FILE may also be a revision-pinned Hugging Face URL,
https://huggingface.co/OWNER/REPO/resolve/COMMIT/PATH, read with bounded byte
ranges: 64 KiB per request, 256 requests, 16 MiB and 60 s in total. HF_TOKEN,
when set, is sent to huggingface.co only, never to a redirect target.

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
    const remote = /^https?:\/\//i.test(positionals[0]);
    // A malformed or unpinned URL is a usage error, not an incomplete read.
    if (remote) {
      try {
        parseResolveUrl(positionals[0]);
      } catch (error) {
        const m =
          /^https:\/\/huggingface\.co\/((?:datasets\/)?[\w.-]+\/[\w.-]+)\//.exec(
            positionals[0],
          );
        const hint =
          error.code === "REVISION_NOT_PINNED" && m
            ? `. The current commit is the "sha" field of https://huggingface.co/api/${m[1].startsWith("datasets/") ? m[1] : "models/" + m[1]}`
            : "";
        throw new Error(error.message + hint);
      }
    }
    if (remote && values.sha256)
      throw new Error(
        "--sha256 needs a full local read; download the file and inspect it locally",
      );
    const report = remote
      ? await inspectRemote(positionals[0], {
          remote: { token: process.env.HF_TOKEN || undefined },
          ...(values["strict-metadata"]
            ? { limits: { ...LIMITS, onnx: { strict: true } } }
            : {}),
        })
      : await inspectFile(positionals[0], {
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
