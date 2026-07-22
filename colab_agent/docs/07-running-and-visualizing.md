# 07 — Running & Visualizing a Collaborative Task

A copy-pasteable guide to running a **2-agent collaborative crafting task** and watching it in your own Minecraft 1.21.6 client. No `tmux`, no Python, and **no edits to `settings.js`** (we override via env vars so your Achievement Hunter config stays intact).

This uses the **stock Mindcraft multi-agent path** (`achievement_hunter: false`), which is what drives the collaborative `techtree`/`cooking`/`construction` tasks (see [doc 01](./01-task-system-overview.md)). The AH structured loop is single-agent and is *not* used here (see [doc 04](./04-achievement-hunter-reference.md)).

---

## TL;DR

```bash
cd /Users/Matthew/Desktop/AH-Hunter/embodied-intelligence-minecraft

SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false}' \
PROFILES='["./colab_agent/profiles/andy.json","./colab_agent/profiles/jill.json"]' \
node main.js \
  --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
  --task_id multiagent_crafting_pink_wool_full_plan__depth_0
```

…after you've **opened a Minecraft 1.21.6 world to LAN on port 55916 with cheats ON** (steps below). Two bots, `andy` and `jill`, join your world, talk, trade items, and craft a pink wool.

---

## Prerequisites (already satisfied on this machine, except the client)

| Need | Status here | Notes |
|---|---|---|
| Node.js | ✅ v20 | `node -v` |
| `OPENAI_API_KEY` in `keys.json` | ✅ set | The colab profiles use `gpt-4o-mini`. |
| Colab agent profiles | ✅ created | `colab_agent/profiles/{andy,jill}.json` |
| Minecraft **1.21.6** client | ⬜ you provide | Used both to **host** the world and to **watch**. |
| `tmux` / conda | not needed | Only the Python batch driver needs those. |

> The two profiles are faithful copies of `profiles/tasks/crafting_profile.json` (the crafting collaboration prompt + few-shot examples) with distinct names and an OpenAI model. To run cooking/construction instead, see [§6](#6-running-other-task-types).

---

## 1. Host the world from your Minecraft client

This is the key step that makes everything else "just work."

1. Launch **Minecraft 1.21.6**.
2. **Singleplayer → Create New World.**
   - **Game Mode: Creative** (easiest to fly around and watch), or Survival — either works.
   - **Allow Cheats: ON** ← *required.* (More Game Options → Allow Cheats.)
   - A **Superflat** world makes the bots easy to see, but any world is fine.
3. Enter the world. Open the menu (**Esc**) → **Open to LAN**.
   - **Allow Cheats: ON**.
   - **Port: 55916** (type it in the port box, available on 1.21.6's Open-to-LAN screen). If your version doesn't expose a port field, note the port it prints in chat ("Local game hosted on port …") and use that port in the command below.
4. You'll see **"Local game hosted on port 55916"** in chat. Leave this world open — you are now standing in the world the bots will join, so you can watch directly.

**Why no `/op` step?** Opening to LAN with *Allow Cheats: ON* enables commands for **every** player on that LAN session, including the bots. The bots' setup (`/give`, `/tp`, `/clear` in `initBotTask`, see [doc 01 §4](./01-task-system-overview.md)) therefore succeeds without per-bot operator grants. (The dedicated-server route in [§7](#7-alternative-dedicated-server--python-scoring) *does* require op'ing, which is why that path is more involved.)

---

## 2. Run the task

In a terminal at the repo root:

```bash
SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false}' \
PROFILES='["./colab_agent/profiles/andy.json","./colab_agent/profiles/jill.json"]' \
node main.js \
  --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
  --task_id multiagent_crafting_pink_wool_full_plan__depth_0
```

What each piece does:
- `SETTINGS_JSON` — overrides `settings.js` at import time (`settings.js:86-88`): point `host` at your local machine and turn **off** the AH loop so the collaborative stock path runs. Nothing is written to disk.
- `PROFILES` — overrides `settings.profiles` (`main.js:48-50`). **One profile per agent.** `pink_wool` is a 2-agent task, so list two. The bot names come from each profile's `name` (`andy`, `jill`).
- `--task_path` / `--task_id` — select the exact task (`main.js:30-39`).

**What you'll see in the terminal:** the MindServer starts, each bot logs in, `initBotTask` clears/gives inventory and teleports the bots together, agent 0 (`andy`) seeds the conversation (`!startConversation`), and the two begin exchanging messages and `!givePlayer`/`!craftItem` commands. The episode ends with a line like `Task ended with score : 1` on success, or score `0` at the 300 s timeout.

---

## 3. Watch it (three ways, use any/all)

### a) In your Minecraft client (best)
You're already in the world (you hosted it). The bots spawn near you after teleport. Fly/walk over to watch them coordinate and craft. Their chat appears in-game (`chat_ingame: true`).

> If instead you want to watch from a *second* client: Multiplayer → **Direct Connection** → `localhost:55916`.

### b) MindServer web UI — `http://localhost:8080`
Auto-opens on launch (`auto_open_ui: true`). Shows each agent's status, live chat/among-bot messages, and lets you send messages to a bot. This is the easiest way to follow the *coordination* (who said what, who gave what).

### c) Per-bot first-person view — `http://localhost:3000` (and `3001`, …)
Off by default. Enable by adding `render_bot_view` to the override:

```bash
SETTINGS_JSON='{"host":"127.0.0.1","achievement_hunter":false,"render_bot_view":true}' \
PROFILES='[...]' node main.js --task_path ... --task_id ...
```
Then open `localhost:3000` (andy / `count_id 0`) and `localhost:3001` (jill). Powered by `addBrowserViewer` (`src/agent/agent.js:117`, gated by `settings.render_bot_view`).

---

## 4. What this specific task requires (so you know what "success" looks like)

`multiagent_crafting_pink_wool_full_plan__depth_0`:
- **andy** (`count_id 0`) starts with `pink_dye: 1`; **jill** (`count_id 1`) starts with `black_wool: 1`.
- Recipe: `1 pink_dye + 1 black_wool → 1 pink_wool`.
- Neither bot has both inputs, so success requires: disclose inventories → one bot hands its item to the other → that bot crafts the pink wool. (This is the "converge-to-one" pattern from [doc 06](./06-task-demands-and-coordination.md).)
- **Timeout:** 300 s. Score is `1` if a `pink_wool` exists in inventory at check time, else `0` (`InventoryTaskValidator`, [doc 01 §4](./01-task-system-overview.md)).

---

## 5. Stopping a run

- The run ends itself on success/timeout and the bots disconnect.
- To stop early: `Ctrl-C` in the terminal.
- Close **Open to LAN** by exiting the Minecraft world (or just leave it open for the next run).

---

## 6. Running other task types

Swap the task file/id (and ideally the matching profile prompt). The colab profiles here use the **crafting** prompt; for best results on cooking/construction, copy the matching template (`profiles/tasks/cooking_profile.json` / `construction_profile.json`) into two renamed profiles the same way `andy.json`/`jill.json` were made.

| Goal | `--task_path` | example `--task_id` | Notes |
|---|---|---|---|
| Another 2-agent crafting | `tasks/crafting_tasks/test_tasks/2_agent.json` | `multiagent_crafting_compass_partial_plan_requires_ctable__depth_0` | Harder: multi-step + one bot's recipe lookup is blocked. |
| 2-agent cooking | `tasks/cooking_tasks/require_collab_test_2_items/2_agent.json` | *(open the file to pick an id)* | Use cooking-prompt profiles; world has farm/stations. |
| Hell's Kitchen (recipe swap) | `tasks/cooking_tasks/require_collab_test_2_items/2_agent_hells_kitchen.json` | *(first id in file)* | Pure communication task ([doc 02 §5](./02-initial-agent-state.md)). |
| 2-agent construction | `tasks/construction_tasks/custom/church_two_agents.json` | `church_two_agents` | **Add** `"allow_insecure_coding":true` to `SETTINGS_JSON` (bots write freeform JS via `!newAction`). Prefer Docker for safety. |

**Agent count must match the task.** A 3-agent task needs **three** profiles in `PROFILES` (and the task's `agent_count` must equal the number you list). For cooking with >2 agents, one bot's name must start with `andy` (the designated collector — [doc 02 §5](./02-initial-agent-state.md)); keep `andy.json` in the list.

List task ids in any file with, e.g.:
```bash
python3 -c "import json;print('\n'.join(json.load(open('tasks/crafting_tasks/test_tasks/2_agent.json')).keys()))"
```

---

## 7. Alternative: dedicated server / Python scoring

If you want **automatic scoring across many episodes** (results in `experiments/exp_*/`), use the intended batch driver instead of the manual run:

```bash
brew install tmux           # not currently installed on this machine
# create a conda env per minecollab.md, then:
python tasks/evaluation_script.py \
  --task_path tasks/crafting_tasks/test_tasks/2_agent.json \
  --model gpt-4o-mini --template_profile profiles/tasks/crafting_profile.json
```
This launches its own Minecraft server in tmux, op's the bots automatically (`make_ops`), runs the agents, and aggregates scores. Caveats for this machine: `tmux` is **not installed**, and the script expects a world at `tasks/server_data/` which is **missing** (download per `minecollab.md`, or adapt it to the committed template at `achievement_hunter/evaluation_harness/server_templates/minecraft_1_21_6_clean`). For just *watching one task*, the manual route above is simpler.

To watch a Python-driven run, Direct-Connect your client to `localhost:55916` once the server is up.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `MC server not found (Host: …, Port: 55916)` | World isn't open to LAN, wrong port, or `host` not `127.0.0.1`. Confirm the "hosted on port" message and that `SETTINGS_JSON` sets `host`. |
| Bots join but get no items / never craft | **Cheats not enabled** on the LAN world. `initBotTask`'s `/give`/`/tp` silently fail without cheats. Re-open to LAN with *Allow Cheats: ON*. |
| `No other agents found`, score 0 | Only one profile listed, or the second bot failed to log in (duplicate name, or it crashed). Ensure two **distinct** names in `PROFILES`. |
| Bots connect but won't talk / immediate errors | Model/key issue. Confirm `OPENAI_API_KEY` in `keys.json`; `gpt-4o-mini` must be accessible on that key. |
| Only one bot appears in-world | `agent_count` in the task ≠ number of profiles, or names collide. One profile per agent, unique names. |
| AH single-agent behavior instead of collaboration | `achievement_hunter` wasn't turned off. It must be `false` (the `SETTINGS_JSON` override does this). |
| Construction bot does nothing structural | Needs `"allow_insecure_coding": true` to use `!newAction`. |

---

## Files this guide added

- `colab_agent/profiles/andy.json` — agent 0 (name `andy`), crafting prompt, `gpt-4o-mini`.
- `colab_agent/profiles/jill.json` — agent 1 (name `jill`), same prompt.

Both are plain Mindcraft profiles; edit `model`/`name`/`modes` freely. See [doc 02 §2](./02-initial-agent-state.md) for what each profile field controls.
