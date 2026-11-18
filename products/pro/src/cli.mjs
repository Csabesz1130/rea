import { parseArgs } from "node:util";
import { account, login, logout } from "./auth.mjs";
import { operations, runOperation } from "./tools.mjs";
const help = `rea login [--token-stdin]
rea pro subscribe | status | logout
rea pro index <evidence.json> --store DIR
rea pro index-bundle <directory-or.asar> --store DIR --evidence-out FILE [--max-semantic-nodes N] [--max-semantic-nodes-per-file N] [--max-heap-mb N]
rea pro search QUERY --store DIR [--kind KIND] [--limit N] [--offset N]
rea pro slice ID --store DIR [--hops N] [--direction in|out|both] [--relation NAME] [--budget N] [--evidence-id ID]
rea pro stats --store DIR
rea pro collect --trace NEW_FILE [--port N]
rea pro trace --trace FILE [--cursor CURSOR] [--limit N] [--wait-ms MS]
rea pro explain-js --script FILE [--offset N] [--limit N]
rea pro source-position --map FILE --line N --column N [--offset N] [--limit N]
rea pro r8-symbol CLASS --mapping FILE [--method NAME] [--line N] [--offset N] [--limit N]
rea pro extract <archive> <member> --out FILE
rea pro mcp [--store DIR] [--trace FILE] [--script FILE] [--map FILE] [--mapping FILE]`;
const numeric = new Set([
  "hops",
  "budget",
  "limit",
  "offset",
  "line",
  "column",
  "wait_ms",
]);
const parse = (args, names, n, flags = []) => {
  const options = Object.fromEntries(
    names.map((name) => [
      name,
      { type: flags.includes(name) ? "boolean" : "string" },
    ]),
  );
  const parsed = parseArgs({ args, options, allowPositionals: true });
  if (parsed.positionals.length !== n)
    throw new Error(`Expected ${n} positional argument(s). See rea pro --help`);
  return parsed;
};
const need = (opts, key) => {
  if (!opts[key]) throw new Error(`Supply --${key}`);
  return opts[key];
};
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function stdinToken() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16385) throw new Error("Entitlement exceeds 16 KiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function runPro(argv) {
  const [command, ...rest] = argv;
  try {
    if (
      !command ||
      ["help", "--help", "-h"].includes(command) ||
      rest.includes("--help")
    ) {
      process.stdout.write(help + "\n");
      return;
    }
    if (command === "login" || command === "subscribe") {
      const { values } = parse(
        rest,
        command === "login" ? ["token-stdin"] : [],
        0,
        ["token-stdin"],
      );
      return print(
        await login({
          subscribe: command === "subscribe",
          token: values["token-stdin"] ? await stdinToken() : undefined,
          notify: (line) => process.stderr.write(line + "\n"),
        }),
      );
    }
    if (command === "status" || command === "logout") {
      parse(rest, [], 0);
      return print(command === "status" ? account() : logout());
    }
    if (command === "index" || command === "index-bundle") {
      account("graph");
      const controls = [
        "max-semantic-nodes",
        "max-semantic-nodes-per-file",
        "max-heap-mb",
      ];
      const {
        values,
        positionals: [target],
      } = parse(
        rest,
        command === "index"
          ? ["store"]
          : ["store", "evidence-out", ...controls],
        1,
      );
      const dir = need(values, "store");
      if (command === "index")
        return print(
          await (await import("./graph.mjs")).buildGraph(dir, target),
        );
      const options = {};
      for (const key of controls) {
        if (values[key] === undefined) continue;
        if (
          !/^\d+$/.test(values[key]) ||
          !Number.isSafeInteger(Number(values[key]))
        )
          throw new Error("Invalid --" + key);
        options[key.replaceAll("-", "_")] = Number(values[key]);
      }
      const { indexBundle } = await import("./bundle.mjs");
      return print(
        await indexBundle(target, dir, need(values, "evidence-out"), options),
      );
    }
    if (command === "collect") {
      account("runtime");
      const { values } = parse(rest, ["trace", "port"], 0);
      const port = Number(values.port ?? 4318);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("Invalid port");
      const { startCollector } = await import("./otlp.mjs");
      const server = await startCollector(
        need(values, "trace"),
        port,
        process.env.REA_PRO_OTLP_TOKEN,
        () => account("runtime"),
      );
      for (const name of ["SIGINT", "SIGTERM"])
        process.once(name, () => server.close());
      return print({
        endpoint: "http://127.0.0.1:" + server.address().port + "/v1/traces",
      });
    }
    if (command === "extract") {
      account("recovery");
      const {
        values,
        positionals: [archive, member],
      } = parse(rest, ["out"], 2);
      return print(
        await (
          await import("./archive.mjs")
        ).extractMember(archive, member, need(values, "out")),
      );
    }
    if (command === "mcp") {
      const { values } = parse(
        rest,
        [...new Set(operations.map((op) => op.resource))],
        0,
      );
      return await (await import("./mcp.mjs")).serve(values);
    }
    const op = operations.find((o) => o.cli === command);
    if (!op)
      throw new Error(`Unknown Pro command ${command}. See rea pro --help`);
    const args = Object.keys(op.input.shape).filter(
      (k) => !op.args.includes(k),
    );
    const { values, positionals } = parse(
      rest,
      [op.resource, ...args.map((k) => k.replaceAll("_", "-"))],
      op.args.length,
    );
    const input = Object.fromEntries(
      op.args.map((k, i) => [k, positionals[i]]),
    );
    for (const key of args) {
      const v = values[key.replaceAll("_", "-")];
      if (v !== undefined) {
        if (numeric.has(key) && !/^\d+$/.test(v))
          throw new Error(`Expected an integer for ${key}`);
        input[key] = numeric.has(key) ? Number(v) : v;
      }
    }
    return print(await runOperation(op, need(values, op.resource), input));
  } catch (error) {
    process.stderr.write(`rea pro: ${error.message}\n`);
    process.exitCode = 1;
  }
}
