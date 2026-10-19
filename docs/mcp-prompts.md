# Guided MCP prompts and completion

REA exposes eight provider-neutral investigation workflows through the MCP
`prompts` capability. They complement the generated tool catalog; they do not add, remove, or
invoke tools by themselves.

## Prompt inventory

| Prompt                            | Purpose                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `improve_application`             | Turn a concrete task and acceptance criteria into ranked changes and a coding handoff. |
| `investigate_device_task`         | Investigate one connected Android or TV task and verify outcomes on the exact device.  |
| `investigate_feature`             | Trace a feature from discovery into relevant function evidence.                        |
| `compare_application_versions`    | Compare two shipped artifacts, with optional static and runtime follow-up.             |
| `verify_reconstruction`           | Evaluate a finite reconstruction specification against retained comparison Evidence.   |
| `trace_crash`                     | Correlate a crash symptom with static paths and optional process capture evidence.     |
| `audit_residual_unknowns`         | Audit current residual-unknown heads and evidence-qualified resolution.                |
| `prepare_bounded_process_capture` | Design a bounded controlled process experiment before execution.                       |

Every rendered prompt provides optional starting points using current REA tool
names. Agents can call tools directly, skip irrelevant suggestions, and inspect
provider or target state only when it helps answer the request or a tool
requires it. The prompts also ask agents to keep observations, inferences, and
unknowns distinct. Requested prompt arguments and completion choices are
rendered as untrusted selection data, not instructions or authorization.
Tool results include their Evidence inline. Prompts do not require a bundle or
resource fetch to read a result; an Evidence ID is only a reference when a
prompt argument or tool explicitly accepts one.

For a JavaScript/Electron application directory, `investigate_feature` points
directly to `analyze_javascript_application` with `input_path`; it does not
require `open_binary`. When that Evidence, or `inspect_binary_layout` Evidence,
is already retained, it suggests `inspect_analysis_view` before tracing a
feature seed. The CLI equivalent is `rea analyze <directory>`.
`open_binary` and the doctor target check admit files and macOS app bundles.
A directory outside that opening route is reported with an available analysis
action; this does not establish support for every directory format.

For target paths in `compare_application_versions`, the prompt suggests
opening each target before calling `inspect_artifact`; inspection operates on
the active target and returns the graph and findings together inline.

`improve_application` requires `task_goal` and `acceptance_criteria`. It starts
with a finite checklist, routes the supplied artifact or runtime to existing
tools, and reuses retained Evidence. The requested deliverable ranks practical
changes by user impact, evidence strength, effort, and risk, then supplies a
concrete coding handoff and verification for each criterion. Ordinary source
changes use the agent's normal coding tools. Proposed changes, estimated
benefits, and proposed checks remain distinct from performed work and measured
outcomes.

`investigate_device_task` requires an exact `serial`, `task_goal`, and
`acceptance_criteria`. An optional `package_name` or `component` selects the app;
it does not authorize a launch. The workflow inspects existing device, package,
window, and process facts before using an existing start tool only when the
user's session request includes that action. Explicit components must belong
to the selected package. Launch verification uses fresh exact-package focus
and, when requested, screenshots and bounded logs; command success alone does
not establish task completion. Focus and screenshots do not establish playback,
speed improvements, ad blocking, or successful deep-link content. Those claims
need their own observations. The workflow adds no pairing, network discovery,
installation, settings changes, or device-control capabilities.

For both task workflows, finish with each acceptance criterion answered,
partially answered, or unresolved, citing Evidence and the smallest useful
next probe for gaps. Prompt rendering performs no analysis or device action.

Use standard MCP discovery and retrieval:

```json
{ "method": "prompts/list", "params": {} }
```

```json
{
  "method": "prompts/get",
  "params": {
    "name": "investigate_feature",
    "arguments": {
      "feature": "offline search",
      "document": "Notes"
    }
  }
}
```

For an outcome-driven investigation:

```json
{
  "method": "prompts/get",
  "params": {
    "name": "improve_application",
    "arguments": {
      "task_goal": "Make saved notes searchable offline",
      "acceptance_criteria": "Find a previously saved note while the network is unavailable",
      "target_path": "/absolute/path/to/notes-app"
    }
  }
}
```

The server advertises `listChanged: true`. Updating a registered guided prompt
emits `notifications/prompts/list_changed`, allowing clients to refresh their
cached prompt catalog.

## Session-aware completion

MCP `completion/complete` completes guided-prompt arguments; it does not define
completion for arbitrary tool-call arguments. REA attaches completion to
optional prompt arguments that accept a session value. Suggestions provide
identifiers only; they do not retrieve or replace the inline Evidence result.

```json
{
  "method": "completion/complete",
  "params": {
    "ref": {
      "type": "ref/prompt",
      "name": "investigate_feature"
    },
    "argument": {
      "name": "procedure",
      "value": "0x10"
    },
    "context": {
      "arguments": {
        "document": "Notes"
      }
    }
  }
}
```

Completion sources are live projections of the current session:

Document and procedure completion in a binary session reads an already-ready
provider; it does not start analysis. A cold provider, a target transition, or
unavailable inventory can return no suggestions. Run an analysis query first
when you need inventory from a provider that supplies it. An empty completion
list does not establish that the target has no procedures.

| Argument family     | Source and filtering                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document            | Current provider `list_documents` result.                                                                                                            |
| Procedure           | The complete `list_procedures` inventory; all procedure addresses and uniquely named procedures are offered. Optional document context is forwarded. |
| Provider            | `auto` plus sorted deep candidates from the current binary session; target-free completion does not start them.                                      |
| Evidence            | Evidence IDs retained in the current session ledger, offered only for prompt arguments that accept Evidence references.                              |
| Process capture     | IDs for retained Evidence whose operation and validated result identify process capture.                                                             |
| Artifact manifest   | Manifest IDs from schema-valid retained artifact inventories.                                                                                        |
| Artifact occurrence | Occurrence IDs present in schema-valid retained artifact inventory pages.                                                                            |
| Residual unknown    | Current non-resolved unknown heads only.                                                                                                             |

Suggestions are Unicode-normalized, case-insensitive prefix matches. The server
deduplicates them and sorts by code point for deterministic results. Procedure
completion derives candidates from the complete inventory, so a name is offered
only when it identifies one address in that inventory. Completion returns all
matching values; it does not expose paging controls.

## Lifecycle and safety

Completion has no cache in REA. Opening or switching a target changes document
and procedure suggestions on the next request. Closing the binary clears its
Evidence ledger and residual-unknown registry, so identifiers from the closed
session are no longer suggested. Provider errors, unsupported operations, and
malformed provider output produce an empty completion list rather than an
unverified identifier.

Suggestions are starting points, not tool calls. A tool acts on the target,
operation, and lifecycle fields in its own request; selecting a suggestion does
not execute it or broaden those fields.
