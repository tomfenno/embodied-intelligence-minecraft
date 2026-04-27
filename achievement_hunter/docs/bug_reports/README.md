# Bug Reports

Bugs identified from the `hard-code-nts-am` branch run logs (2026-04-16, 2026-04-27).

| # | File | Severity | Status | Fix Complexity |
|---|---|---|---|---|
| 1 | `BUG1_entity_metadata_partial_read_error.md` | Medium | Hypothesis | Medium — requires raw packet inspection + protocol.json patch |
| 2 | `BUG2_stick_craft_updateslot_timeout.md` | **Critical** | Root cause identified | Low — single-line mineflayer patch |
| 3 | `BUG3_triple_wrapped_error_lost_stack.md` | Low | Confirmed | Low — error re-throw style fix |
| 4 | `BUG4_outer_retry_loop_deterministic_failure.md` | Medium | Confirmed | Low — outer loop signature tracking |
| 5 | `BUG5_lava_death_pathfinder_escape_failure.md` | **Critical** | Root cause confirmed | Medium — replace `moveAway` with direct-control escape in `ah_modes.js` |
| 6 | `BUG6_drowning_during_llm_call.md` | High | Root cause confirmed | Low–Medium — fix water condition + add pre-LLM safety check |

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
- **BUG 5:** High confidence. Root cause traced in `ah_modes.js:89` — `moveAway`
  delegates to pathfinder, pathfinder treats lava as impassable, escape fails silently.
  Confirmed by inventory wipe in rollout trace at 5m 27s–5m 32s.
- **BUG 6:** High confidence. Two independent root causes in `ah_modes.js:46-48`:
  `blockAbove === 'water'` misses the fully-submerged case, and `jump=true` is
  insufficient for active escape. Third contributing cause: no hazard check before
  `model.send_prompt()` in `failure_replanner.js`.
- **BUG 4:** High confidence. Directly observable in the log.
- **BUG 3:** High confidence. Triple-wrapped error and `undefined` stack trace are
  directly observable.
- **BUG 1:** Plausible hypothesis. A protocol version mismatch is the most likely
  cause, but the exact wrong type mapping has not been confirmed from raw packet data.
  "Likely cause" — not proven root cause.
