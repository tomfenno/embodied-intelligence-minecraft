# Achievement Hunter — Workshop Demo

Interactive conference demo: pick a pre-generated PTD from a web dashboard
(no LLM call), watch the agent run it live in a fresh peaceful survival
world, with a spectator client auto-joining to follow along and a live
view of the rollout state underneath. See `PLAN.md` for the full design
and implementation history.

## Running it

```bash
node achievement_hunter/workshop_demo/server/index.js
```

Then open `http://localhost:4173` (or whatever `WORKSHOP_DEMO_PORT` is set
to). Pick an achievement card to start a run; the dashboard shows progress
through world boot, agent startup, and the live rollout view once the
agent starts working. A "Back to selection" button tears the current run
down and returns to the picker.

## One-time setup (per presenter machine)

- **Prism Launcher** installed, with an instance already created matching
  `WORKSHOP_DEMO_PRISM_INSTANCE` (default instance ID: `1.21.6`). No
  Microsoft account needed — the spectator joins offline.
- **Java** available on `PATH` (used to run the managed Minecraft server).

Nothing else — PTDs, the Fabric server template, and all mods are already
checked into the repo.

**Optional — auto-position the spectator window to the left half of the
screen:** grant Accessibility permission to Prism Launcher (System
Settings -> Privacy & Security -> Accessibility — scoped to Prism
specifically, not your terminal/editor) and point the Prism instance's
`PreLaunchCommand` at `scripts/position_window.sh` (`OverrideCommands=true`
in the instance's `instance.cfg`). See `SETUP.md` step 6 for the full
walkthrough. Skippable — everything else works without it.

## Configuration

Every setting lives in `server/config.js` and is overridable via env var;
defaults match what's already verified working. See that file's header
comment for the full list (`WORKSHOP_DEMO_PORT`,
`WORKSHOP_DEMO_PRISM_INSTANCE`, `WORKSHOP_DEMO_SPECTATOR_USERNAME`, etc.).

## Troubleshooting

- **Spectator never joins / stuck on "Launching Prism Launcher…":** confirm
  `WORKSHOP_DEMO_PRISM_INSTANCE` matches an instance that actually exists
  in Prism, and that `WORKSHOP_DEMO_PRISM_COMMAND` (if set) points at a
  real executable. `server/prism_locator.js` searches
  `/Applications`, `~/Applications`, `~/Downloads`, then `PATH`.
- **Agent never starts / "Sending objective…" times out:** check
  `achievement_hunter/workshop_demo/.run/agent_stdout.log` for the agent
  process's own output.
- **A run starts already mid-task instead of on the picked achievement:**
  a stale `achievement_hunter/rollouts/checkpoint.json` from an earlier
  interrupted run — `orchestrator.js` clears this automatically at the
  start of every run, so this shouldn't happen; if it does, something
  outside this app wrote a checkpoint after that clear.
- **Spectator window never moves to the left half:** check
  `.run/position_window.log` — see `SETUP.md`'s troubleshooting section for
  what each failure mode there means.
