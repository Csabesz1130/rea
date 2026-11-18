# Proposal: runtime instrumentation bridge and protection recovery

**Process attachment and protection recovery are proposals.** This
document exists to seek the explicit maintainer scope decision that
[CONTRIBUTING.md#fail-closed-integration](../CONTRIBUTING.md#contribution-scope)
requires before substantial implementation of a capability involving target
execution, injection, mutation, or protection recovery. Opening it does not
authorize integration; passing CI or completing a prototype would not either.

It covers two ideas that a product roadmap groups with REA but that the
repository's scope rules gate:

1. a **live runtime bridge** — attaching an instrumentation engine (Frida, or
   an eBPF/ptrace tracer) to a running process, reading registers and memory,
   intercepting calls, and returning observations over MCP; and
2. **protection recovery** — unpacking packed binaries and deobfuscating
   bundles to recover a hidden original form, including symbolic-execution
   passes.

Both are held pending a decision. What is already built and in scope is named
in "What exists instead" below.

## Separate the acceptable analysis from the excluded workflow

CONTRIBUTING asks a mixed proposal to separate acceptable analysis from
excluded workflows so each is decided on its own. For these two ideas:

| Capability                                                                                                                                     | Where CONTRIBUTING places it                              | State                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reading what a native file or bundle **is** (format, sections, packer markers, minification), read-only                                        | Supported: format inspection, static protection detection | **Built** — see `products/obfuscation`, `products/release-watch` native comparison                            |
| Serving an agent **slices** of REA's existing static Evidence                                                                                  | Supported: evidence reporting                             | **Built** — see `products/slicer`                                                                             |
| General **static** deobfuscation that does not execute the target (e.g. constant folding, scope-based renaming of a bundle REA already parsed) | Supported: general static deobfuscation                   | Literal-expression folding and build-map lookup are implemented in [REA Pro](../products/pro-loader/README.md)       |
| **Launching or attaching** to a process, reading its memory/registers, **injecting** instrumentation, running scripts in it                    | Needs explicit boundaries and a scope decision            | **Gated — this proposal**                                                                                     |
| Intercepting a process's traffic **before encryption**, or defeating certificate pinning                                                       | Review required; adjacent to access-control bypass        | **Gated — this proposal**                                                                                     |
| Purpose-built **unpacking of packed/virtualized code to recover the original**, or symbolic execution aimed at protection recovery             | Not integrated or distributed by REA                      | **Excluded** by the current rule; a decision would be needed to revisit it, and this proposal does not ask to |

The first three rows are where work should go first, and two of them are
already done. The fourth and fifth rows are what this proposal is for. The
sixth is excluded today; this document does not request it.

## The scope-decision checklist, as far as it can be answered now

CONTRIBUTING lists what maintainers and implementers resolve before
integration. Recording the answers now, with the unknowns left as unknowns
rather than assumed safe:

**The analyst question, inputs/outputs, and why existing REA operations are
insufficient.** REA is strongest statically; a value computed only at runtime
(a key derived in memory, a host assembled from fragments, a branch taken only
under a condition) is not in a static graph. The question is "what does this
process actually do when it runs," with inputs being a target the operator is
authorized to run and a script of what to observe, and outputs being
observations tied to Evidence. Existing operations stop at static facts and at
read-only enumeration (`list_frida_devices`, `list_frida_processes` enumerate;
they do not attach). This is a real gap — and precisely the kind the rule gates.

**Why it fits scope, its non-goals, and any bypass it would expose.** A general
observation bridge is not inherently a bypass workflow, but CONTRIBUTING is
explicit that a general interface is not exempt merely because the misuse would
come from caller-provided scripts: its execution and mutation authority must
still be reviewed. Non-goals must be stated and enforced, not disclaimed: no
certificate-pinning defeat, no memory or register **writes**, no anti-debugging
evasion, no DRM/anti-cheat/access-control bypass. The "intercept TLS-pinned
traffic before encryption" framing from the roadmap is on the wrong side of
that line as written and is not proposed here.

**Every execution, injection, mutation, network and persistence effect,
including behavior inherited from upstream.** Unresolved. Attaching Frida
injects a gadget and runs a script in the target; that is execution and
injection by definition, and the upstream engine's defaults (script eval,
memory write APIs) come with it. An eBPF/ptrace tracer has its own privilege
and persistence surface. None of this is bounded yet. **Recorded as unknown.**

**How boundaries and outcomes are verified, with self-owned or licensed
samples.** Unresolved. There is no plan yet for which self-owned targets prove
the attach is read-only, how memory/register-write authority is withheld (not
merely undocumented), how cleanup and detach are guaranteed on cancellation,
and what real CLI/MCP and provider coverage demonstrates it. **Recorded as
unknown.**

Because the execution/mutation effects and the verification are materially
unresolved, the fail-closed rule applies: **do not implement for integration,
enable, or distribute.** The decision is the maintainers'.

## Open questions for the maintainer decision

1. Is a read-only runtime **observation** bridge (attach, read, detach; no
   memory or register writes; no interception of protected channels) in scope
   at all, or does any attach/inject cross the line for this project?
2. If in scope, how is "read-only" **enforced** rather than documented — which
   upstream write APIs are removed from the exposed surface, and how is that
   verified?
3. What target-authorization, resource-limit, cancellation and cleanup
   guarantees are required before any attach runs?
4. Is a **static** bundle-deobfuscation pass (no target execution) worth
   proposing separately, given `products/slicer` already slices the static
   graph?

## Related implementations

[REA Pro](../products/pro-loader/README.md) accepts application-emitted telemetry and local build mappings. Its collector records first-party spans, and its archive command extracts ordinary container members.

The in-scope, read-only parts of this space are built and shipped as prototypes:

- **`products/obfuscation`** detects, read-only, that a binary carries a
  packer's markers or that a bundle is minified, and names archives for REA's
  own tools. It does not unpack or unminify.
- **`products/release-watch`** compares the native files a release ships by
  content and reports new or changed ones (RW-B01, RW-C07), without reading
  what native code does.
- **`products/slicer`** indexes REA's static Evidence and serves an agent
  minimal slices, which is the token problem the roadmap raised, solved without
  any runtime capability.

These stand on their own and need no part of the gated work above.
