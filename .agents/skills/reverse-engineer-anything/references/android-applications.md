# Android application artifacts

## Connected device tasks

Use the advertised ADB family for a connected phone, emulator, or Android TV.
Supply the existing platform-tools client through `REA_ADB_PATH` (absolute)
or `PATH`; REA does not install it or pair/connect devices. Static APK
inspection below has separate JADX/Java prerequisites.

1. Establish the user's goal and the exact device serial. Use
   `inspect_adb_client` for a missing-client question, and `list_adb_devices`
   to resolve a device selection. Listing may start the local ADB server.
   Select only a device in state `device`; do not guess the first row or try
   to bypass an offline/unauthorized state.
2. Inspect only state relevant to the goal: `inspect_adb_device` for build
   identity, `inspect_adb_window` for focus, `inspect_adb_display` for display
   size/density, or `resolve_adb_packages` for package candidates. Package
   substring matches are candidates, not permission to choose an app. Use
   the exact package with `inspect_adb_package` when its version matters.
3. For a requested app launch, call `start_adb_app` once with the selected
   serial and package. For a requested deep link, `start_adb_activity` accepts
   an action, data URI, and explicit component. Resolve the intended component
   from supplied or observed facts; an implicit intent can open a chooser or
   another app. These operations change device state. Existing authorization
   for the requested action suffices; inspection alone does not authorize it.
4. Verify the outcome with fresh `inspect_adb_window` Evidence and, when
   useful, `capture_adb_screen` in a caller-selected new capture directory.
   Match the exact package/component in the observed focus declaration,
   never a substring. Null, conflicting, or unparseable declarations leave
   focus unresolved. Retry a relevant observation within a finite deadline;
   do not repeat a launch whose side effects may already have happened.
5. Report what the observations actually establish. A launch wait report
   shows the activity manager's verdict. Focus shows an app was foreground
   at read time. Neither establishes that a supplied URL loaded, a particular
   video played, ads disappeared, or the UI became faster. For those goals,
   retain the unmet acceptance condition and the next specific observation
   needed. Use `read_adb_logcat` only for a relevant bounded diagnostic.

For static follow-up, `pull_adb_package` writes a digest-identified base and
split APK set to the selected host output directory. Device paths are not
host paths. Feed the returned local APK paths into the static tools below;
retain split coverage rather than assuming the base contains everything.
Do not install, uninstall, push files, or force-stop an app merely to inspect
it. Stopping a process does not roll back the app's data or network effects.

For example, "open YouTube on my TV" can be checked by an exact package
focus observation. "Play this video" still needs content/playback evidence
after the launch. Unsupported key presses or text input remain unsupported;
do not invent an ADB tool or fall back to unrestricted shell commands.

## Static APK analysis

Use the connected server's advertised Android tools. Repository main and npm
4.1.0 include this family. A skill installation alone cannot add it to an
older server.

Start with `inspect_android_package` on the caller's APK path for package
identity, manifest declarations, coverage, and inline Evidence. Use
`search_android_classes` to find candidates, `inspect_android_class` for one
class's members, `inspect_android_method` for decompilation, and
`trace_android_references` for incoming static references. Each call takes its
own APK path and explicit selectors; do not open a native session first.
Choose an `overload_index` from the class inventory when methods are ambiguous
instead of guessing.

The provider requires a separately supplied headless JADX MCP JAR 0.7.1 and
Java 17 or newer. `REA_JADX_MCP_JAR` selects the absolute JAR path; `JAVA_HOME`
can select Java. REA setup does not install or configure that JAR, and doctor
provider scopes cover Hopper/Ghidra rather than JADX. Use existing tools and
report missing prerequisites for the Android task specifically.

Linux and macOS use the POSIX owned-process boundary. Windows x64 requires the
matching bundled native controls and uses an owned Job Object with bidirectional
stdio. A full JDK, including `jdk.compiler`, is required on every host; Windows
`JAVA_HOME` selects `bin\java.exe`. Consult the Android guide for actual host
verification coverage. Calls use one worker and provider deadlines; optional
`REA_JADX_HEAP_MIB` selects the JVM heap. The APK is never launched,
and no emulator is required.

Manifest entries and decompiled text are static observations, not execution or
policy enforcement. Incoming references are recovered static relationships;
reflection, dynamic loading, and unresolved calls remain unknown. Preserve
artifact digests, locations, diagnostics, and incomplete coverage. For archive
members rather than code analysis, use `open_binary` and `inspect_artifact`.
