import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdtemp, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// The caller supplies the destination. An archive member never chooses a filesystem path.
export async function extractMember(path, member, output, signal) {
  const ext = extname(path).toLowerCase();
  let reader;
  if (ext === ".asar") {
    const { AsarArtifactReader } =
      await import("../../../dist/artifacts/AsarArtifactReader.js");
    reader = new AsarArtifactReader(path);
  } else if ([".zip", ".jar", ".apk"].includes(ext)) {
    const { ZipArtifactReader } =
      await import("../../../dist/artifacts/ZipArtifactReader.js");
    reader = new ZipArtifactReader(
      path,
      ext === ".apk" ? "apk" : "zip",
      16 * 1024 * 1024,
    );
  } else throw new Error("Choose an ASAR, ZIP, JAR or APK archive");
  let tmp;
  try {
    let entry;
    for await (const e of reader.entries(signal)) {
      if (e.path !== member) continue;
      if (entry) throw new Error("Archive member name is ambiguous");
      entry = e;
    }
    if (!entry || entry.kind !== "file" || entry.encrypted || entry.unpacked)
      throw new Error("Select an embedded regular unencrypted member");
    const cap = 64 * 1024 * 1024;
    if (entry.declaredSize === null || entry.declaredSize > cap)
      throw new Error("Archive member exceeds 64 MiB or has no declared size");
    tmp = await mkdtemp(join(dirname(output), ".rea-member-"));
    const staged = join(tmp, "content");
    const hash = createHash("sha256");
    let bytes = 0;
    const check = new Transform({
      transform(chunk, _, done) {
        bytes += chunk.length;
        if (bytes > cap) return done(new Error("Expanded bytes exceed 64 MiB"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      await reader.open(entry, signal),
      check,
      createWriteStream(staged, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    const sha256 = hash.digest("hex");
    if (
      bytes !== entry.declaredSize ||
      (entry.declaredSha256 && sha256 !== entry.declaredSha256)
    )
      throw new Error("Archive member integrity mismatch");
    await link(staged, output);
    return { member, output, bytes, sha256 };
  } finally {
    try {
      await reader.close();
    } finally {
      if (tmp) await rm(tmp, { force: true, recursive: true });
    }
  }
}
