# Bug Reports

Bugs identified from the `hard-code-nts-am` branch run logs (2026-04-16, 2026-04-27).

| # | File | Severity | Status | Fix Complexity |
|---|---|---|---|---|
| 1 | `BUG1_entity_metadata_partial_read_error.md` | Medium | Hypothesis | Medium — requires raw packet inspection + protocol.json patch |
| 2 | `BUG2_stick_craft_updateslot_timeout.md` | **Critical** | Root cause identified | Low — single-line mineflayer patch |
| 3 | `BUG3_triple_wrapped_error_lost_stack.md` | Low | Confirmed | Low — error re-throw style fix |
| 4 | `BUG4_outer_retry_loop_deterministic_failure.md` | Medium | Confirmed | Low — outer loop signature tracking |
| 5 | `BUG5_lava_death_pathfinder_escape_failure.md` | **Critical** | **Fixed** — `ah_modes.js:69–119` (escape), `actions.js:92–102` (sneak) | Medium |
| 6 | `BUG6_drowning_during_llm_call.md` | High | **Fixed** — `ah_modes.js:46–49` (water condition), `failure_replanner.js:180–216` (pre-LLM check) | Low–Medium |
| 7 | `BUG7_flowing_liquid_triggers_useOn.md` | Medium | **Fixed** — `agent_state.js:34,60` (metadata filter) | Low — one-line guard in both block loops |
| 8 | `BUG8_useToolOnBlock_wall_obstruction.md` | Medium | **Fixed** — `skills.js` (`// Start of AH code` block after line 2083) | Low — dig-through obstruction instead of random angle hunt |
| 9 | `BUG9_goalchanged_crashes_spl_at_recovery_boundary.md` | High | **Fixed** — `failure_replanner.js:185–210` (`ensure_safe_before_llm`) | Low — oxygenLevel condition + try-catch |

## Priority Order

1. **BUG 2** — blocks execution, introduced on this branch, fix is targeted
2. **BUG 5** — critical; total item loss, forces full rebuild; fix is contained to `ah_modes.js`
3. **BUG 6** — high; caused by BUG 5 in this trace but independent; fix is contained to `ah_modes.js` + `failure_replanner.js`
4. **BUG 1** — investigate after BUG 2; check if it disappears or persists independently
5. **BUG 4** — fix regardless; makes the loop resilient to future deterministic failures
6. **BUG 3** — quality-of-life; fix when touching error handling code

## Confidence

- **BUG 2:** High confidence. Root cause traced to `craft.js:grabResult` firing
  `updateSlot:0` before `putAway` registers its listener. Introduced when
  `mediate_craft` changed the command from `!craftRecipe("stick", 4)` to
  `!craftRecipe("stick", 1)`.
- **BUG 5:** Fixed. Root cause was `ah_modes.js:89` — `moveAway` delegates to pathfinder,
  pathfinder treats lava as impassable, escape fails silently. Fix A replaced with
  direct-control sprint-jump escape (`ah_modes.js:69–119`). Fix B adds sneak state during
  `!useOn("bucket", "lava")` to prevent falling in (`actions.js:92–102`).
- **BUG 6:** Fixed (third iteration). Water block checks (`||`, `&&`, `!pathfinder.goal`) all
  had edge cases during pathfinder navigation. Final fix uses `bot.oxygenLevel < 15` (mineflayer
  `air_supply / 15`, range 0–20): fires only after ~3.75 s of continuous head submersion, ignores
  wading and brief swimming dips, can't false-positive on pathfinder navigation. Pre-LLM hazard
  check in `failure_replanner.js:180–216` retains water block check (one-shot, not a tick).
- **BUG 7:** Fixed. `nearby_blocks` included flowing water/lava (same block name as source,
  metadata 1–7) which caused `mediate_interact` to emit `!useOn` prematurely. Fixed by
  skipping `COLLECTIBLE_LIQUIDS` blocks with `metadata !== 0` in both `get_am_state` and
  `get_nts_state` (`agent_state.js:34,60`). Reuses the `metadata === 0` pattern already
  established in `skills.js`.
- **BUG 4:** High confidence. Directly observable in the log.
- **BUG 3:** High confidence. Triple-wrapped error and `undefined` stack trace are
  directly observable.
- **BUG 1:** Plausible hypothesis. A protocol version mismatch is the most likely
  cause, but the exact wrong type mapping has not been confirmed from raw packet data.
  "Likely cause" — not proven root cause.
- **BUG 9:** High confidence. Crash stack trace directly shows GoalChanged thrown from
  `moveAway` inside `ensure_safe_before_llm`, propagating uncaught through `recover_failed_task`
  and the SPL while loop. Self_preservation completes successfully after the crash — confirms the
  exception is a race artifact, not a real failure. Fix A (try-catch in `ensure_safe_before_llm`)
  is sufficient; Fix B (SPL-level catch) makes the loop resilient to any future similar race.
- **BUG 8:** Fixed. Root cause confirmed by `!goToCoordinates(-479, -38, -1764, 1)` failing ×3
  in recovery attempt 2 — direct proof that `GoalNear=1` at the lava block is unreachable. Fix
  replaces random angle-hunting with a dig-through: bot only attempts `useOn` when view is clear
  or it is above the lava; otherwise digs the blocking block. Annotated with
  `// Start of AH code` / `// End of AH code` (convention for AH patches to files outside
  `achievement_hunter/`).
