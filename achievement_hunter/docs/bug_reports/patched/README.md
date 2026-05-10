# Patched Bugs

Bugs whose fixes have been applied on branch `hard-code-nts-am`.

| # | File | Severity | Patch Location |
|---|---|---|---|
| 2 | `BUG2_stick_craft_updateslot_timeout.md` | Critical | `patches/mineflayer+4.33.0.patch` (`craft.js` `grabResult`) |
| 4 | `BUG4_outer_retry_loop_deterministic_failure.md` | Medium | `achievement_hunter/src/pipeline/structured_loop.js` (outer-loop signature tracking) |
| 5 | `BUG5_lava_death_pathfinder_escape_failure.md` | Critical | `ah_modes.js:69–119` (escape), `actions.js:92–102` (sneak), `failure_replanner.js:48–68` (replanner sneak) |
| 6 | `BUG6_drowning_during_llm_call.md` | High | `ah_modes.js:87–91` (`blockAbove === 'water'` jump), `failure_replanner.js:246–273` (pre-LLM check — see BUG 9) |
| 7 | `BUG7_flowing_liquid_triggers_useOn.md` | Medium | `agent_state.js:34,60` (metadata filter on `nearby_blocks`) |
| 8 | `BUG8_useToolOnBlock_wall_obstruction.md` | Medium | `src/agent/library/skills.js:2084–2102` (dig-through obstruction) |
| 9 | `BUG9_goalchanged_crashes_spl_at_recovery_boundary.md` | High | `failure_replanner.js:246–273` (block-below / block-above water check + try-catch) |
| 10 | `BUG10_stone_pickaxe_break_oom_collectblock.md` | Critical | `patches/mineflayer-tool+1.2.0.patch`, `skills.js:531–549` (catch handler) |
| 11 | `BUG11_failure_replanner_inventory_includes_pre_task_items.md` | Medium | `agent_state.js`, `actions.js`, `failure_replanner.js` (inventory delta scoping) |
| 14 | `BUG14_pathfinder_canHarvest_aborts_on_snow_block_without_shovel.md` | Medium | `src/agent/library/skills.js:1232–1245` (hardness-gated `canHarvest` abort in `goToPosition`'s watchdog) |

## Verifying a fix

Each bug file includes the exact files and line ranges modified. To confirm a patch is still in place after upstream merges, search for the `// Start of AH code` / `// End of AH code` markers (used for patches to files outside `achievement_hunter/`).
