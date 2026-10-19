# Task workflows in this fork

These prototypes turn REA's analysis and device Evidence into specific outcomes.
Use the smallest workflow that answers the question.

| Goal                                              | Starting point                                      | Deliverable                                                           |
| ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Review a software update before rollout           | [Release Watch](release-watch/README.md)            | Capability changes, rollout findings, and supporting Evidence         |
| Find opportunities in a product category          | [Landscape](landscape/README.md)                    | Category map, openings, and a clean-room brief                        |
| Inspect an Android device or verify an app launch | [Device Tasks](device-tasks/README.md)              | Step outcomes, exact-device Evidence, and a focus-verification report |
| Improve an application for a user task            | [`improve_application`](../docs/mcp-prompts.md)     | Prioritized changes, coding handoff, and acceptance checks            |
| Investigate a connected-device goal               | [`investigate_device_task`](../docs/mcp-prompts.md) | Targeted observations and explicit verified/unresolved outcomes       |

Build this checkout first:

```sh
npm ci
npm run build:cached
```

Run each product's checked-in CLI from this checkout. The prototypes are private
packages and are not included in the upstream `rea-agents` npm release. An
existing upstream MCP installation also needs to run this checkout's server to
advertise the new prompts; changing instruction files alone does not add them.

An analysis finding, a successful launch, and a completed user task establish
different things. Every workflow keeps its Evidence and limitations. For
example, an app's foreground focus does not establish that a requested video
is playing, and static code does not measure a UI speedup. Choose an observable
acceptance condition before reporting an improvement as verified.

The device-action composition is exploratory. It uses existing REA operations
on an explicitly selected, already connected device; actual hardware coverage
and any maintainer decision needed for official distribution remain separate
from a passing simulated-device test.
