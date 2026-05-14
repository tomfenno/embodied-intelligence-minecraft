# `command_failure` Messages Lose the Real Blocker — `root_cause=unknown` and Advisory Tail

## Summary

Many `command_failure` messages emitted by the search-replanner action
loop report `root_cause=unknown` and end with a generic advisory line
(`"Going to the surface at y=102."`, `"Pathfinding stopped: Path was
stopped …"`) even though the same skill output blob, visible in earlier
`[pathfinding_wrapper] … tail="…"` lines of the same `runner_stdout.log`,
clearly names the underlying blocker — most often
`"Cannot break stone with current tools."`.

The result is an action-result message whose structured headline
(`root_cause=`) and free-text tail (`| "<last line>"`) both fail to
surface the cause that the wrapper had already observed and printed.

## Confidence

**High**. The cause is mechanically reproducible in the run logs: in
`pork_chops` over a dozen `[SPL][search] Result` blocks share the same
`root_cause=unknown` despite the immediately-preceding wrapper tail
containing `"Pathfinding stopped: Cannot break stone with current
tools."`. The mechanism is also visible in code (see *Important Files*):
`parse_skill_output` recognises this blocker as `blocker_kind='no_tool'`
but `build_command_failure_message` does not promote `blocker_kind` into
the `root_cause` headline, and the trailing `last_line` is whatever
non-empty line came last in the blob.

## Why This Is a Message Inaccuracy

The `message` field on a `command_failure` action result is what
`failure_replanner.md` and `search_replanner.md` instruct the LLM to
read in order to choose between fix-locally / relocate / retry. The
intended shape (`docs/replanner_action_result_messages.md` §6) is:

```text
command_failure: cmd=<command>; verifier=<reason>; root_cause=<kind>[ at (x,y,z)]; pos=(x,y,z) | "<last skill line>"
```

When `root_cause=unknown` and the `"<last skill line>"` is an advisory
rather than the cause, the message claims the system has no diagnosis
even though the **same blob the message was built from** already
identified the blocker. The message is therefore unsupported by its
own source material as well as by the wrapper diagnostics printed
earlier in the run.

## Examples

### Example 1 — `Cannot break stone with current tools` reduced to `root_cause=unknown` with surface advisory as tail

- Run directory: `achievement_hunter/message-audit-runs/pork_chops/`
- Message source: `achievement_hunter/message-audit-runs/pork_chops/runner_stdout.log`
- Rollout/source evidence: `achievement_hunter/message-audit-runs/pork_chops/runner_stdout.log` (wrapper tail on the same action) and `achievement_hunter/message-audit-runs/pork_chops/rollout_trace.json`
- Message excerpt (`runner_stdout.log:541-546`):

```text
[SPL][search] Result: {
  command: '!goToSurface()',
  success: false,
  kind: 'command_failure',
  message: 'command_failure: cmd=!goToSurface(); verifier=n/a; root_cause=unknown; pos=(-5.5,87,184.5) | "Going to the surface at y=102."'
}
```

- Contradicting evidence — the wrapper line for the action that produced
  this result (`runner_stdout.log:540`):

```text
[2026-05-14T20:50:25.754Z] [pathfinding_wrapper] goToSurface attempt=5 phase=final depth=4 outcome=non_retryable elapsed=78937ms moved=2.8 tail="… Pathfinding stopped: Cannot break stone with current tools. Pathfinding stopped: Path was stopped before it could be completed! Thus, the desired goal was not reached.. Going to the surface at y=102."
```

- Explanation: The same skill blob the message is built from carries
  `"Pathfinding stopped: Cannot break stone with current tools."` — a
  recognised blocker. The headline still says `root_cause=unknown`, and
  the trailing `| "<last line>"` is `"Going to the surface at y=102."`
  (an advisory the skill prints unconditionally), not the blocker line.
  The replanner's "address the navigation blocker" branch keyed on
  `root_cause`/blocker info gets no signal.

### Example 2 — Repeated `!goToXZ` failures: blocker present, message says unknown

- Run directory: `achievement_hunter/message-audit-runs/pork_chops/`
- Message source: `achievement_hunter/message-audit-runs/pork_chops/runner_stdout.log`
- Rollout/source evidence: same file, immediately-preceding wrapper line
- Message excerpt (`runner_stdout.log:577-582`):

```text
[SPL][search] Result: {
  command: '!goToXZ(-5, 430, 8)',
  success: false,
  kind: 'command_failure',
  message: 'command_failure: cmd=!goToXZ(-5, 430, 8); verifier=n/a; root_cause=unknown; pos=(-5.5,87,184.5) | "Pathfinding stopped: Path was stopped before it could be completed! Thus, the desired goal was not reached.."'
}
```

- Contradicting evidence (`runner_stdout.log:576`):

```text
[2026-05-14T20:50:31.109Z] [pathfinding_wrapper] goToXZ attempt=1 phase=final depth=0 outcome=non_retryable elapsed=1011ms moved=0.0 tail="…ay using destructive movements. Pathfinding stopped: Cannot break stone with current tools. Pathfinding stopped: Path was stopped before it could be completed! Thus, the desired goal was not reached.."
```

- Explanation: The actionable blocker
  (`Cannot break stone with current tools`) is in the blob but is the
  *middle* line. `build_command_failure_message` picks `last_line` as the
  trailing message, which here is the generic "Path was stopped" wrap-up
  line — true but downstream of the real cause. `root_cause` stays
  `unknown` because the recognised blocker is captured into
  `blocker_kind`/`no_tool_for`, fields the failure-message formatter
  doesn't render into the headline.

### Example 3 — Same pattern, different command, same misleading advisory tail

- Run directory: `achievement_hunter/message-audit-runs/pork_chops/`
- Message source: `achievement_hunter/message-audit-runs/pork_chops/runner_stdout.log`
- Rollout/source evidence: `achievement_hunter/message-audit-runs/pork_chops/runner_stdout.log:564`
- Message excerpt (`runner_stdout.log:565-570`):

```text
[SPL][search] Result: {
  command: '!goToSurface()',
  success: false,
  kind: 'command_failure',
  message: 'command_failure: cmd=!goToSurface(); verifier=n/a; root_cause=unknown; pos=(-5.5,87,184.5) | "Going to the surface at y=102."'
}
```

- Contradicting evidence (`runner_stdout.log:564`):

```text
[2026-05-14T20:50:29.273Z] [pathfinding_wrapper] goToSurface attempt=1 phase=final depth=0 outcome=non_retryable elapsed=1004ms moved=0.0 tail="… Pathfinding stopped: Cannot break stone with current tools. Pathfinding stopped: Path was stopped before it could be completed! Thus, the desired goal was not reached.. Going to the surface at y=102."
```

- Explanation: Same shape as Example 1 — the action runs, the wrapper
  observes `Cannot break stone with current tools`, and the
  `command_failure` message still emits `root_cause=unknown` with the
  surface-advisory line in the tail. Because the tail is a recurring
  scripted advisory rather than the cause, every repeat looks the same
  to a reader, even though each represents the same underlying
  no-tool-for-stone state. This is the pattern that drives the replanner
  into ten attempts of nearly identical relocations.

## Important Files

- `achievement_hunter/src/pipeline/structured_loop/result_messages.js`
  - `parse_skill_output` (lines 76-158): does capture
    `Cannot break X with current tools` as `blocker_kind='no_tool'` /
    `no_tool_for=X`, but `root_cause_kind` only resolves to
    `tool_missing` for the *different* upstream string
    `Don't have right tools to harvest <X>` (the `TOOL_MISSING_RE`
    branch). The two strings are distinct and only one feeds into the
    headline kind.
  - `format_root_cause` (lines 192-207): renders a fixed catalogue
    (`workstation_placement_failed`, `workstation_missing`,
    `tool_missing`, `insufficient_smelt_input`, `fuel_missing`,
    `inventory_full`), with no branch for `no_tool` /
    `pathfinder_bail`. So even though those fields are populated on the
    parsed object, they do not reach the headline.
  - `build_command_failure_message` (lines 211-243): uses
    `parsed.last_line` for the `| "<tail>"` segment. `last_line` is the
    final non-empty line of the skill blob — when an upstream advisory
    (`"Going to the surface at y=102."`) is appended after the cause,
    the tail becomes the advisory.
- `achievement_hunter/src/pipeline/command_utils.js` — call site that
  passes the env result's `message` (raw skill blob) into
  `build_command_failure_message`; does not pre-extract the blocker
  before formatting.
- `achievement_hunter/src/pipeline/structured_loop/search_replanner.js`
  - `is_pathfinding_failure` (line ~49 per
    `docs/replanner_action_result_messages.md` PR A notes): explicitly
    handles `mode_interrupted` and pathfinding-shaped failures but
    relies on the upstream message kind/headline to short-circuit, so
    a `root_cause=unknown` headline blunts its routing.
- `achievement_hunter/docs/replanner_action_result_messages.md` §6
  (Quick reference) — documents the intended `root_cause=<kind>` and
  trailing `| "<last skill line>"` shape; the observed messages violate
  the intent when a `no_tool` blocker is present.

## Notes

- All examples above come from one run (`pork_chops`) because that is the
  only run in the audit where the search-replanner action loop fired
  enough times to expose the pattern at volume. The same code path runs
  for every `command_failure` produced by the SPL or replanner — once
  the upstream skill emits the `Cannot break X with current tools` line,
  the same masking occurs regardless of task.
- The `Path was stopped before it could be completed!` line is itself
  an upstream pathfinder wrap-up rather than a root cause; when it ends
  up as the message tail (Example 2) the same observation applies — the
  tail is a downstream symptom, not a diagnosis.
- The grouping is by shared cause (failure-message formatter cannot see
  `blocker_kind` / picks the wrong `last_line`); the `root_cause=unknown`
  and "wrong tail" symptoms are two surface expressions of that one
  formatting gap.
