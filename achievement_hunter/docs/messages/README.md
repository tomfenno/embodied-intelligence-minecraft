# Message Accuracy Audit — `message-audit-runs/`

Audit of `runner_stdout.log` messages (including `[SPL] Command result`,
`[SPL] Search result`, and `[SPL][search] Result` blocks) across the 5
runs in `achievement_hunter/message-audit-runs/`:

- `acquire_hardware/` — smelt an iron ingot
- `diamonds/` — acquire a diamond
- `hot_stuff/` — fill a bucket with lava
- `moar_tools/` — craft pickaxe/shovel/axe/hoe (same material)
- `pork_chops/` — cook a pork chop (test terminated before completion)

Each issue file groups examples by likely **shared underlying cause**,
not by superficial symptom.

## Issues

| File | Inconsistency type | Examples | Confidence |
|---|---|---|---|
| [collectblocks-count-and-item-mismatch.md](collectblocks-count-and-item-mismatch.md) | Successful `!collectBlocks` messages report a block name + count that does not match the rollout's actual inventory delta (wrong item name when block ≠ drop; wrong count when extra blocks were mined incidentally or a final pickup landed after the headline was assembled). | 4 | High |
| [command-failure-loses-real-blocker.md](command-failure-loses-real-blocker.md) | `command_failure` headlines say `root_cause=unknown` and the trailing `\| "<last skill line>"` is a generic advisory, even though the same skill blob (and the immediately-preceding `pathfinding_wrapper` log line) names the actual blocker (`Cannot break stone with current tools`). | 3 | High |

## Notes / Limitations

- The audit covers only the 5 runs in the input directory. Two of the
  patterns above are mechanistically traceable to functions in
  `result_messages.js` and to the upstream `collectBlock` skill, so they
  are expected to recur on any run where the same call paths fire.
- `pork_chops/` was terminated mid-search-replanner-loop ("TEST
  TERMINATED: Logs suggest agent found itself in a non-recoverable
  area."). The terminating message itself is operator-side, not an SPL
  message, and is not included in the audit.
- The audit does not claim to be exhaustive. Patterns considered and not
  included as separate issues (insufficient evidence or already covered):
  - A checkpoint-resume message in `diamonds/runner_stdout.log:16-19`
    advertises the diamonds objective while the recovered `active_task`
    pointer names `craft:wooden_hoe:1`. Single occurrence, ambiguous
    provenance — would need cross-run checkpoint history to judge.
  - The mode-interrupt path in `hot_stuff/runner_stdout.log:216-245`
    completes successfully on retry; no inaccurate message was emitted
    by the SPL, so it is not a message-accuracy issue.
  - The `moar_tools/runner_stdout.log:53-93` agent crash terminates
    before any `[SPL] Command result` line could be emitted for the
    interrupted `!collectBlocks` — so there is no message to score.
- No fixes are recommended; this audit is diagnostic only.
