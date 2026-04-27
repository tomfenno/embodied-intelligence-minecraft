# Bug Reports

Bugs identified from the `hard-code-nts-am` branch run log (2026-04-16).

| # | File | Severity | Status | Fix Complexity |
|---|---|---|---|---|
| 1 | `BUG1_entity_metadata_partial_read_error.md` | Medium | Hypothesis | Medium — requires raw packet inspection + protocol.json patch |
| 2 | `BUG2_stick_craft_updateslot_timeout.md` | **Critical** | Root cause identified | Low — single-line mineflayer patch |
| 3 | `BUG3_triple_wrapped_error_lost_stack.md` | Low | Confirmed | Low — error re-throw style fix |
| 4 | `BUG4_outer_retry_loop_deterministic_failure.md` | Medium | Confirmed | Low — outer loop signature tracking |

## Priority Order

1. **BUG 2** — blocks execution, introduced on this branch, fix is targeted
2. **BUG 1** — investigate after BUG 2; check if it disappears or persists independently
3. **BUG 4** — fix regardless; makes the loop resilient to future deterministic failures
4. **BUG 3** — quality-of-life; fix when touching error handling code

## Confidence

- **BUG 2:** High confidence. Root cause traced to `craft.js:grabResult` firing
  `updateSlot:0` before `putAway` registers its listener. Introduced when
  `mediate_craft` changed the command from `!craftRecipe("stick", 4)` to
  `!craftRecipe("stick", 1)`.
- **BUG 4:** High confidence. Directly observable in the log.
- **BUG 3:** High confidence. Triple-wrapped error and `undefined` stack trace are
  directly observable.
- **BUG 1:** Plausible hypothesis. A protocol version mismatch is the most likely
  cause, but the exact wrong type mapping has not been confirmed from raw packet data.
  "Likely cause" — not proven root cause.
