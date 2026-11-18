import { parseArgs } from "node:util";
import { account, config, login, logout, status } from "./auth.mjs";
import { installRelease, installedPlugin } from "./install.mjs";

const help = `rea login [--token-stdin]
rea pro subscribe [--plan indie|team]
rea pro status | logout
rea pro install [--from SIGNED_RELEASE_DIR]
rea pro index <evidence.json> --store DIR
rea pro index-bundle <directory-or.asar> --store DIR --evidence-out FILE
rea pro search QUERY --store DIR [--mode auto|exact|semantic]
rea pro slice ID --store DIR [--hops N] [--budget N]
rea pro stats --store DIR
rea pro mcp --store DIR

Exact-name search is unlimited. Each installation includes three distinct free
neighborhood previews per UTC day.
A paid login installs the signed Slicer plugin from the configured issuer.
Run rea pro --help after installation for the full command list.`;
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
  const [command, ...args] = argv;
  try {
    if (
      ["login", "subscribe", "status", "logout", "install"].includes(command) &&
      args.includes("--help")
    ) {
      process.stdout.write(help + "\n");
      return;
    }
    if (command === "login" || command === "subscribe") {
      const { values } = parseArgs({
        args,
        options:
          command === "login"
            ? { "token-stdin": { type: "boolean" } }
            : { plan: { type: "string" } },
      });
      const grant = await login({
        subscribe: command === "subscribe",
        plan: values.plan,
        notify: (line) => process.stderr.write(line + "\n"),
        token: values["token-stdin"] ? await stdinToken() : undefined,
      });
      if (command === "login" && config().release_endpoint) {
        const plugin = await installRelease();
        return print({ ...grant, plugin });
      }
      return print(grant);
    }
    if (command === "status" || command === "logout") {
      parseArgs({ args, options: {} });
      return print(command === "status" ? status() : logout());
    }
    if (command === "install") {
      const { values } = parseArgs({
        args,
        options: { from: { type: "string" } },
      });
      return print(await installRelease({ from: values.from }));
    }
    let authError;
    try {
      account();
    } catch (error) {
      authError = error;
    }
    const plugin = authError ? null : await installedPlugin();
    if (plugin) return await plugin.runPro(argv);
    if (
      !command ||
      ["-h", "--help", "help"].includes(command) ||
      args.includes("--help")
    ) {
      process.stdout.write(help + "\n");
      return;
    }
    const { tryFreeGraph } = await import("./free.mjs");
    if (await tryFreeGraph(argv)) return;
    throw (
      authError ?? new Error("Install the signed plugin with rea pro install")
    );
  } catch (error) {
    process.stderr.write("rea pro: " + error.message + "\n");
    process.exitCode = 1;
  }
}
