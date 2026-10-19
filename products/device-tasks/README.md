# Device Tasks — exploratory prototype

This small, source-checkout product turns existing REA ADB operations into two
fixed tasks: inspect a selected Android device, or open a selected installed app
and check its current window focus. It is separate from the official REA package;
it adds no provider, generic execution language, direct ADB invocation, or core
capability. It is an exploratory draft for reviewing workflow and outcome quality.

## Run

Use the repository's pinned Node toolchain and build REA first:

```sh
npm ci
npm run build:cached
export REA_ADB_PATH=/absolute/path/to/adb

# Print the exact conditional CLI plan. Starts no processes and writes no files.
node products/device-tasks/bin/device-tasks.mjs open \
  --serial YOUR_EXACT_SERIAL --package com.example.app --dry-run

# Read selected-device readiness, build properties, packages, display and focus.
node products/device-tasks/bin/device-tasks.mjs inspect \
  --serial YOUR_EXACT_SERIAL --output /tmp/device-inspect-new

# Launch one installed package once, then make up to three focus observations.
node products/device-tasks/bin/device-tasks.mjs open \
  --serial YOUR_EXACT_SERIAL --package com.example.app \
  --output /tmp/device-open-new --capture-screen

# Optional HTTP(S) intent to an explicitly selected component in that package.
node products/device-tasks/bin/device-tasks.mjs open \
  --serial YOUR_EXACT_SERIAL --package com.example.app \
  --component com.example.app/.MainActivity \
  --url 'https://example.com/watch?id=example' --output /tmp/device-link-new

node products/device-tasks/bin/device-tasks.mjs --help
```

Select the serial yourself using the existing `rea list-adb-devices` command.
The workflow never chooses the first device, connects a network device, installs
an app, changes device settings, taps, types, or sends arbitrary shell commands.
An HTTP(S) URL requires a component in the expected package so intent resolution
cannot silently choose another app. Supply a component that the app supports;
component existence and URL handling are not established before launch.
Credentialed URLs with a username/password are refused before any processes or
files; ordinary URL path, query and fragment values are preserved exactly.

The caller needs an already connected, authorized device and platform-tools ADB.
REA never installs either. The checkout's compiled process supervision must also
be available, including compatible process identity inspection on the host.
`--rea PATH` selects an alternative REA CLI executable or JavaScript entrypoint;
the checkout's Evidence and ADB schemas still validate its responses.

## Task outcome and effects

`inspect` records client readiness, demands exactly one device declaration for
the selected serial in state `device`, then collects device and installed-package
Evidence. With `--package`, it requires an exact inventory entry and also collects
that package's metadata. Display and initial focus failures leave a partial report.

`open` requires both `--serial` and `--package`. It rechecks the exact selected
device immediately before launching. It invokes `start-adb-app` once, or
`start-adb-activity` once for an explicit component. Only subsequent focus reads
retry. A successful REA launch verdict does not satisfy the task goal by itself.

`verified_focus` means the normalized current-window declaration identified the
**exact** expected package at a post-launch observation. Prefix matches fail.
The `focused_app` declaration cannot substitute for a missing current window;
conflicting or unparseable `focused_app` declarations leave the goal unresolved.
Readiness and focus are observations at their recorded times, not device
attestation, an atomic transaction, or a guarantee of continued focus.

Playback, content loading, successful URL handling, login, app responsiveness,
and TV support are explicitly **not established**. This is not a reproduction of
the video's complete TV automation. Launching an app changes device state and can
cause the app to access the network. ADB can start its caller-owned local server,
which may persist. The workflow does not stop that server or force-stop an app
after completion, failure, timeout, or cancellation; there is no automatic
rollback of an app launch. There are no launch retries.

## Evidence and resource bounds

`--output` must name an absent directory whose parent exists. Existing paths are
refused before running REA. The new directory contains:

- `report.json`: complete returned authenticated Evidence, selected inputs,
  request-binding results, observed/derived facts, explicit unknowns, command
  arguments, call status, wall time, errors, focus observations and cleanup results.
- `report.md`: a compact review summary with call references.
- `report.html`: a self-contained, script-free summary with the complete report
  embedded as escaped text; it requires no server or external assets.
- `evidence/`: each exact complete REA JSON response, including failure envelopes.
  Incomplete output is retained separately as a labelled `.partial.txt`, never
  passed off as complete Evidence.
- `screens/before/` and `screens/after/`: optional REA screen captures and digests
  in their Evidence. Inspect requests only the before frame. PNGs remain separate
  artifacts and are not embedded in the HTML.

Reports checkpoint after each call. Cancellation and errors preserve prior facts
and retained files. SIGINT/SIGTERM cancel the task and invoke shared REA owned
process cleanup. A hard process or host crash can interrupt report publication.
An output file permission or disk-full failure can also prevent final publication.
Unresolved cleanup is reported as `cleanup_incomplete`; it is never success.

The runner composes public CLI commands with `--format json --full-output` and
reuses REA's `runOwnedCommand`, including its ownership proofs and bounded
cleanup. It does not implement PID-only or group-wide ad hoc signaling.
It does not opt into token sweeping of deliberately detached processes, so
normal caller-owned ADB daemon startup is not silently undone.

Default bounds are three focus reads, 500 ms between reads, 60 seconds per REA
process and 240 seconds per task. CLI validation caps these at ten reads, 5 seconds
between reads, 90 seconds per process and ten minutes per task. REA output retains
at most 8 MiB per call and 16 MiB across the task; overflows fail with partial
diagnostics. REA's own ADB provider bounds screen captures at 32 MiB each. Cleanup
and report publication can take additional time after a deadline. The prototype
runs operations sequentially and does not cache live state. A default open task
uses ten to twelve REA calls (plus up to two optional captures). Before/after
token usage, process-family CPU and peak-memory measurements remain unmeasured;
call count and wall time alone do not establish efficiency improvements.

## Verification scope

```sh
npm --prefix products/device-tasks test
```

Workflow tests use an explicitly simulated runner to validate selection,
single-launch behavior, focus checks, errors, cancellation and reporting without
claiming real-provider coverage. Additional tests invoke the real product and
compiled REA CLI with a simulated ADB executable selected through `REA_ADB_PATH`.
They cover late focus, wrong focus, unauthorized devices, serial mismatch,
missing packages, launch refusal, timeout and cancellation. Simulated ADB output
does not establish behavior on a real device.

In the implementation environment, REA's process-ownership prerequisite refuses
the nested runtime's incompatible `ps`/PID namespace view (`fatal library error,
lookup self`). Boundary cases are explicitly skipped when that prerequisite is
unavailable, while the actual prerequisite-refusal path is tested. No supervision
was weakened to make these cases pass. Successful full CLI workflow verification
and real Android/TV verification remain outstanding.

Set `REA_DEVICE_TASK_REQUIRE_BOUNDARY=1` to fail rather than skip when the host
prerequisite is unavailable. The dedicated CI job enables this setting on Ubuntu;
its results must be checked before claiming those full CLI workflows pass.
