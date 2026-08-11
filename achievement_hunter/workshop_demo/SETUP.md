# Workshop Demo — Setup on a New Machine

Step-by-step setup for running the workshop demo on a computer that doesn't
have anything installed yet, including Prism Launcher. See `README.md` for
day-of-workshop quick-start once this is done, and `PLAN.md` for the full
design/implementation history.

This whole app (specifically the spectator auto-join in Phase 5) is
**macOS-only** — it shells out to a Prism executable path pattern and a
`pkill`-based process search that assume macOS.

## 1. Prerequisites

- **macOS**
- **Node.js** — v18 or v20 LTS recommended (matches the base Mindcraft
  project's own requirement; v24+ may cause native-dependency issues)
- **Java** — needed to run the managed Minecraft server. Check with
  `java -version`; any reasonably recent JDK works (this was built and
  tested against Java 22)
- **Git**
- An **API key** for at least one LLM provider. `achievement_hunter/src/profile.json`
  defaults to OpenAI's `gpt-5`, so an `OPENAI_API_KEY` is the simplest path
  unless you change the profile

## 2. Clone and install

```bash
git clone <this repo's URL>
cd embodied-intelligence-minecraft
npm install
```

Nothing extra to fetch for the demo itself — the Fabric server template
(`achievement_hunter/workshop_demo/server_templates/minecraft_1_21_6_fabric/`,
~144 MB: the Fabric-loader server jar pre-unpacked for fast boot, Fabric
API, and Fabric Tailor) and all
23 pre-generated PTDs are already committed to the repo. `npm install`
alone brings in everything code-side, including `mermaid` for the
dashboard's graph rendering.

## 3. API keys

```bash
cp keys.example.json keys.json
```

Open `keys.json` and fill in at least `OPENAI_API_KEY` (or whichever
provider matches the model set in `achievement_hunter/src/profile.json`).
`keys.json` is gitignored — this step has to happen on every new machine.

## 4. Install Prism Launcher

Download from [prismlauncher.org](https://prismlauncher.org/download/) and
install it — `/Applications` is the simplest location (also checked are
`~/Applications` and `~/Downloads`, and finally `PATH`, in that order — see
`server/prism_locator.js`). If it ends up somewhere else, set
`WORKSHOP_DEMO_PRISM_COMMAND` to the full path to the `prismlauncher`
executable inside the `.app` bundle (e.g.
`/path/to/Prism Launcher.app/Contents/MacOS/prismlauncher`).

No Microsoft/Mojang account needed anywhere in this setup — the managed
Minecraft server runs with `online-mode: false`, and the spectator client
joins with `-o <username>` (offline mode).

## 5. Create the Prism instance

In Prism Launcher, add a new instance:

- **Minecraft version:** `1.21.6`
- **Mod loader:** **Fabric Loader**, not vanilla — even though the
  spectator only watches (no mods needed client-side for that), the
  instance still needs Fabric Loader to match the server it's joining.
  Loader version `0.19.3` was used to build the server and is confirmed
  working; any recent 1.21.6-compatible Fabric Loader build should also
  work.
- **Instance name/ID:** exactly `1.21.6` — this must match
  `WORKSHOP_DEMO_PRISM_INSTANCE`'s default (see `server/config.js`).
  If you name it something else, set that env var to match.

You do not need to launch this instance manually or log into an account —
the demo's orchestrator launches it directly with the right server address
each time a PTD is selected.

## 6. (Optional) Auto-position the spectator window to the left half of the screen

Two one-time steps, both on the machine that will run the presenter's
client:

1. **Grant Accessibility permission to Prism Launcher** — System Settings
   -> Privacy & Security -> Accessibility -> add/enable **Prism Launcher**
   (not your terminal or editor — the whole point of this setup is keeping
   the grant scoped to the game launcher, not a general-purpose dev tool).
   This is required for any app to move/resize another app's window on
   macOS; there's no way to grant it from the command line.
2. **Point the Prism instance's `PreLaunchCommand` at the positioning
   script.** Edit the instance's `instance.cfg` (found at
   `~/Library/Application Support/PrismLauncher/instances/<instance
   name>/instance.cfg`):
   - Set `OverrideCommands=true`
   - Set `PreLaunchCommand="<absolute path to>/achievement_hunter/workshop_demo/scripts/position_window.sh"`

If you skip this, everything else still works — the spectator just opens
wherever the OS defaults to, and you position it yourself.

## 7. Run it

```bash
node achievement_hunter/workshop_demo/server/index.js
```

Open `http://localhost:4173`. Pick an achievement card. The dashboard will
walk through launching a fresh world, starting the agent, and joining the
spectator automatically — Prism Launcher and Minecraft will pop open on
their own partway through.

## Configuration reference

Every setting is in `server/config.js`, overridable via env var. The two
most likely to need changing on a new machine:

| Env var | Default | When to change it |
|---|---|---|
| `WORKSHOP_DEMO_PRISM_INSTANCE` | `1.21.6` | If the Prism instance from step 5 is named differently |
| `WORKSHOP_DEMO_PRISM_COMMAND` | auto-detected | If Prism isn't in `/Applications`, `~/Applications`, `~/Downloads`, or `PATH` |

The rest (`WORKSHOP_DEMO_PORT`, `WORKSHOP_DEMO_SPECTATOR_USERNAME`,
`WORKSHOP_DEMO_MINECRAFT_VERSION`, etc.) are documented in `config.js`'s
header comment and rarely need touching.

## Troubleshooting a fresh setup

- **Dashboard won't start / `npm install` errors:** see the base repo's
  `FAQ.md` for native-module build issues on macOS — unrelated to the
  workshop demo specifically.
- **World boots but the agent never says "ready" / times out:** almost
  always a missing or invalid API key — check
  `achievement_hunter/workshop_demo/.run/agent_stdout.log`.
- **Spectator never joins:** confirm the Prism instance name matches
  `WORKSHOP_DEMO_PRISM_INSTANCE` exactly (case-sensitive), and that it's a
  **Fabric** instance for `1.21.6`, not vanilla.
- **Managed server fails to start:** confirm `java -version` works in the
  same terminal/shell the dashboard is started from.
- **Everything works once, then breaks on the second run:** shouldn't
  happen — every run tears down and relaunches the world, agent, and Prism
  client fresh (see `PLAN.md`'s decision #4 and the Phase 5 addendum) — but
  if it does, check for leftover `java`/`node main.js`/Prism processes from
  a run that didn't shut down cleanly.
- **Spectator joins fine but the window never moves:** check
  `achievement_hunter/workshop_demo/.run/position_window.log`. `"assistive
  access not allowed"` means Accessibility isn't actually granted to Prism
  Launcher (re-check the toggle, and that Prism was fully quit/relaunched
  after granting it). No log file at all means `PreLaunchCommand`/
  `OverrideCommands` in `instance.cfg` isn't set correctly (see step 6).
