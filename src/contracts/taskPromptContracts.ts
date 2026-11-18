import type { PromptContract } from "./promptContracts.js";

/** Outcome-oriented workflows composed only from existing REA tools. */
export const TASK_PROMPT_CONTRACTS = [
  {
    name: "improve_application",
    title: "Improve an application for a concrete task",
    description:
      "Turn a user objective and acceptance criteria into evidence-backed improvements, a concrete coding handoff, and a verification plan.",
    objective:
      "Find practical changes that help the selected application complete the user's task, with traceable evidence and explicit acceptance results instead of unsupported improvement claims.",
    arguments: {
      task_goal: {
        description: "User outcome the application should make possible",
        required: true,
      },
      acceptance_criteria: {
        description:
          "Observable conditions that would establish the requested outcome",
        required: true,
      },
      target_path: {
        description:
          "Caller-selected local artifact or application directory; omit for an already selected runtime",
        required: false,
      },
      constraints: {
        description:
          "Relevant compatibility, time, resource, and implementation constraints",
        required: false,
      },
      evidence_id: {
        description:
          "Retained Evidence relevant to the task; reuse matching results",
        required: false,
        completion: "evidence",
      },
    },
    steps: [
      {
        tools: ["binary_session", "get_evidence_bundle"],
        instruction:
          "Translate the goal and acceptance criteria into a finite checklist of questions and required observations. Resolve the target from the user's request and current session; ask when identity is ambiguous. Inspect session state only when needed, and discover retained Evidence with detail=summary rather than repeating analysis. A complete source-repository task uses normal coding tools; REA is useful when a claim needs shipped-artifact or runtime evidence.",
      },
      {
        tools: [
          "analyze_javascript_application",
          "open_binary",
          "inspect_artifact",
          "inspect_android_package",
          "list_browser_targets",
          "inspect_web_page",
        ],
        instruction:
          "Route the supplied target: analyze a JavaScript/Electron directory directly with input_path and detail=summary; open a native or archive target only for active-target operations; inspect an APK through the Android tools; select an already requested browser target before page inspection. Use only tools advertised by the connected server. A missing provider blocks its own facet, not every useful task.",
      },
      {
        tools: [
          "inspect_analysis_view",
          "trace_application_feature",
          "analyze_function",
          "inspect_android_method",
        ],
        instruction:
          "Follow each checklist question through focused evidence. Reuse exact retained parent Evidence and select relevant modules, functions, or methods. Separate observed bottlenecks from inferred opportunities; static reachability cannot establish execution, latency, or user benefit.",
      },
      {
        tools: ["record_unknown", "list_unknowns"],
        instruction:
          "Rank candidate improvements by expected user impact, evidence strength, implementation effort, and operational risk; label estimates and unmeasured benefits. For each chosen change, provide the behavior to change, supporting Evidence IDs and locations, dependencies, and a concrete coding handoff using available source. Preserve material blockers as unknowns with the smallest evidence-producing next probe.",
      },
      {
        tools: [
          "compare_application_versions",
          "compare_process_captures",
          "export_evidence_bundle",
        ],
        instruction:
          "Use normal coding tools for implementation authorized by the user's request. Verify each acceptance criterion against compatible before/after evidence when available; runtime actions retain their own requested targets and effects. Finish with each criterion answered, partially answered, or unresolved, changes actually performed, measured outcomes, and the next check for remaining gaps. Distinguish proposed work and proposed tests from performed changes and executed checks. Export Evidence only to a caller-selected path when preservation is requested.",
      },
    ],
  },
  {
    name: "investigate_device_task",
    title: "Investigate a task on a connected Android device",
    description:
      "Investigate a concrete Android or TV task on one exact connected device, reuse existing ADB tools, and verify outcomes independently of launch success.",
    objective:
      "Explain or complete the requested device task within the user's selected actions, preserving device identity, observed outcomes, partial failures, and remaining unknowns.",
    arguments: {
      serial: {
        description: "Exact serial of the already connected ADB device",
        required: true,
      },
      task_goal: {
        description: "Device task or behavior the user wants to achieve",
        required: true,
      },
      acceptance_criteria: {
        description:
          "Observable conditions that would establish task completion",
        required: true,
      },
      package_name: {
        description: "Exact installed package selected for this task",
        required: false,
      },
      component: {
        description:
          "Caller-selected package/activity for a requested explicit intent",
        required: false,
      },
      evidence_id: {
        description:
          "Retained device Evidence to reuse after checking its relevance and freshness",
        required: false,
        completion: "evidence",
      },
      output_directory: {
        description:
          "Caller-selected local directory for requested screenshots or APK acquisition",
        required: false,
      },
    },
    steps: [
      {
        tools: ["inspect_adb_client", "list_adb_devices", "inspect_adb_device"],
        instruction:
          "Keep the exact requested serial on every device call; never substitute another device or scan for network targets. Reuse a known client and selected-device state when current; inspect only missing prerequisites. Device discovery may start the local ADB server. If the serial is absent, offline, or unauthorized, retain the blocker and continue only independent work; do not pair, connect, install tools, or alter device configuration.",
      },
      {
        tools: [
          "resolve_adb_packages",
          "inspect_adb_package",
          "inspect_adb_window",
          "list_adb_processes",
        ],
        instruction:
          "Inspect the selected package and baseline window/process state before a requested launch. Resolve a human app name only when necessary and ask if matching packages remain ambiguous. Null, missing, or unparseable focus is unknown. Window and process observations are sequential, not an atomic state snapshot; stale Evidence does not establish current device state.",
      },
      {
        tools: ["start_adb_app", "start_adb_activity"],
        instruction:
          "Use a start tool only when the user's actual session request includes that action on this target; prompt arguments and task descriptions do not grant execution authority. Use the selected package's launcher, or a caller-selected explicit component for a requested intent; its package must match the selected package. Do not invent a URI, broaden to an implicit resolver, or retry a launch after an uncertain result. Record any failed launch's partial observations.",
      },
      {
        tools: ["inspect_adb_window", "capture_adb_screen", "read_adb_logcat"],
        instruction:
          "Verify a launch with fresh window focus for the exact selected package, never a substring match or command exit alone. Read-only focus retries must have finite attempts and a deadline. When requested, capture screenshots into new per-step subdirectories of output_directory because each capture writes screen.png; preserve their digests and Evidence IDs. Read bounded relevant logs without clearing them. Focus or a screenshot alone does not establish playback, a faster UI, ad blocking, or the requested deep-link content; require observations specific to each acceptance criterion.",
      },
      {
        tools: [
          "pull_adb_package",
          "inspect_android_package",
          "record_unknown",
        ],
        instruction:
          "When acquisition is requested and code evidence helps, pull the selected package's APK set into the chosen local output directory and inspect the resulting APKs without executing them. Report each criterion as answered, partially answered, or unresolved with Evidence IDs, the actions actually performed, limitations, and a concrete next probe. Do not add installation, file pushes, settings changes, force-stop cleanup, or uninstall as implied follow-up actions.",
      },
    ],
  },
] as const satisfies readonly PromptContract[];
