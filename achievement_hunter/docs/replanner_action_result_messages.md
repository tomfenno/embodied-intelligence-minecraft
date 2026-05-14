# Improving Action-Result Messages for the Search & Failure Replanners

## Purpose

The `search_replanner` and `failure_replanner` LLMs receive a list of prior
action results as their primary diagnostic signal:

```jsonc
// search_replanner: previous_summaries[i].results[k]
// failure_replanner: failed_trace.summary.failed_steps[k] (+ steps[k].result)
{ "command": "...", "success": false, "kind": "...", "message": "..." }
```

`kind` tells the model **what category** of failure occurred and `message` is
the only free-form channel for the **specific cause**. The prompts
(`docs/prompts/search_replanner/search_replanner.md`, `docs/prompts/failure_replanner/failure_replanner.md`)
both explicitly instruct the model to read these fields to choose between
fix-locally, relocate, and retry — so the quality of the messages directly
caps the quality of recovery plans.

After reading the code paths that build these results and the
`runner_stdout.log` samples in
`evaluation_harness/experiments/achievement_hunter_eval_v2_full/`, this
document catalogues every kind/message template that reaches the replanners,
identifies where the messages under-inform, and proposes a concrete
step-by-step plan to upgrade them.

---

## 1. Code-flow map

### Where the action results are minted

| Source | Result shape | Consumed by |
|---|---|---|
| `pipeline/structured_loop/actions.js` `execute_task_action` | `create_step_result(success, kind, message)` | `failed_trace.summary.failed_steps` → failure_replanner; seeds `recover_failed_search`'s `attempt 0` seed |
| `pipeline/structured_loop/failure_replanner.js` `run_action` | `create_action_result(command, success, kind, message)` | `previous_diagnoses[i]` (next failure_replanner attempt) — **NOT** sent to the LLM today; only `actions` are |
| `pipeline/structured_loop/search_replanner.js` `run_action` | `create_action_result(command, success, kind, message)` | `previous_summaries[i].results` shown to search_replanner LLM |
| `pipeline/command_utils.js` `executeCommandWithModeRecovery` | `{success, message, mode_interrupted?, mode_interrupt_counts?, position_before?, position_after?}` | Wrapped into `command_success` / `command_failure` / `mode_interrupted` by the SPL |
| `pipeline/command_verifier.js` verifiers | `{ok, reason}` — reason is prepended as `verifier_failed:<reason> \| <skill msg>` | Reaches replanners as `command_failure` |
| `pipeline/structured_loop/search.js` `run_search` / `run_breadth_first_sweep` | `{found, message, ...}` — `last_message` is whichever per-radius skill output came last | Becomes the `search_exhausted` / `search_found_not_reached` / `search_success` message |
| `src/agent/library/skills.js` `log(bot, ...)` calls | Raw free-text appended to `bot.output`, returned as `result.message` after each skill call | Embedded inside every command result message |

### Kind taxonomy seen by the replanners

| Kind | Where produced | What the LLM is told today |
|---|---|---|
| `command_success` | `actions.js` (SPL) and verifier-confirmed success | `message` = whole skill `bot.output` blob |
| `command_failure` | SPL when skill returns `success:false`, or verifier reclassifies a success | Raw skill output, sometimes prefixed `verifier_failed:<reason> \|` |
| `mode_interrupted` | `executeCommandWithModeRecovery` after `MAX_MODE_INTERRUPTS=5` | `"mode_interrupted: unstuck×5; bot Δ=(dx,dy,dz) over retries; command never completed"` |
| `unstructured_failure_result` | SPL when failure has no message at all | Hard-coded `"command failed with unstructured or empty result"` |
| `unexpected_action_kind` | SPL when mediator returns non-command | `"Unexpected AM action kind: <kind>"` |
| `runner_exception` | `run_action` catch blocks in both replanners | `String(e)` — usually one line, no stack, no bot-state context |
| `invalid_command` | `run_search_action` arg validation | `"!search requires a non-empty string target"` |
| `search_success` | `handle_search_action`, `run_search_action` | Whatever the last skill `Action output:` was (often noisy / contains pathfinder warnings) |
| `search_exhausted` | `run_search` after all radii fail | `last_message` only — the **last per-radius** skill output, no rollup |
| `search_found_not_reached` | `run_search_action` when `found=true` but `check_search_complete` is false post-skill | Same last skill message, no explicit "navigation blocked because …" framing |
| `search_already_attempted` | per-plan / per-recovery dedup | `"Search for X already attempted in this plan/recovery sequence"` |
| `sweep_target_found` | `handle_search_sweep` success | `"Found X via candidate Y"` (+ `per_source_outcomes`) |
| `sweep_exhausted` | `handle_search_sweep` total failure | `"All sources exhausted at radius 511: a, b, c"` (+ `per_source_outcomes`) |

---

## 2. What the replanners actually see in practice

The runs in `achievement_hunter_eval_v2_full/our_agent/seed_12345/` show
several recurring message-quality problems:

### Problem 1 — `search_exhausted` carries only the last radius's skill output

`hot_stuff/runner_stdout.log:202-209` (search for `lava`):

```
[SPL] Search result: {
  success: false,
  message: 'Action output:\n' +
    'Found lava at (124, 69, -37). Navigating...\n' +
    'Path not found, but attempting to navigate anyway using destructive movements.\n' +
    'Pathfinding stopped: Cannot break stone with current tools.\n' +
    'Pathfinding stopped: Path was stopped before it could be completed!\n'
}
```

This is the **r=128** message. The replanner has no idea:

- What radii were tried (`[32, 64, 128, 256]`).
- That r=32 and r=64 said "Could not find any lava" (i.e. the cause shifted from absent → present-but-unreachable).
- That this is really `search_found_not_reached`-shaped (location is known!), but the kind label is `search_exhausted`.

`pork_chop/runner_stdout.log:158-167` (sweep for `pig`):

```
message: 'Action output:\nFound pig 141.4270195391474 blocks away.\n' +
         'Path not found, but attempting to navigate anyway using destructive movements.\n' +
         'Pathfinding stopped: Cannot break stone with current tools.\n' +
         ...
```

The replanner gets `sweep_exhausted: "All sources exhausted at radius 511: pig"`
(misleading — radii cap at 256 in the search reference doc) and a free-text
distance with floating-point noise. The `Cannot break stone with current tools`
diagnostic is buried, not surfaced as a structured cause.

### Problem 2 — verifier failure messages are technical, not actionable

`acquire_hardware/runner_stdout.log:143-149`:

```
[SPL][cmd] Verifier reclassified "!smelt_item("raw_iron", 1, "oak_planks")" as failure: no_iron_ingot_delta
[SPL] Command result: {
  success: false,
  message: 'verifier_failed:no_iron_ingot_delta | Action output:\n' +
    'Failed to place furnace at (104, 130, -24).\n' +
    'There is no furnace nearby and you have no furnace.\n'
}
```

The replanner has to parse `no_iron_ingot_delta` (jargon) and then deduce the
real cause from the trailing skill log. It would be more direct as
`smelt_no_output: input=raw_iron expected=iron_ingot; furnace placement failed at (104,130,-24) — no buildable surface; relocate before retrying.`

### Problem 3 — `mode_interrupted` doesn't say which mode triggered or why

`command_utils.js:177-207` produces:
`"mode_interrupted: unstuck×5; bot Δ=(5.2,3.0,-1.5) over retries; command never completed"`

This says **which mode and how often**, but not the per-trigger reason
(unstuck near lava, danger from creeper, etc.). The replanner gets no signal
about whether moving in a specific direction would help.

### Problem 4 — `runner_exception` is bare `String(e)`

Both replanners do `String(e)`. This loses:

- The bot's position when the exception fired.
- Whether the bot was mid-pathfinding, mid-collect, mid-place.
- A short stack-trace tail naming the throwing site.

A typical `e.message` like `"Cannot read properties of undefined (reading 'x')"`
gives the LLM nothing to plan around.

### Problem 5 — `command_success` messages contain failure-shaped text

`moar_tools/runner_stdout.log:111-117`:

```
[SPL] Command result: {
  success: true,
  message: 'Action output:\nFailed to place crafting_table at (106, 137, -26).\n' +
    'Successfully crafted wooden_axe, you now have 1 wooden_axe.\n' +
    'Collected 1 crafting_table.\n'
}
```

When this becomes the model's "evidence of success", it sees `"Failed to
place crafting_table"` first. Successful command messages should be
normalized to the **outcome** line (`Successfully crafted wooden_axe`) and
drop intermediate skill chatter, or at least move the success summary to the
front.

### Problem 6 — `search_found_not_reached` doesn't preserve the located coordinates

`run_search_action` in `search_replanner.js:182-186` returns
`create_action_result(command, false, 'search_found_not_reached', message)`
where `message` is again the raw skill blob. The coordinates the skill found
(`"Found pig at (124, 69, -37)"`) are inside the message string but not in a
structured field. The prompt explicitly tells the LLM to "address the
navigation blocker", but extracting where the target was located requires
parsing free text.

### Problem 7 — `search_already_attempted` doesn't carry the prior outcome

When a `!search` short-circuits to `search_already_attempted`, the LLM only
hears that the search "was already attempted". It doesn't know whether the
prior result was `search_exhausted` (absent), `search_found_not_reached`
(unreachable), or `search_success` (already nearby — possibly stale).

### Problem 8 — `unstructured_failure_result` discards potentially useful state

When the skill returns truthy-but-shapeless failure, the kind becomes
`unstructured_failure_result` with a hard-coded string. The original `result`
object (which may contain `{success: false}` plus other keys) is dropped on
the floor.

### Problem 9 — Sweep `outcomes` map is on the failed-step but not in search_replanner's `previous_summaries`

`handle_search_sweep` attaches `per_source_outcomes` to `sweep_step.result`,
which `project_failed_steps` surfaces to the **failure** replanner — but
when the sweep falls through to `recover_failed_search` first (the search
replanner), the outcomes map is **not** seeded into `previous_summaries`.
The search replanner is left to infer which sources were located-but-
unreachable vs. truly-absent.

### Problem 10 — Kinds vs message-content contract is under-specified

The `search_replanner.md` prompt at line 53 already lists every kind
the system can produce (`command_success`, `command_failure`,
`search_success`, `search_exhausted`, `search_found_not_reached`,
`search_already_attempted`, `invalid_command`, `mode_interrupted`,
`runner_exception`). What it **doesn't** spell out is what each kind's
`message` is guaranteed to contain. For example, the prompt instructs
the LLM to "address the navigation blocker" when it sees
`search_found_not_reached`, but never tells the model that the
message reliably contains `located_at=(x,y,z)` or `blocker=<kind>`.
Today it doesn't, so the prompt is honest by accident.
Steps 2/4/6 add the structured content; Step 10 must add the
"what to expect in the message" paragraph per kind so the prompt and
implementation actually match.

The `failure_replanner.md` prompt has the larger gap: it doesn't
describe `previous_diagnoses[i].results` at all, because Step 0 hasn't
landed yet and the field isn't present.

### Problem 11 — Stale radius literal in the sweep-exhausted message

`SEARCH_RADII` in `pipeline/structured_loop/config.js:70` is
`[32, 64, 128, 256]`. But `actions.js:421` constructs the
`sweep_exhausted` message with a literal `"All sources exhausted at radius 511"`:

```js
sweep_step.result = create_step_result(
    false, 'sweep_exhausted',
    `All sources exhausted at radius 511: ${
        sweep_result.sources_exhausted.join(', ')}`);
```

The `511` is stale (probably from when `SEARCH_RADII` ended at 511) and
directly contradicts the `actions_reference.json` doc. Step 10c fixes
this message text to derive from `SEARCH_RADII` (e.g. `radii_tried=[32,64,128,256]`),
not a hard-coded number.

---

## 3. Cross-cutting message-quality principles

Adopt these conventions for every result message that flows into a replanner:

1. **Lead with a structured prefix**, then human-readable detail.
   `kind:summary | detail`. Example:
   `search_exhausted: pig not found in radii [32,64,128]; located at (224,125,-98) at r=256 but pathfinding blocked: Cannot break stone with current tools.`

2. **Preserve coordinates as fields, not prose.** If the cause involves a
   located target or a placement failure, return an extra field
   (`located_at`, `placement_failed_at`) so the replanner can use it
   without regex-parsing.

3. **Name the root cause, not the symptom.** `no_iron_ingot_delta` is the
   verifier symptom; `furnace_placement_failed` (or `furnace_missing`) is
   the cause.

4. **Keep success messages crisp.** Strip intermediate "Failed to place …"
   noise from command_success when the final outcome was success. Move
   the success line first.

5. **Use a stable vocabulary.** Document the full kind set + message
   templates in one place and reference it from both prompts. Today the
   two prompts each list a partial, not-quite-overlapping subset.

6. **Don't lose context across kinds.** When a kind is the result of a
   reclassification (verifier, dedup, exhaustion), include the
   pre-reclassification facts in the message.

---

## 4. Step-by-step improvement plan

Each step is small enough to land independently. Order is roughly
"highest payoff first," based on which messages the replanners actually
make decisions from.

Three steps are gates that must ship together, not in sequence: **Step 2
(search outcomes)**, **Step 4 (verifier failure)**, and **Step 6
(runner_exception)** each add structured fields to the action result that
only deliver value once **Step 10 (prompts)** tells the LLM how to read
them. Treat 2+10, 4+10, and 6+10 as paired commits.

### Dependency order

```
Step 1 (helpers)  ──►  Step 2  ──►  Step 3
                  │            └──►  Step 8
                  ├──►  Step 4
                  ├──►  Step 5
                  ├──►  Step 6
                  └──►  Step 7

Step 0   — independent of Step 1, but its visible payoff requires Steps 2/4/6 messages to be richer.
Step 4.5 — independent fix; can land before, with, or after Step 1.
Step 9   — independent.
Step 10  — ships paired with each of Steps 2, 4, 6, 7, 8 (NOT sequenced after them).
Step 11  — tests; interleave with whichever step it covers.
Step 12  — token-budget guardrails; ships with or after Step 11.
```

Recommended PR batching (4 PRs total):

- **PR A: ✅ Landed.** Step 0 + Step 4.5 + Step 9. All independent correctness/wiring fixes; no helpers needed. (See "PR A landing notes" below.)
- **PR B: ✅ Landed.** Step 1 + Step 11 (helper skeleton + snapshot test scaffolding). (See "PR B landing notes" below.)
- **PR C: ✅ Landed.** Steps 2 + 3 + 8, paired with the matching Step 10 prompt edits (search-side message work, end-to-end). (See "PR C landing notes" below.)
- **PR D: ✅ Landed.** Steps 4 + 5 + 6 + 7, paired with the matching Step 10 prompt edits (command-side message work). (See "PR D landing notes" below.)
- **Then:** Step 12 as a follow-up PR with token-budget measurements. (Step 13 removed — see below.)

### PR A landing notes

Files changed (4):

- `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` — Step 0 (deferred `previous_diagnoses` push with `results`) + Step 4.5 (mode-interrupted preservation in `run_action`).
- `achievement_hunter/src/pipeline/structured_loop/search_replanner.js` — Step 4.5 (mode-interrupted preservation in `run_action`).
- `achievement_hunter/src/pipeline/structured_loop/actions.js` — Step 9 (`build_unstructured_failure_message` + use it in the `unstructured_failure_result` branch).
- `achievement_hunter/docs/prompts/failure_replanner/failure_replanner.md` — Step 0 prompt update describing the new `previous_diagnoses[i].results` field.

Validation:

- All four files pass `node --check`.
- `npm test -- achievement_hunter/src/pipeline/__tests__` → 192 / 192 tests pass.
- No existing tests reference `previous_diagnoses`, `unstructured_failure_result`, or `mode_interrupted` in the changed code paths, so no test deletions or modifications were needed. Snapshot tests for the new shapes are deferred to PR B's Step 11.

### PR B landing notes

Files added (2):

- `achievement_hunter/src/pipeline/structured_loop/result_messages.js` (406 lines) — `parse_skill_output` + 8 `build_*` helpers per Step 1. Pure functions, no agent I/O. Centralises every regex against upstream skill output so future upstream string changes patch in one place.
- `achievement_hunter/src/pipeline/__tests__/result_messages.test.js` (438 lines) — 37 inline-fixture tests covering parser + each builder. Real skill blobs captured from `hot_stuff`, `pork_chop`, `acquire_hardware`, `moar_tools` eval runs.

Validation:

- `node --check` passes on the new module.
- New test file: 37 / 37 tests pass.
- Full suite: 272 / 272 tests pass (11 files) — no regressions in `command_verifier_useOn`, `checkpoint`, `self_refine`, `action_refs_sync`, or any agent-side test.
- Dynamic import via `node -e "import(...)"` confirms all 9 named exports are reachable.

Design notes for downstream PRs (C / D):

- **`parse_skill_output` priority order** matches Step 4's table: `workstation_placement_failed` wins over `workstation_missing` when both patterns match the same blob; `no_tool` overrides an earlier `pathfinder_bail` since the more-specific blocker is preferable for the search_replanner's relocation/fix decision.
- **`build_command_failure_message` always includes the skill tail** when present. The earlier suppress-when-known-kind heuristic was dropped during self-review — the tail carries useful secondary signal (e.g. for `workstation_placement_failed`, the trailing "There is no furnace nearby" tells the LLM the workstation is globally absent, not just unplaceable at one spot).
- **`build_command_success_message` scans success-summary lines from the end** so the *final* outcome line wins when multiple candidates exist (e.g. for `!useOn`, "Used bucket on lava" beats the earlier "You have reached at" mid-step line).
- **`build_mode_interrupted_message` accepts an optional `mode_reasons` map**, forward-compatible with Step 5's per-mode reason enrichment. PRs C/D can ignore this field until Step 5 lands.
- **Token cap (200 chars on skill tail) is a guideline only.** Headlines are not capped. Per user direction, no strict assertion in tests.

### PR C landing notes

Files changed (5):

- `achievement_hunter/src/pipeline/structured_loop/search.js` — `run_search` now classifies outcome (`'reached' | 'absent' | 'found_not_reached'`) and builds the result message via the helpers from PR B. `run_breadth_first_sweep`'s per-source outcomes upgrade from a plain string to a structured `{outcome, located_at?, located_distance?, blocker_kind?, blocker_detail?, last_message?}` object. Soft-skips unsupported abstracts in the single-target path (matches the sweep's behaviour). Imports `getBiomeName` / `getPosition` for bot-context snapshots.
- `achievement_hunter/src/pipeline/structured_loop/actions.js` — `handle_search_action` emits both `search_exhausted` and `search_found_not_reached` (kind label depends on `run_search.outcome`). The SPL routing now invokes the search_replanner for *either* kind (previously only `search_exhausted`). New `searched_targets_outcomes` Map alongside the existing Set, written on dedup-add and read on dedup-hit to populate `prior_kind` / `prior_detail` via `build_search_already_attempted_message`. The Map is checkpoint-persisted via `persist_active_task` as an entries array (Map isn't JSON-serialisable). The stale `radius 511` literal in `sweep_exhausted` is replaced with `radii_tried=[${SEARCH_RADII.join(',')}]`.
- `achievement_hunter/src/pipeline/structured_loop/search_replanner.js` — `recover_failed_search` gains optional `seed_sweep_outcomes` and `seed_failure_kind` parameters. New sweep-shaped seed branch builds one `attempt:0` result entry per source with synthesised structured messages so the LLM sees absent vs. located-but-unreachable per source. `run_search_action` simplified to trust `run_search`'s classification; removed the post-hoc `check_search_complete` reclassification dead code. Per-plan `searched_targets_outcomes` Map mirrors the actions.js wiring. The stale `511-block radius` docstring is corrected to `max 256 blocks`.
- `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` — `run_search_action` mirrors the search_replanner: trusts `run_search`'s classification, populates the local `searched_targets_outcomes` Map, removes dead reclassification code. Map is per-recovery scope (not checkpoint-persisted).
- `achievement_hunter/docs/prompts/search_replanner/search_replanner.md` — `previous_summaries[i].results` description now spells out the message contract per kind so the LLM knows it can rely on `located_at=`, `blocker=`, `pos=`, `bot=`, etc. as headline `key=value` pairs rather than parsing prose.

Net diff: +464 / -147 lines across 5 files.

Validation:

- All five files pass `node --check`.
- `npm test` → 272 / 272 tests pass (11 files). No regressions.
- `git grep "radius 511"` → only the stale references that were intentionally fixed.

Intentional behavioural changes (worth flagging in PR description):

1. **`search_found_not_reached` now triggers the search_replanner.** Previously only `search_exhausted` routed through; the located-but-unreachable case fell through directly to the failure_replanner with less context. The search_replanner's `is_pathfinding_failure` short-circuit (D11) and its relocation-vs-fix-locally branching are both designed for this case. Routing both kinds matches the prompt's documented capabilities.
2. **`searched_targets_outcomes` Map is added to the checkpoint schema** (`active_task.searched_targets_outcomes` as an entries array). Existing checkpoints from before PR C are forward-compatible because the read path uses `?? []`. If a checkpoint written by post-PR-C code is read by pre-PR-C code, the new field is silently ignored — also safe.
3. **Sweep handler now passes per-source outcomes** to `recover_failed_search`. The search_replanner's `attempt:0` seed entry now has N result entries (one per source) instead of being empty for sweep callers. The previous behavior (empty seed) effectively hid which sources were absent vs. unreachable; the new shape exposes that distinction.

### PR D landing notes

Files changed (7):

- `achievement_hunter/src/pipeline/command_utils.js` — verifier-reclassified failures now build their message through `build_command_failure_message` (carries `cmd=`, `verifier=`, `root_cause=` from `parse_skill_output`, `pos=`, and the trailing skill line). `build_mode_interrupted_result` now calls `build_mode_interrupted_message`, threads the command through, and reads per-mode trigger reasons from `bot.modes.getLastTrigger`. Both result objects now carry structured side-fields (`verifier_reason`, `mode_reasons`).
- `achievement_hunter/src/agent/ah_modes.js` — `ModeController` gains a `_last_trigger` map plus `recordTrigger(name, reason)` and `getLastTrigger(name)` methods. Three modes record their trigger reasons right before the `execute()` call: `self_preservation` (3 sub-branches: falling block / burning / low health), `unstuck` (stuck + dig context), and `self_defense` (enemy entity type). ~52 LoC added, no upstream patch needed (the AH fork already wholly owns modes).
- `achievement_hunter/src/pipeline/structured_loop/trace.js` — `create_command_success_result` now accepts an optional `command` arg and, when provided, routes the message through `build_command_success_message` (strips plumbing, hoists outcome line, preserves partial-outcome lines). `project_failed_steps` surfaces `mode_reasons` to the replanner alongside the existing `mode_interrupt_counts`.
- `achievement_hunter/src/pipeline/structured_loop/actions.js` — all three `create_command_success_result` call sites pass `action.command`; the mode-interrupt-propagation block now also copies `mode_reasons` onto the trace step.
- `achievement_hunter/src/pipeline/structured_loop/failure_replanner.js` + `search_replanner.js` — `run_action`/`run_search_action` `runner_exception` paths now build their message via `build_runner_exception_message` (carries Error name + message, stack head, command, bot position). Both also propagate `mode_reasons` onto the result object alongside the existing mode counts.
- `achievement_hunter/src/pipeline/dependency_error_classifier.js` — `VERIFIER_TEMPLATES` regex patterns updated from `^verifier_failed:<reason>` to `\bverifier=<reason>\b` to match the new `command_failure: cmd=...; verifier=<reason>; ...` headline shape. The 11 template kinds are otherwise unchanged.
- `achievement_hunter/docs/prompts/failure_replanner/failure_replanner.md` — `previous_diagnoses[i].results` and `failed_trace.summary.failed_steps` documented with the full per-kind message contract (mirrors PR C's search_replanner.md update).

Net diff: total cumulative through PR D is +683 / -199 lines across 9 files (since baseline).

Validation:

- All seven modified JS files pass `node --check`.
- `npm test` → 272 / 272 tests pass (11 files). No regressions.
- The new `dependency_error_classifier.js` regex patterns are tested implicitly: the existing classifier kind taxonomy is unchanged, just the regex shape.
- No test file references the legacy `verifier_failed:` literal; only PR B's `result_messages.test.js` references the new `verifier=` format.

Intentional behavioural changes (worth flagging in PR description):

1. **`command_failure` messages no longer start with `verifier_failed:<reason>`.** The new headline is `command_failure: cmd=<command>; verifier=<reason>; root_cause=<kind>[ at (x,y,z)]; pos=(x,y,z) | "<last skill line>"`. The replanner prompt's "read the headline `key=value` pairs" guidance now points at this format. Anyone parsing live `runner_stdout.log` for the legacy prefix will need to update — only `dependency_error_classifier.js` had such a dependency in-tree and is updated here.
2. **`mode_interrupted` messages grow a per-mode `(reason=<kind>[, <detail>=<val>])` segment** when a recorded trigger reason is available. Modes that don't record a reason (cowardice, hunting, etc., or any mode pre-PR-D) degrade to the legacy `<mode>×<n>` form — no crash, just missing detail.
3. **`command_success` messages are no longer the raw skill blob.** They're plumbing-stripped and outcome-hoisted via `build_command_success_message`. Partial-outcome lines (`Failed to collect X: …` followed by `Collected N X.`) are explicitly preserved. The legacy single-arg `create_command_success_result(result)` call still works (falls back to raw normalize-only), so any out-of-tree caller is forward-compatible.
4. **`mode_reasons` is a new structured field** on action results (peer of `mode_interrupt_counts`). The replanner prompt names it; trace persistence surfaces it through `project_failed_steps`. Older traces (pre-PR-D) simply lack the field and the prompt's guidance degrades cleanly.

### PR A — intentional behavioural change (worth flagging in PR description):

Step 4.5 in `search_replanner.js` activates a dormant branch in
`is_pathfinding_failure(result)` (line 49) that explicitly checks
`result.kind === 'mode_interrupted'`. Before PR A, that branch never
fired in recovery flow because the replanner's `run_action` collapsed
mode-interrupted env results into plain `command_failure`. After PR A,
it fires correctly. Effect: a mode-interrupted recovery action now
terminates the current plan after `MAX_ACTION_RETRIES` retries (instead
of continuing through the rest of the plan with a degraded
classification), and the outer attempt loop regenerates a fresh plan
informed by the structured `mode_interrupt_counts` / `position_before` /
`position_after` fields that PR A also threads through. This matches the
documented intent of `is_pathfinding_failure` (the comment at lines
44–48 names `mode_interrupted` as one of the categories the function is
meant to catch). The behaviour for `failure_replanner.js` is unchanged —
`HARD_FAILURE_KINDS` does not include `mode_interrupted`, so the action
loop continues exactly as it did before, only with a more accurate kind
label + structured fields.

### Step 0 — Surface prior-attempt action results into `failure_replanner`'s LLM input

**File:** `pipeline/structured_loop/failure_replanner.js`.

This step is **prerequisite to every other message-quality step on the
failure_replanner side**. Today (lines 302–306):

```js
previous_diagnoses.push({
  attempt,
  diagnosis: replanner_output.diagnosis,
  actions: replanner_output.actions,
});
```

Each prior recovery attempt records what the LLM *tried* but not *what
happened*. Across attempts, message-quality improvements on action
results are invisible to the failure_replanner because the field is never
sent. (Within a single attempt the latest `failed_trace` does carry
results, so the search_replanner already benefits from message work via
its own `previous_summaries[i].results`; failure_replanner does not.)

**Implementation note (caught in plan-review):** the existing `push`
at lines 302–306 happens **before** `action_results` is declared
(line 311) and populated. The fix is therefore one of:

a. **Move the push to after the action loop** — preferred. Build a
   local `attempt_entry` at the diagnosis log site, append it to
   `previous_diagnoses` only once the action loop completes, with
   `results` already populated:

   ```js
   spl.log('Diagnosis:', replanner_output.diagnosis);
   const attempt_entry = {
     attempt,
     diagnosis: replanner_output.diagnosis,
     actions: replanner_output.actions,
     results: null,   // filled in after the action loop
   };
   log?.recovery_attempt(attempt, task, replanner_output.diagnosis, replanner_output.actions);

   const action_results = [];
   // ... action loop ...

   attempt_entry.results = action_results.map(r => ({
     command: r.command, success: r.success, kind: r.kind, message: r.message,
   }));
   previous_diagnoses.push(attempt_entry);
   ```

   Important: ensure the push still runs when the action loop exits
   early via `hard_failed = true` (line 378). Put the assignment +
   push inside the loop's `try` body **after** the inner `for` exits
   but **before** the `if (hard_failed) { exit_status = ...; break; }`
   check — otherwise hard-failure attempts never accumulate a
   diagnosis, which would change cross-attempt behaviour.

b. **Mutate in place** — alternative, smaller diff: push the
   diagnosis-only entry at line 302 as today, then add
   `previous_diagnoses.at(-1).results = action_results.map(...)`
   after the action loop. Same early-exit caveat applies.

Either way, update `docs/prompts/failure_replanner/failure_replanner.md`
in the same PR to describe the `results` field exactly as the
search_replanner prompt already does for its
`previous_summaries[i].results`.

**Why this is Step 0:** without it, the cross-attempt payoff of Steps
2/4/6/8 lands only for the search_replanner. Wiring this up is a small
mechanical change and unblocks the rest.

### Step 1 — Centralize message construction

**Files:** new `pipeline/structured_loop/result_messages.js`.

Create helpers (and a single skill-output parser they share):

```js
export function build_search_exhausted_message({target, bot_pos, bot_biome}) { ... }
export function build_search_found_not_reached_message({target, located_at, located_distance, blocker_kind, blocker_detail, bot_pos}) { ... }
export function build_command_success_message({command, skill_output}) { ... }
export function build_command_failure_message({command, verifier_reason, root_cause_kind, root_cause_detail, skill_output, position}) { ... }
export function build_mode_interrupted_message({command, mode_counts, position_before, position_after}) { ... }
export function build_runner_exception_message({command, error, position, stack_top}) { ... }
export function build_search_already_attempted_message({target, prior_kind, prior_detail}) { ... }

// One parser for upstream skill blobs. Centralizes every regex against
// mineflayer-pathfinder / Mindcraft skill output so an upstream string
// change only breaks here.
export function parse_skill_output(skill_output) {
  // returns { last_line, place_failed_at?, missing_workstation?,
  //          partial_collected?, located_at?, located_distance?,
  //          blocker_kind?, blocker_detail? }
}
```

Conventions every builder follows:

- Message format is `<kind>: <one-line headline> | <truncated skill tail>`.
  Structured data goes in `<headline>` as `key=value` pairs so the LLM
  can find it without parsing prose.
- Cap each message at a fixed budget (target: ≤ 240 chars before the
  `|`). Longer skill output truncates to its last meaningful line.
- Each builder also returns a structured `details` side-object the
  caller can attach to the action result for non-prompt consumers
  (tests, traces, downstream replanner code) — but the **prompt-facing
  channel remains the `message` string** since neither prompt today
  reads extra fields off the result.
- All upstream skill-string parsing goes through `parse_skill_output`;
  builders don't ad-hoc grep blobs.

### Step 2 — Collapse `search_exhausted` / `search_found_not_reached` into two clear cases

**File:** `pipeline/structured_loop/search.js` (`run_search`,
`execute_search_command`).

`run_search` already sweeps the full radius schedule (capped at 256 — see
the `actions_reference.json` doc); the per-radius timeline is an internal
optimization and not a useful signal to the LLM. There are only two
outcomes the replanner needs to distinguish:

- **Target absent.** Nothing was located in any radius up to 256.
- **Target located but not reached.** At some radius the skill found an
  instance and tried to navigate to it; navigation failed.

Have `run_search` track these two states explicitly while sweeping and
return one of:

```js
// Absent
{
  found: false,
  outcome: 'absent',
  message: `search_exhausted: ${target} — no instance within 256 blocks of (x,y,z); bot biome=<biome>.`,
};

// Located but unreachable
{
  found: false,
  outcome: 'found_not_reached',
  message: `search_found_not_reached: ${target} located_at=(lx,ly,lz)|distance=141; blocker=<kind>; "<truncated last skill line>"; bot at (x,y,z).`,
  located_at: {x, y, z} | null,
  located_distance: number | null,
  blocker_kind: 'no_tool' | 'pathfinder_bail' | 'water_route' | 'unknown',
  blocker_detail,
};
```

Sub-steps that are easy to miss:

**a. Entity searches don't carry coordinates.** The skill output for
blocks is `Found <X> at (lx,ly,lz). Navigating...`; the skill output for
entities is `Found <X> <distance> blocks away.` (see
`pork_chop/runner_stdout.log:161`). `located_at` is therefore
`{x,y,z} | null` and `located_distance` is `number | null` — they're
mutually exclusive. The message builder must handle both shapes.

**b. Move the located/unreached distinction up.** Currently
`run_search` always returns `search_exhausted` and the
`search_found_not_reached` reclassification happens later inside
`run_search_action` (search_replanner.js:182–186). Move the
classification into `run_search` so both code paths share one source of
truth, and remove the post-hoc `check_search_complete` re-classification
from `run_search_action`.

**c. Update the SPL outer routing in `actions.js`.** Today
`actions.js:156` triggers the search_replanner only when
`current_step.result.kind === 'search_exhausted'`. After this step,
`handle_search_action` can return `'search_found_not_reached'` too —
update the routing condition to fire on **either** kind, and update the
`searched_targets.add(search_target)` block so a located-but-unreachable
target is still recorded as attempted. Without this update, this step is
a regression for the located-but-unreachable case.

**d. Soft-skip unsupported abstracts.** `expand_search_item` throws for
abstracts other than `any_log`. The sweep already soft-skips these; do
the same in the single-target path so an unsupported abstract returns
`{outcome: 'absent', message: "...unsupported abstract target..."}`
rather than crashing into `runner_exception`.

**e. `blocker_kind` parsing relies on third-party strings.** "Cannot
break X with current tools" comes from `mineflayer-pathfinder`. Route
the parse through `parse_skill_output` (Step 1) so any future upstream
string change is patched in one place. When the regex matches nothing,
`blocker_kind = 'unknown'` and `blocker_detail` is the verbatim last
skill line — never crash on an unrecognised blocker.

**Why this matters first:** the search_replanner explicitly chooses
between "fix locally" and "relocate" based on whether the target is
absent or located-but-unreachable. Right now the model has to infer
from free text whether the skill ever saw an instance.

### Step 3 — Surface sweep `per_source_outcomes` into `recover_failed_search`

**Files:** `pipeline/structured_loop/actions.js`, `search_replanner.js`.

**Implementation note (caught in plan-review):** the existing `attempt:0`
seed entry in `recover_failed_search` at lines 294–310 only fires when
`seed_failure_message != null`. The sweep handler in `actions.js`
currently passes `null`:

```js
// actions.js:431-433 — sweep handler call site
const recovery = await recover_failed_search(
    sweep_result.sources_exhausted, agent, model_search_replanner,
    breadcrumb_tracker, log, task);   // no seed_failure_message
```

So "add it to the seed entry that recover_failed_search already builds"
would be a no-op for the sweep path. We need a **new** sweep-shaped
seed branch.

Plan:

a. **Extend `recover_failed_search`'s signature** with an optional
   `seed_sweep_outcomes` parameter (a `{[source]: {outcome,
   located_at?, located_distance?, blocker_kind?, blocker_detail?,
   message}}` map, exactly the shape Step 2 produces).

b. **Add a sweep-shaped seed branch** alongside the existing
   single-target branch. When `seed_sweep_outcomes` is provided,
   push **one `attempt:0` entry per source** into
   `previous_summaries` (or a single multi-result entry — the
   single-result-per-action shape is closer to how the prompt
   already reads `previous_summaries[i].results`, so prefer that):

   ```js
   if (seed_sweep_outcomes != null) {
     const seed_search_state = get_search_trace_state(agent, breadcrumb_tracker);
     previous_summaries.push({
       attempt: 0,
       summary: `Original sweep across [${targets.join(', ')}] exhausted, triggering recovery.`,
       actions: targets.map(t => ({name: '!search', args: [t]})),
       results: targets.map(t => {
         const o = seed_sweep_outcomes[t] ?? {outcome: 'absent'};
         return {
           command: `!search("${t}")`,
           success: false,
           kind: o.outcome === 'found_not_reached'
               ? 'search_found_not_reached'
               : 'search_exhausted',
           message: o.message ?? null,
           // structured fields the replanner can use directly
           located_at: o.located_at ?? null,
           located_distance: o.located_distance ?? null,
           blocker_kind: o.blocker_kind ?? null,
         };
       }),
       end_state: pick_attempt_end_state(seed_search_state),
     });
   }
   ```

c. **Update the sweep call site in `actions.js`** to pass
   `sweep_result.outcomes` (the map produced by
   `run_breadth_first_sweep`, see `search.js:125`) as
   `seed_sweep_outcomes`.

d. **Mutual exclusion.** `seed_failure_message` (single-target) and
   `seed_sweep_outcomes` (multi-target) shouldn't both be passed.
   Pick one branch; the non-sweep `search_exhausted` call site keeps
   passing `seed_failure_message` only.

### Step 4 — Make verifier-failure messages name the root cause

**Files:** `pipeline/command_utils.js`, new `pipeline/structured_loop/result_messages.js`.
**Not** `pipeline/command_verifier.js` — see below.

Today: `verifier_failed:no_iron_ingot_delta | Action output:\nFailed to place furnace at (104, 130, -24).\nThere is no furnace nearby and you have no furnace.\n`.

**Responsibility split (corrects an earlier draft of this plan):**

- **`command_verifier.js` stays purely state-based.** Verifiers only
  observe pre/post inventory, position, equipment — they don't see
  `bot.output`. Asking them to name root causes from skill text would
  layer-mix verification and message shaping. Leave the existing
  `reason` strings as-is (`no_iron_ingot_delta`, `bucket_unfilled`,
  etc.); they're fine as stable state-derived identifiers.
- **`command_utils.js` builds the user-facing message.** It is the
  only place that holds both the verifier verdict **and** the raw
  skill output in the same scope. Move the inline string construction
  into `build_command_failure_message`, which calls
  `parse_skill_output` (Step 1) to extract the root cause.

Concretely, replace the current inline build at command_utils.js:121
with:

```js
if (verdict.verified && !verdict.ok) {
  const parsed = parse_skill_output(result.message);
  return {
    ...result,
    success: false,
    message: build_command_failure_message({
      command,
      verifier_reason: verdict.reason,           // e.g. 'no_iron_ingot_delta'
      root_cause_kind: parsed.root_cause_kind,   // e.g. 'workstation_placement_failed'
      root_cause_detail: parsed.root_cause_detail,
      skill_output: result.message,
      position: agent.bot.entity.position,
    }),
  };
}
```

Yields:
`command_failure: cmd=!smelt_item("raw_iron",1,"oak_planks"); verifier=no_iron_ingot_delta; root_cause=workstation_placement_failed at (104,130,-24); pos=(108,130,-25) | "There is no furnace nearby and you have no furnace."`

`parse_skill_output` recognises a small, tested catalogue:

| Skill substring | `root_cause_kind` |
|---|---|
| `Failed to place <X> at (...)` | `workstation_placement_failed` |
| `There is no <X> nearby and you have no <X>` | `workstation_missing` |
| `You do not have enough <X> to smelt` | `insufficient_smelt_input` |
| `You have no fuel to smelt` | `fuel_missing` |
| `Don't have right tools to harvest <X>` | `tool_missing` |
| `Inventory full` | `inventory_full` |
| (no match) | `unknown` — full last skill line goes in `root_cause_detail` |

Same fallback rule as Step 2: an unrecognised pattern degrades to
`unknown` + verbatim last line, never crashes.

### Step 4.5 — Preserve `mode_interrupted` classification inside replanner `run_action`

**Files:** `pipeline/structured_loop/failure_replanner.js`,
`pipeline/structured_loop/search_replanner.js`.

This is a correctness bug, not just a message-quality nit, and worth
flagging separately because the rest of the plan can't compensate for
it.

The SPL outer loop at `actions.js:262-269` correctly classifies a
mode-interrupted command result as `kind: 'mode_interrupted'` and
attaches `mode_interrupt_counts`, `position_before`, `position_after`
to the trace step. Both replanners' `run_action` (`search_replanner.js:142-147`,
`failure_replanner.js:65-73`) collapse the same `env_result` shape into
`kind: 'command_failure'` and drop the structured fields:

```js
// Both replanners do this today
const env_result = await executeCommandWithModeRecovery(agent, command);
const success = env_result?.success === true;
return create_action_result(
    command, success, success ? 'command_success' : 'command_failure',
    env_result?.message ?? null);
```

Effect: when a recovery action (`!goToCoordinates`, `!collectBlocks`,
etc.) gets livelock-interrupted inside a recovery plan, the next
replanner iteration sees `command_failure` with no indication that mode
interruption was the cause. The prompt's "if mode_interrupted, choose
a relocation action" branch is never taken in that path.

Fix (apply to both replanners):

```js
const env_result = await executeCommandWithModeRecovery(agent, command);
await sleep(/* existing debounce */);
const success = env_result?.success === true;
const kind = success
    ? 'command_success'
    : (env_result?.mode_interrupted === true
        ? 'mode_interrupted'
        : 'command_failure');
const result = create_action_result(
    command, success, kind, env_result?.message ?? null);
if (env_result?.mode_interrupted === true) {
  result.mode_interrupt_counts = env_result.mode_interrupt_counts;
  result.position_before = env_result.position_before;
  result.position_after = env_result.position_after;
}
return result;
```

`create_action_result` already accepts the four documented fields and
ignores extras at the call site; `project_failed_steps` (`trace.js:28-37`)
already propagates `mode_interrupt_counts` / `position_before` /
`position_after` if present. This is purely a "wire the existing
plumbing through the replanner runners".

Add tests that exercise a mode-interrupted env_result through each
replanner's `run_action` and pin the resulting kind + fields.

### Step 5 — Enrich `mode_interrupted` with per-mode trigger reason

**Files:** `achievement_hunter/src/agent/ah_modes.js` (the AH-forked
`ModeController` — already wholly under AH ownership, no upstream patch
needed), `pipeline/command_utils.js` (existing
`build_mode_interrupted_result`), `result_messages.js`
(`build_mode_interrupted_message`).

A pre-execution Explore pass confirmed:

- The AH fork `achievement_hunter/src/agent/ah_modes.js` is what
  actually runs at the bot — there is no `patches/` entry on
  upstream `src/agent/modes.js`, and ah_modes.js's `ModeController`
  is instantiated directly.
- The three modes that actually fire during command preemption each
  carry useful local state when they call `execute()`:
  - **`unstuck`**: `stuck_time`, `prev_location`, `prev_dig_block`.
    Trigger reason ≈ `"stuck for Ns without moving from (x,y,z) while digging <block>"`.
  - **`self_preservation`**: three distinct triggers — drowning
    (`blockAbove.name === 'water'`), burning
    (`blockAt(pos).name === 'lava'` or fire), low-health
    (`bot.lastDamageTime` + `bot.health`). Each branch can emit a
    different reason string at its `execute()` call.
  - **`self_defense`**: a `getNearestEntityWhere` returns `enemy`;
    `enemy.name` is the hostile mob type (e.g. `"zombie"`,
    `"creeper"`).
- `ModeController` today exposes `isAnyModeActive()` and
  `getActiveModeNames()` but not internal mode state — modes are
  opaque objects in `modes_map`. The cheapest fix is a small
  controller-level last-trigger map that modes write to from inside
  their `execute()` body.

**Naming clarification:** two builders with similar names —

- **`build_mode_interrupted_result`** (existing, in `command_utils.js`,
  lines 177–207) returns the full **result object**. Today it inlines
  the message. We make it call the new message builder for the
  `message` field. Don't rename or relocate it.
- **`build_mode_interrupted_message`** (new, in `result_messages.js`,
  per Step 1) returns just the **message string**.

Implementation (~15 LoC total in AH code):

a. **In `ah_modes.js`'s `ModeController`** — add a
   `this._last_trigger = {}` field in the constructor and a
   `getLastTrigger(mode_name)` getter.

b. **In each mode body in `ah_modes.js`**, right before the existing
   `await execute(...)` call, set
   `this._agent.bot.modes._last_trigger[mode.name] = {reason, detail}`
   where `reason` is a short kind (`"stuck"`, `"drowning"`,
   `"burning"`, `"low_health"`, `"hostile_nearby"`) and `detail` is
   the relevant extracted field (`prev_dig_block`, `enemy.name`,
   etc.). Wrap marker comments around each block so future upstream
   merges keep the AH additions visible.

c. **In `command_utils.js`'s `build_mode_interrupted_result`**, read
   `agent.bot.modes.getLastTrigger(name)` for each mode in
   `interrupt_counts_by_mode` and pass the resulting map to
   `build_mode_interrupted_message`. Also pass `command` through (the
   call site at `command_utils.js:137-141` already has it in scope —
   today it's not threaded into the message).

d. **In `result_messages.js`**, `build_mode_interrupted_message`
   formats:

   ```
   mode_interrupted: modes=unstuck×5 (reason=stuck, dig=stone), self_preservation×2 (reason=drowning); cmd=!collectBlocks("stone",11); bot Δ=(5.2,3.0,-1.5); pos_after=(x,y,z); command never completed
   ```

   Missing-reason modes degrade to `modes=<name>×<n>` with no
   parenthetical, matching today's format — never crash on a mode
   that didn't update its `_last_trigger` slot.

This step still ships in PR D alongside the other command-side message
work; no new dependency on PRs A–C.

### Step 6 — Enrich `runner_exception`

**Files:** both replanners' `run_action` and `run_search_action` only —
`pipeline/structured_loop/failure_replanner.js` (lines 73, 109) and
`pipeline/structured_loop/search_replanner.js` (lines 149, 188).
The SPL outer loop in `actions.js` does **not** produce
`runner_exception` today (grep confirms — no `runner_exception` literal
in `actions.js`), so don't touch it for this step.

Replace `String(e)` with:

```js
build_runner_exception_message({
  command,
  error_message: e.message,
  error_name: e.constructor?.name,
  position: agent.bot.entity.position,
  stack_top: (e.stack ?? '').split('\n').slice(0, 3).join(' / '),
});
```

Yields e.g.
`runner_exception: TypeError "Cannot read properties of undefined (reading 'x')" at world.js:142 during !collectBlocks("oak_log", 5); bot at (108,128,-19)`.

### Step 7 — Normalize `command_success` messages (narrow scope)

**File:** new helper in `result_messages.js`, called from
`pipeline/structured_loop/trace.js:create_command_success_result`.

The earlier draft proposed broadly "strip leading failure lines". That
is **too aggressive** — some lines that look like failures carry
load-bearing partial-outcome information:

- `Failed to collect oak_log: Timeout: Took to long to decide path to goal!` followed by `Collected 4 oak_log.` — the partial collect (4 of 5 requested) is the signal the replanner / next planner needs.
- `Failed to place crafting_table at (106, 137, -26).` followed by `Successfully crafted wooden_axe, you now have 1 wooden_axe.` — the failed-place is plumbing noise (auto-placement retry succeeded internally).

Narrow rule:

a. **Strip only known plumbing patterns.** Specifically:
   - `Placed crafting_table at (...).` and `Failed to place crafting_table at (...).` lines (craftRecipe auto-place/retry).
   - `Collected 1 crafting_table.` lines that immediately follow a successful craft (craftRecipe auto-pickup).
   - `Placed furnace at (...).` and `Collected 1 furnace.` lines that bracket a successful smelt (smeltItem auto-place/auto-pickup).
   - `Path not found, but attempting to navigate anyway using destructive movements.` — pathfinder advisory that fires before a successful destructive-move navigation (seen in `hot_stuff/runner_stdout.log:222`).
   - `Pathfinding stopped: ...` lines that precede a `You have reached at ...` line in the same blob (the skill ultimately reached the goal).
   These patterns are emitted by skills.js plumbing and never represent
   task-level outcomes.

b. **Preserve every `Failed to <verb> <object>:` line that is NOT about
   `crafting_table` placement.** In particular, `Failed to collect`,
   `Failed to attack`, `Don't have right tools`, `Inventory full`, and
   anything else stays.

c. **Move the success summary line to the front.** After stripping
   plumbing, hoist `Successfully crafted X`, `Collected N X`, or
   `Successfully smelted X` to position 0 of the message body. The
   replanner reading top-down sees an unambiguous success first.

d. **If stripping would empty the message**, fall back to the original.
   Don't ever return a success result with no message.

Add tests for both the strip-plumbing case and the
preserve-partial-collect case as pinned snapshots (Step 11).

### Step 8 — Carry prior-outcome into `search_already_attempted`

**Files:** `actions.js`, both replanners' `run_search_action`.

Keep a small map `searched_targets_outcomes: Map<target, {kind, message, located_at?, located_distance?, blocker_kind?}>` next to the existing
`searched_targets: Set`. When the short-circuit fires, include the prior
outcome in the message:

```
search_already_attempted: pig — prior_kind=search_found_not_reached; prior_detail="located at (224,125,-98); blocker=no_tool"; relocate or address blocker first.
```

**Implementation note (caught in plan-review):** in `actions.js`, the
`searched_targets` set is checkpoint-persisted via `persist_active_task`
(lines 101–109) so it survives crash-restart of a long task. The new
outcomes map needs the same persistence path:

- Serialise `searched_targets_outcomes` alongside `searched_targets` in
  `persist_active_task` (as a plain object or `[[k,v], ...]` array,
  whatever JSON-encodes cleanly).
- Re-hydrate it in the resume-from-crash branch (the
  `prior_active_task.searched_targets ?? []` read at line 87).
- Both replanners' `searched_targets` are per-plan scope (constructed
  fresh in each attempt — see `search_replanner.js:394`) and reset on
  every replan, so **only the actions.js Set+Map needs checkpoint
  persistence**. The replanner-internal maps live and die with the
  current plan.

### Step 9 — Replace `unstructured_failure_result` with the raw object captured

**File:** `actions.js`.

If a command returned a failure with no/empty message, serialize the
truthy keys we *do* have (`success`, `bot_died`, etc.) into the message
rather than dropping them:

```
command_failure: unstructured — raw_result_keys=[success, bot_died], success=false, bot_died=true; command="!collectBlocks(stone,11)"
```

This is cheap and prevents the LLM from getting an empty-feeling result.

### Step 10 — Align prompts and action-reference docs with the new kind/message contract

**Files:** `docs/prompts/search_replanner/search_replanner.md`,
`docs/prompts/failure_replanner/failure_replanner.md`,
`docs/prompts/_shared/actions_reference.master.json` and both copies.

This is **not a follow-up — it is a release gate**. Steps 2, 4, 6, 7, 8
add structure to action results, but the LLM only benefits when the
prompt tells it that the structure is present and how to read it. Ship
the prompt update in the same commit as the code change that introduces
each new template.

Updates:

a. **Canonical kind list per prompt.** Include the full kind set
   produced by the helpers in Step 1 (in particular,
   `search_success` is missing today from search_replanner's list, and
   the failure_replanner's prompt doesn't describe results at all
   pre-Step-0).

b. **One short paragraph per kind** describing what the message reliably
   contains. Lift the headline grammar from the Quick reference below
   so the prompt teaches the parse shape without prescribing prose.

c. **Fix the stale radius literal.** Confirmed:
   `SEARCH_RADII = [32, 64, 128, 256]` in
   `pipeline/structured_loop/config.js:70`. The `sweep_exhausted`
   message at `actions.js:421` hard-codes `"radius 511"` — replace it
   with `` `radii_tried=[${SEARCH_RADII.join(',')}]` ``. Also re-check
   comments/log lines that reference 511 (e.g.
   `search_replanner.js`'s "511-block radius" wording) and align them
   so docs, code, and messages all agree on 256.

d. **Coordinated commit policy.** Tag the PR descriptions so reviewers
   know "code change X ships with prompt change Y" and pre-merge
   verification re-runs at least one of the eval tasks affected by
   X+Y.

### Step 11 — Add tests pinning the new message templates

**File:** new `pipeline/structured_loop/__tests__/result_messages.test.js`
(or extend existing verifier tests).

For each helper in Step 1, snapshot a representative input/output pair.
This makes future regressions visible in code review rather than only in
LLM behavior.

### Step 12 — Token-budget sanity pass

**Files:** new `pipeline/structured_loop/__tests__/message_token_budget.test.js`,
or extend existing replanner tests.

Steps 2/4/6 grow individual result messages. The search_replanner's
`previous_summaries` accumulates results across up to
`MAX_SEARCH_REPLANNER_ATTEMPTS` recovery attempts (≥ 10 today), each with
up to `MAX_ACTIONS_PER_PLAN` actions. The failure_replanner sees a
single attempt of results (post-Step-0) but with up to 8 actions × up
to `MAX_RECOVERY_ATTEMPTS` accumulated diagnoses.

Add lightweight guardrails:

a. **Per-message cap.** Builders enforce ≤ 240 chars before the `|`
   delimiter and ≤ 200 chars of skill-output tail. Total ≤ ~450 chars
   per result.
b. **Snapshot tests** that fail if a builder produces a message above
   the cap (caught at code-review time, not eval time).
c. **A rollup sanity check** comparing a representative
   `previous_summaries`/`previous_diagnoses` payload size before and
   after the plan lands, recorded in the PR description.

If the cap proves too tight in practice, raise it deliberately rather
than letting messages drift.

### Step 13 — (removed)

Originally proposed a re-run of one or two tasks from
`achievement_hunter_eval_v2_full/` to diff replanner inputs before/after.
Dropped per scope decision; validation falls back to the snapshot tests
in Step 11 and the per-message cap tests in Step 12.

If a real before/after diff is wanted later, the cheapest way is to grep
`runner_stdout.log` outputs from a normal benchmark run for the new
structured prefixes (`command_failure: cmd=...`, `search_found_not_reached: ...located_at=...`) — no re-run needed.

---

## 5. Risks and untested assumptions

Honest enumeration of what could still go wrong after this plan lands:

1. **Third-party string fragility.** Step 2 and Step 4 extend the
   project's existing dependency on exact mineflayer-pathfinder /
   Mindcraft skill-output strings (already commented on in
   `command_utils.js:PATHFINDING_MESSAGE_REGEX`). Centralising parsing
   in one `parse_skill_output` helper bounds the blast radius but does
   not eliminate the risk. Mitigation: snapshot tests against captured
   real skill outputs (Step 11) and a `unknown` fallback that never
   crashes.

2. ~~**Step 5 leaves a known gap.**~~ **Resolved during plan-review.**
   An Explore pass against `achievement_hunter/src/agent/ah_modes.js`
   confirmed the per-mode trigger-reason enrichment is cheap (~15 LoC,
   no upstream patch); Step 5 is now in scope for this plan.

3. **Step 7 stripping rule is heuristic.** The plumbing-line whitelist
   is based on the four eval runs in
   `achievement_hunter_eval_v2_full/`. Other recipes or future skill
   refactors may emit new plumbing patterns. Pin behaviour with
   snapshot tests and revisit if eval logs show new plumbing.

4. **Token budget not measured against live usage yet.** Step 12's
   caps are conservative-by-fiat. If real eval rollups exceed budget,
   raise the cap deliberately (not silently in another step).

5. **Structured `details` are not exposed to the prompt.** The plan
   keeps the LLM-facing channel as `message` and treats the
   `details` side-objects as internal/test-only data. If a later
   iteration wants the LLM to read structured fields directly, both
   prompts must be re-templated. Out of scope here.

6. **Search-replanner / failure-replanner asymmetry stays partially.**
   Step 0 wires per-attempt results into failure_replanner's
   `previous_diagnoses` but does not unify the two replanners'
   prompt-input shapes. They will share message templates after this
   plan; they will not share input schemas.

7. **Verifier-passthrough false-successes are unaddressed.** Two actions
   have verifier scope gaps that produce silent false-successes the
   replanner cannot detect from messages: `!useOn` for non-bucket tools
   (shears, flint_and_steel, dye) and `!attack` for mobs in
   `unknown_mob_or_no_drops`. These are verifier-coverage issues, not
   message-quality issues — out of scope here, but worth a separate
   ticket. The replanners will continue to treat these as successes
   even when nothing happened.

8. **`unstructured_failure_result` removal is by attrition.** Step 9
   improves the message but does not eliminate the kind. If we trace
   real causes back to specific skills returning malformed results,
   fixing those skills is preferable to dressing up the kind here.

---

## 6. Quick reference — message templates after the plan

```
command_success: <success summary, plumbing-stripped> | <preserved partial-outcome lines if any>

command_failure: cmd=<command>; verifier=<reason|n/a>; root_cause=<kind>[ at (x,y,z)]; pos=(x,y,z) | "<last skill line>"

mode_interrupted: modes=<mode>×<n> (reason=<kind>[, <detail>=<val>])[, <mode>×<n> (...)]; cmd=<command>; bot Δ=(dx,dy,dz); pos_after=(x,y,z); command never completed

runner_exception: <Error.name> "<message>" at <stack head>; during cmd=<command>; pos=(x,y,z)

search_success: <target> reached[, located_at=(x,y,z)|distance=<d>]

search_exhausted: <target> — no instance within 256 blocks of (x,y,z); bot biome=<biome>

search_found_not_reached: <target> located_at=(lx,ly,lz)|distance=<d>; blocker=<kind>; bot=(x,y,z) | "<last skill line>"

search_already_attempted: <target>; prior_kind=<kind>; prior_detail="..."

invalid_command: cmd=<command>; reason="..."

sweep_target_found: <item> via candidate <source>; outcomes={source: <outcome>}

sweep_exhausted: radii_tried=[...]; outcomes={source: {outcome[, located_at|distance][, blocker]}}; bot=(x,y,z) biome=<biome>

unstructured_failure_result: cmd=<command>; raw_keys=[...]; <key>=<val>; <key>=<val>

unexpected_action_kind: kind=<kind>; mediator returned non-command for task=<task summary>
```

`(x,y,z)` is always the bot's current position unless otherwise labeled
(`located_at`, `pos_before`, `pos_after`). Entity searches use
`distance=<d>` instead of `located_at`. The trailing `| "<last skill
line>"` is optional — included when it carries information the headline
doesn't already cover.

---

## 7. Out-of-scope (intentionally)

- Changing the action set (`actions_reference.json`). Action coverage is
  a separate concern from message quality.
- Re-architecting the replanner control flow (D7/D11 escape paths,
  attempt budgets). Today's flow already gives the LLM enough room; the
  bottleneck is signal quality.
- Adding new verifiers. Verifier coverage was last expanded in
  `command_verifier.js` Phases 2–7 and is reasonably comprehensive.
- Re-prompt engineering the failure/search replanners beyond the small
  documentation updates in Step 10. Once messages improve, revisit prompt
  tweaks empirically.
