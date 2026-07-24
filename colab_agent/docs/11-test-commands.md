# 11 — Test Commands: Running the Full Colab-Agent Pipeline

Copy-pasteable commands for exercising Phases 1-3 end to end (disclosure → PTD → execution via `self_prompter`, per [doc 10](./10-phase-3-execution.md)). Builds on the setup in [doc 07](./07-running-and-visualizing.md) — same world-hosting steps, same env-var override pattern — but every command below adds `"colab_agent":true`, which doc 07 predates. Without that flag, count_id 0 runs the plain stock `Agent`, not `ColabCoordinatorAgent`, and none of Phases 1-3 run at all.

Run everything from the repo root.

---

## Prerequisites

Same as [doc 07 §1](./07-running-and-visualizing.md#1-host-the-world-from-your-minecraft-client):
1. Launch Minecraft **1.21.6** → Singleplayer → Create New World → **Allow Cheats: ON**.
2. **Esc → Open to LAN**, Allow Cheats: ON, port **55916**.
3. Confirm `OPENAI_API_KEY` is set in `keys.json`.

Leave that world open — you'll watch the bots directly in it.

---

## Test 1 — Phase 1/2 regression: compass (harder, multi-step, partial plan)

**Purpose:** confirm the Disclosure Loop and PTD generation still work correctly after the leader-framing goal-text change (doc 10 §9) and the `coordinator_agent.js`/`update()`/`handleMessage()` rewrite — this is the specific regression check flagged as outstanding in doc 10 §2 and §12.

```bash
cd /Users/Matthew/Desktop/AH-Hunter/embodied-intelligence-minecraft

SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false,"colab_agent":true}' \
PROFILES='["./colab_agent/profiles/andy.json","./colab_agent/profiles/jill.json"]' \
node main.js \
  --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
  --task_id multiagent_crafting_compass_partial_plan_requires_ctable__depth_0
```

**Task shape:** andy starts with `iron_ingot: 2`; jill starts with `iron_ingot: 2, redstone: 1, crafting_table: 1`. A compass needs 4 iron_ingot + 1 redstone at a crafting table — neither bot alone has enough, so success requires disclosure (each learns what the other has) and a plan (materials move to whoever ends up at jill's crafting table). 300s timeout.

**What to check:**
- Andy's console: `[Disclosure Loop] finished (complete) after N question(s)` — Phase 1 still works.
- `colab_agent/rollouts/<task_id>/<run>/world_state.json` correctly captures jill's `redstone`/`crafting_table`.
- `[PTD] structural validation passed` and `[PTD] task graph written to ...` — Phase 2 still works.
- `[Execution] phase 3 started: ...` — the chain now continues into Phase 3 automatically (this is new; Phase 2 alone used to be the last step before this build).
- Jill's very first injected goal text (grep `bots/jill/memory.json` or watch her `received message from system` line) should contain the new leader-framing sentence naming andy — confirms the `init_agent.js` change (doc 10 §9) actually landed.
- `colab_agent/rollouts/<task_id>/<run>/conversation.log` has the exchange.

---

## Test 2 — Full Phase 3 smoke test: pink_wool (simplest crafting task)

**Purpose:** the first real end-to-end test of the `self_prompter` handoff — andy executing a command himself, briefing jill via native `!startConversation`, and the episode terminating correctly regardless of which agent finishes it.

```bash
cd /Users/Matthew/Desktop/AH-Hunter/embodied-intelligence-minecraft

SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false,"colab_agent":true}' \
PROFILES='["./colab_agent/profiles/andy.json","./colab_agent/profiles/jill.json"]' \
node main.js \
  --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
  --task_id multiagent_crafting_pink_wool_full_plan__depth_0
```

**Task shape:** andy has `pink_dye: 1`; jill has `black_wool: 1`. One transfer, one craft. 300s timeout.

**What to check** (everything from Test 1, plus):
- Andy's console: `starting self-prompt loop` — confirms `self_prompter` actually engaged, not just that `start()` was called.
- `<name> full response to system: "..."` lines — andy reasoning over the rendered plan each cycle. The very first one should include your `renderPTD` output; worth reading in full once to sanity-check the rendering looks right.
- `Agent executed: !craftItem ...` (or `!givePlayer ...`) from whichever bot performs it.
- **The critical check**: `Task finished: ...` should print in **both** consoles, not just jill's — this confirms the `super.update()` → `checkTaskDone()` fix is real, not just present in the diff. If you can tell from the transcript that andy ends up crafting the pink_wool himself, that's the specific path that was previously undetected — worth re-running once with attention to who crafts if the first run has jill do it.
- `conversation.log` shows a *bounded* exchange (starts, resolves, ends) rather than staying open the whole episode.

---

## Test 3 — Harder Phase 3 test: cooking (real division of labor)

**Purpose:** a longer task where andy is more likely to need both his own actions and jill's, exercising sustained self-prompting and confirming the plan stays visible over more cycles (the whole reason it lives in `self_prompter.prompt` rather than history — doc 10 §5).

**Prerequisite (already done for you):** `colab_agent/profiles/andy_cooking.json` and `jill_cooking.json` now exist, copied from `profiles/tasks/cooking_profile.json` with the same name/model split as the crafting profiles (`andy`/`gpt-5`, `jill`/`gpt-4o-mini`). These matter now in a way they didn't before this build: Phase 3 routes andy's own execution reasoning through the profile's `conversing` template too (via `self_prompter`/`promptConvo`), so running a cooking task with crafting-flavored prompts could quietly hurt his reasoning in a way that never affected Phases 1-2.

```bash
cd /Users/Matthew/Desktop/AH-Hunter/embodied-intelligence-minecraft

SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false,"colab_agent":true}' \
PROFILES='["./colab_agent/profiles/andy_cooking.json","./colab_agent/profiles/jill_cooking.json"]' \
node main.js \
  --task_path tasks/cooking_tasks/require_collab_test_2_items/2_agent.json \
  --task_id multiagent_cooking_2_1_bread_1_golden_apple
```

**Task shape:** andy has `gold_ingot: 5`; jill has `gold_ingot: 5, apple: 1`. Goal is 1 `golden_apple` (needs 8 gold_ingot + 1 apple at a crafting table) and 1 `bread` (needs 3 wheat from the farm + a crafting table) — genuinely requires pooling gold_ingot *and* someone collecting wheat while the other crafts. 500s timeout.

**What to check** (everything from Test 2, plus):
- `conversation.log` should show real division of labor, not one bot doing everything while the other idles.
- Watch specifically for the stuck signal, never yet exercised in practice: `Agent did not use command in the last 3 auto-prompts. Stopping auto-prompting.` (also sent to in-game chat). This task's multi-step nature is the most likely place it could show up — if it does, that's `self_prompter`'s own give-up mechanism working as designed (doc 10 §7), not a crash; the episode should still end later via the 500s timeout if nothing else finishes it.

---

## Troubleshooting

For infra issues (bots not spawning, no items, wrong port), see [doc 07 §8](./07-running-and-visualizing.md#8-troubleshooting) first. Colab-agent-specific additions:

| Symptom | Likely cause |
|---|---|
| No `[Disclosure Loop]` / `[PTD]` / `[Execution]` tags at all | `"colab_agent":true` missing from `SETTINGS_JSON` — count_id 0 is running the plain stock `Agent`. |
| `[PTD] skipping` / `[Execution] skipping` | Phase 1 or 2 ended with a non-`complete` status — check `iterations.jsonl` or the console around that point for why. |
| Andy goes silent right after `phase 3 started` (no `starting self-prompt loop` line, ever) | Was a real bug in an earlier version of this build: an explicit `self_prompter.stop()` call before Phase 1 could permanently stick `SelfPrompter`'s internal `interrupt` flag at `true`, silently preventing every future `self_prompter.start()` from ever entering its loop (see `coordinator_agent.js`'s comment above the `_loop_started` block, and doc 10 §8). Fixed by removing that call — if you see this on the current code, something is calling `stop()`/`pause()` on the coordinator's `self_prompter` again. |
| `Self-prompt loop is already active. Ignoring request.` right after `phase 3 started` | Benign — means `self_prompter` was already actively spinning (harmlessly, from spawn-time `!goal()`) through Phase 1/2. It picks up the new plan and starts really executing on its very next cooldown cycle (within ~2s), no action needed. |
| Only jill's console ever prints `Task finished` | The `super.update()` → `checkTaskDone()` fix isn't taking effect — check `coordinator_agent.js`'s `update()` calls `super.update(delta)` before the phase-gate block. |
| `conversation.log` is missing or empty | `agent.runDir` never got set — check `world_state.js` still assigns it right after `makeRunDir(...)`. |

---

## Files these tests reference

- `colab_agent/profiles/andy.json`, `jill.json` — crafting-flavored (existing, used in Tests 1-2).
- `colab_agent/profiles/andy_cooking.json`, `jill_cooking.json` — cooking-flavored (new, used in Test 3; copied from `profiles/tasks/cooking_profile.json`).
