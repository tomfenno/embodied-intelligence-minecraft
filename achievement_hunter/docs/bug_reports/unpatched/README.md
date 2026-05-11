# Unpatched Bugs

Bugs that have been identified and reported but whose fixes have not yet been applied.

| # | File | Severity | Status | Fix Complexity |
|---|---|---|---|---|
| 1 | `BUG1_entity_metadata_partial_read_error.md` | Medium | Hypothesis — not fully proven from logs alone | Medium — requires raw packet inspection + `protocol.json` patch |
| 12 | `BUG12_unstuck_interrupt_deadlock_crashloop_with_checkpoint_resume.md` | Critical | Reported — fix proposed | High — `AbortController` refactor in `ActionManager` + skill threading + progress watchdog |
| 13 | `BUG13_iron_collection_wedges_after_pickaxe_break_via_unstuck_deadlock.md` | Critical | Reported — same root cause as BUG 12 | See BUG 12 (apply BUG 12's fixes) |
| 17 | `BUG17_gotosurface_pathfinder_livelock_tower_up_no_timeout.md` | High | Hypothesis — symptom confirmed, exact livelock mechanism not isolated from trace | Low for Fix A+B (skill-level: relax `range`, add wallclock watchdog); BUG 12 Fix D is the principled cure |
| 18 | `BUG18_pathfinder_setblockstateid_synthetic_blockupdate_resets_own_path.md` | High | Reverted — mechanism verified, two patch attempts both regressed; needs instrumented A/B measurement before any further attempt | Medium — listener-side patches both failed; future attempts should target the emit source (`setBlockStateId` call) or replace the upstream "infinite jump" fix entirely |
| 19 | `BUG19_pathfinder_resetpath_cascade_from_self_caused_blockupdates.md` | High | Hypothesis — mechanism statically verified end-to-end; partial behavioural confirmation from BUG 18 validation log (10+ self-caused resets per `!collectBlocks` invocation) | **Higher than initially thought.** BUG 18's failed attempts demonstrate that the path-reset cascade is tangled with placement coordination in ways that aren't obvious from static analysis. BUG 19 should be approached with the same caution. |

## Priority order

1. **BUG 12** — causes silent infinite restart loops; rollouts never terminate. The `unclean_exit_count` checkpoint guard (BUG 12 fix #1) is the minimum to prevent unattended dead-air.
2. **BUG 17** — same family as BUG 12 (skill wedges with no cooperative cancellation), but the hang sits below `search_replanner` instead of above the SPL so neither `cleanKill` nor `failure_replanner` reaches it. Fix A + Fix B are three-line changes to `goToSurface` that bound the damage immediately; BUG 12 Fix D is the long-term cure.
3. **BUG 13** — same root cause as BUG 12, surfaced in a different workflow (post-pickaxe-break iron collection). Fixed automatically by applying BUG 12's fixes.
4. **BUG 18 / BUG 19 — DO NOT RE-APPLY without instrumented measurement.** Both bugs target the path-reset cascade. BUG 18 was attempted twice on `search-agent` (commits never landed); both attempts regressed runtime behaviour, the second to a hard process crash. The static-analysis mechanism is verified but the cascade is load-bearing in ways not yet diagnosed. Future work needs a probe-only measurement run *first* (probe with no `return`, just instrumentation) to characterise what the synthetic resetPath is actually doing for placement coordination, *before* patching.
5. **BUG 1** — non-fatal, noisy. Investigate after BUG 12; check whether it persists once `patch-package` versions are aligned with installed `mineflayer` / `minecraft-data` versions.

BUG 15 and BUG 16 were both filed here. BUG 15 (Fix B) and BUG 16 (Fix 1) have since been applied and both live in `patched/`. BUG 16 Fix 2 (subscribe to `acknowledge_player_digging` so future protocol drift doesn't silently regress) remains deferred — defense-in-depth, not load-bearing.

## Notes

- BUG 13 is intentionally a separate report from BUG 12 because the user-visible symptom maps to BUG 10's workflow (pickaxe break during iron collection), but the underlying cause is BUG 12. Keeping it filed separately preserves the link between the symptom and the actual fix.
