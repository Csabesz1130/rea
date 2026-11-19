import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";

export function readLocal(path, max, { digest = false } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(max))
      throw new Error(`Expected a regular file of at most ${max} bytes`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error("File changed while reading");
      offset += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.ctimeNs !== after.ctimeNs)
      throw new Error("File changed while reading");
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ...(digest
        ? { sha256: createHash("sha256").update(bytes).digest("hex") }
        : {}),
    };
  } finally {
    closeSync(fd);
  }
}
