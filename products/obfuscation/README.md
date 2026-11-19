# Obfuscation and Packer Detection

For static JavaScript expression values, build-map lookups and ordinary archive extraction, see [REA Pro](../pro-loader/README.md).

Before you spend analysis on a file, it helps to know how its contents are
shaped: a minified bundle is read differently from readable source, a packed
binary hides its code from a static reader, and an archive has to be opened
before anything inside it can be seen. This tool reports that shape, read-only.

It opens each file, reads a head and a tail window and an entropy sample, and
reports what it measured and the markers it found. It does **not** unpack,
decompress, unminify or run anything. A packer marker here is an observation
of the file's bytes, not a recovery of what the packer hid. Deobfuscating a
bundle or unpacking a binary — turning the hidden form back into the original
— is a different capability; see
[`docs/PROPOSAL-runtime-and-recovery.md`](../../docs/PROPOSAL-runtime-and-recovery.md)
for why this repository gates it.

It is a prototype beside the other [`products/`](../). It reads bytes and
runs nothing.

## Quick start

```bash
cd products/obfuscation
node bin/obfuscation.mjs scan path/to/bundle.js path/to/app.exe path/to/app.apk
```

Output is JSON on stdout, one result per file.

## What it reports

| Kind         | Detected by                                 | Reports                                                                                                                                                        |
| ------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `javascript` | a `.js`/`.cjs`/`.mjs` name, or text bytes   | the bundler it names (webpack, esbuild, rollup, parcel, browserify, vite, terser), whether it looks minified, and the line measurements the judgement rests on |
| `native`     | an ELF, Mach-O or PE magic                  | the markers of a packer (UPX, ASPack, MPRESS, Themida, PECompact) and the entropy of a sample                                                                  |
| `archive`    | a zip/APK/jar/dex magic, or an `.asar` name | the archive named, to open with REA's own `android`, `apktool`, `jeb` or `asar` tools                                                                          |
| `unknown`    | none of the above                           | that the format was not recognised                                                                                                                             |

The minified judgement is a boolean with its reasons, and the measurements it
rests on are in the result (`max_line`, `average_line`, `whitespace_ratio`,
`long_line_ratio`), so a reader can see why and disagree. Entropy near 8 bits
per byte is a hint that bytes are compressed or packed; it is printed as a
hint, not a finding, because dense unpacked code reads high too.

## On real files

On this container, over releases the other products fetched:

- `dist/ccstatusline-78jxrt1v.js` (1.6 MB): `javascript`, bundler **esbuild**,
  minified (a 14,131-character line in the sampled head).
- `dist/cli.js` of cc-safety-net (0.5 MB): `javascript`, no bundler marker,
  minified (a 31,117-character line).
- esbuild's Linux and Windows binaries and biome's Linux binary: `native`,
  **elf**/**pe**, no packer markers, entropy about 6.1 bits per byte — the
  normal range for unpacked native code, which is why entropy alone is only a
  hint.

No UPX-packed sample was on hand, so UPX detection is exercised in the tests
by a header carrying its markers, not on a real packed binary.

## What it does not establish

- Minification and bundler markers are read from a bounded head and tail
  window, not the whole file; the measurements name the sampled size. A file
  whose markers sit only in a middle the window does not reach is not named.
- The native check reads markers and entropy. It does not parse the
  executable; REA's `inspect_macho`, `inspect_binary_layout`,
  `inspect_rust_binary` and `inspect_pe_resources` read the structure, and
  [Release Watch](../release-watch/README.md) compares native files between
  releases.
- Android obfuscation (R8, ProGuard) lives inside the APK's `classes.dex`.
  This tool names the archive and stops there; reading the dex is REA's
  `android`, `apktool` and `jeb` tools, which the archive note points to.
  Detecting that dex as obfuscated, and any mapping of its renamed symbols,
  is not done here.

## Tests

```bash
cd products/obfuscation && npm test
```

The tests write small inputs — a minified bundle and readable source, native
headers with and without a packer's markers, and archive magics — so the
thresholds and markers are checked without shipping a large real binary. What
the detector reported on real bundles and binaries is recorded above.
