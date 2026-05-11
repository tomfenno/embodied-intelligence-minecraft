# Unpatched Bugs

Bugs that have been identified and reported but whose fixes have not yet been applied.

| # | File | Severity | Status | Fix Complexity |
|---|---|---|---|---|
| 1 | `BUG1_entity_metadata_partial_read_error.md` | Medium | Hypothesis — not fully proven from logs alone | Medium — requires raw packet inspection + `protocol.json` patch |
| 12 | `BUG12_unstuck_interrupt_deadlock_crashloop_with_checkpoint_resume.md` | Critical | Reported — fix proposed | High — `AbortController` refactor in `ActionManager` + skill threading + progress watchdog |
| 13 | `BUG13_iron_collection_wedges_after_pickaxe_break_via_unstuck_deadlock.md` | Critical | Reported — same root cause as BUG 12 | See BUG 12 (apply BUG 12's fixes) |

## Priority order

1. **BUG 12** — causes silent infinite restart loops; rollouts never terminate. The `unclean_exit_count` checkpoint guard (BUG 12 fix #1) is the minimum to prevent unattended dead-air.
2. **BUG 13** — same root cause as BUG 12, surfaced in a different workflow (post-pickaxe-break iron collection). Fixed automatically by applying BUG 12's fixes.
3. **BUG 1** — non-fatal, noisy. Investigate after BUG 12; check whether it persists once `patch-package` versions are aligned with installed `mineflayer` / `minecraft-data` versions.

BUG 15 and BUG 16 were both filed here. BUG 15 (Fix B) and BUG 16 (Fix 1) have since been applied and both live in `patched/`. BUG 16 Fix 2 (subscribe to `acknowledge_player_digging` so future protocol drift doesn't silently regress) remains deferred — defense-in-depth, not load-bearing.

## Notes

- BUG 13 is intentionally a separate report from BUG 12 because the user-visible symptom maps to BUG 10's workflow (pickaxe break during iron collection), but the underlying cause is BUG 12. Keeping it filed separately preserves the link between the symptom and the actual fix.
