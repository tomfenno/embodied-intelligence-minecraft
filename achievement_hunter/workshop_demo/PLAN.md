# Workshop Demo — Implementation Plan

Interactive conference demo: a participant picks a pre-generated PTD, the agent
runs it live in a fresh peaceful survival world, the presenter's Minecraft
client auto-joins as spectator to watch, and a projector-friendly dashboard
shows the live rollout state ("under the hood").

> Revised after a verification pass against the actual source (see "Verified
> against code" note on each phase). Two real issues were found and are now
> addressed as explicit steps: the agent had no way to receive an objective
> at all (Phase 2), and the default `host.docker.internal` setting would
> silently break the non-Docker launch (Phase 1).
>
> **Phases 1-3 are implemented and smoke-tested end-to-end** (real Java
> server + real agent process, not just code review) as of this revision —
> see the "Implemented" note on each. Phase 2's mechanism changed from the
> original plan during implementation: it uses chat-message injection, not
> the benchmark `--task_path`/`--task_id` route (see decision #7 and Phase 2
> below) — this was discovered to be simpler and turned out to eliminate an
> entire open risk (the PTD→task-config mapping table is no longer needed).
>
> **Phase 4 is fully implemented** (selection view, orchestration, and the
> live-state view) and HTTP-driven end-to-end tested against real runs —
> real `curl` calls against a running dashboard server, not just
> unit-level checks. Testing the selection/launch half surfaced a real,
> non-obvious bug (checkpoint hijacking — see below) that would have broken
> the demo unpredictably on stage; it's now fixed.
>
> **Phase 5 is implemented and verified with a real live run** — Prism
> Launcher was actually invoked, a real Minecraft client joined the demo
> world, and the server log confirmed both the login and the gamemode
> switch (`Set Spectator's game mode to Spectator Mode`), with the agent
> already reaching `running` before the spectator finished joining,
> confirming the concurrency doesn't stall the core demo. A follow-up
> extended Phase 5 to keep the camera locked onto AH_Bot across reconnects,
> not just the initial join (verified live too — see Phase 5 below).
>
> **Addendum — AH_Bot's custom skin, verified working.** Required swapping
> Phase 1's managed server from vanilla to a new Fabric-based template (see
> "Addendum" section below) so the skin-setting mechanism that already
> existed in base Mindcraft (`agent.js`) and was already configured in
> `profile.json` could actually take effect. Verifying it live surfaced a
> stale-client bug in the spectator auto-join (a client left running from a
> prior run wouldn't rejoin a new world) — now fixed by force-closing any
> existing client before every launch, verified live.
>
> **All six phases plus the skin addendum are now implemented and verified
> live.** Phase 6 consolidated every setting scattered across Phases 1-5
> into a single `server/config.js`, added a `README.md` for actually
> running the thing, and a full end-to-end run with zero env vars set
> confirmed every new default is correct.

## Decisions made (see conversation for rationale)

1. **PTD selection UI:** web dashboard — landing screen shows cards for the
   pre-generated PTDs; clicking one starts the run. No LLM call.
2. **Live viz transport:** file-polling, not websockets. Dashboard polls a
   JSON file on disk every ~1s. Chosen over push for on-stage reliability —
   no reconnect logic to fail live.
3. **Live viz layout:** mirrors `achievement_hunter/rollout_live/current_rollout.md`'s
   existing structure (header/elapsed/status, PTD graph with current-node
   highlight, current-task card, current-action card), restyled dark theme
   with large type for projector legibility.
4. **World:** fresh peaceful survival world spun up per run, reusing the
   eval harness's `managed_local` server provider rather than building new
   spin-up logic.
5. **Watching the agent:** a real Minecraft Java client (Prism Launcher,
   already installed by presenter), not `prismarine-viewer` (confirmed to be
   an approximate Three.js re-render, not the actual game).
6. **Auto-join:** Prism Launcher's CLI (`-l <instance> -s <host:port>`)
   direct-join flag, shelled out to when a PTD card is selected. Chosen over
   driving the official launcher, which has no clean CLI/auth surface for
   this and would require reimplementing Microsoft auth.
7. **Objective injection (revised during implementation):** the agent already
   defaults to `achievement_hunter: true` and idles waiting for a chat-message
   objective on spawn (`settings.js:80`) — this is the same channel the
   built-in web UI already uses to send a message
   (`src/mindcraft/public/index.html:940`, socket.io `send-message` event).
   The orchestrator connects as a plain socket.io client to the agent's
   mindserver and sends the objective over that channel once the agent
   reports ready, rather than synthesizing eval-harness task-config JSON
   entries. Simpler than the originally-planned benchmark-mode route, and it
   removes the need for any PTD-filename→task-id mapping table — see Phase 2.

## Relevant existing code (from exploration)

- **PTD generation (to be bypassed):** `achievement_hunter/src/pipeline/self_refine.js:39-164`
  (`generate_self_refined_ptd`), `:170` (`generate_primary_task_dag_self_refined`).
- **Disk-load path (already exists, already default-on):**
  `achievement_hunter/src/pipeline/structured_loop/config.js:19` (`LOAD_PTD_FROM_DISK = true`),
  `:24` (`PTD_JSON_DIR`), `:31-41` (`PTD_JSON_OVERRIDE_PATH`, currently `null`,
  hardcoded — needs env-var plumbing, see Phase 2).
  Consumed in `achievement_hunter/src/pipeline/structured_loop/loop.js:31-45`
  and `:307-313` (`load_graph_from_file`).
- **Pre-generated PTDs:** `achievement_hunter/docs/ptd_jsons/*.json` (23 files).
- **Live dashboard writer (exists, disabled by default):**
  `achievement_hunter/src/pipeline/rollout_logger.js`
  — `write_dashboard()` (`:626-650`), `write_file()` (`:606-616`),
  `render_live()` (`:732-794`, called after nearly every pipeline event, and
  the only place `live_state` is in scope — see Phase 3),
  gated by `ENABLE_LIVE_VIEWER = false` at `config.js:151` (plain top-level
  const, 5 read sites in `rollout_logger.js`: lines 607, 619, 661, 733, 1044).
- **Managed local server spin-up (to be reused):**
  `achievement_hunter/evaluation_harness/lib/suite.js`
  — `prepareManagedServer()` (`:491-522`, pure function, no episode-state
  coupling, currently unexported — writes `server.properties`, defaults
  `difficulty: 'peaceful'`, `gamemode: 'survival'`, `online-mode: false`),
  server template copy + port pick + launch (`:284-307`),
  agent child-process launch (`:339-353`, `node main.js --task_path ... --profiles ...`),
  `SETTINGS_JSON` env override including `host: '127.0.0.1'` (`:315-325, 478-489`).
- **Reusable process helpers (in `evaluation_harness/lib/utils.js`):**
  `launchLoggedProcess()` (`:192-205`, plain `child_process.spawn`, `stdio: ['pipe','pipe','pipe']`),
  `chooseFreePort()`, `waitForServerReady()`,
  `sendServerConsoleCommand(processHandle, command)` (`:274-290`, writes to
  the spawned server's stdin — already used for `gamerule spawnRadius 0` at
  `suite.js:307`, directly reusable for the spectator gamemode command),
  `stopServerProcess()` (`:251-272`, writes `'stop\n'` to stdin — reusable
  for cleanup).
- **Agent entrypoint:** `main.js` → `create_achievement_agent()`
  (`achievement_hunter/src/agent/create_achievement_agent.js`), gated by
  `settings.achievement_hunter` (`settings.js:80`). `main.js` has no
  Docker-specific code and no env override for `host` — see Phase 1.
- **Docker default landmine:** `settings.js:3` defaults `host` to
  `'host.docker.internal'` (non-Docker alternative `'127.0.0.1'` is
  commented out in the same file). Outside Docker, this must be overridden
  or the agent cannot connect to the Minecraft server — see Phase 1.
- **Objective plumbing:** `structured_loop(task_name, ...)` (`loop.js:21`)
  takes an `objective` string. Task filename derivation
  (`to_snake_case(task_name)`, `json_utils.js:81-86`) is wording-sensitive —
  e.g. `"Cook a pork chop."` → `cook_a_pork_chop.json`, not
  `cook_a_porkchop.json` (both exist in `docs/ptd_jsons/`, confirming this is
  a real trap, not hypothetical). `PTD_JSON_OVERRIDE_PATH` bypasses this
  derivation entirely, so the exact wording of the objective sent to the
  agent no longer matters for which PTD loads — see Phase 2.
- **Chat-message objective injection (used by Phase 2 instead of benchmark
  mode):** default interactive flow — `achievement_agent.js:89-90` sets
  `_waiting_for_objective = true` and calls
  `openChat('Achievement Hunter ready! Send me an objective to begin.')`;
  `handleMessage()` (`achievement_agent.js:124-143`) treats the next
  non-`!`-prefixed message as the objective and calls `_launch_spl(message)`.
  Messages arrive via `mindserver_proxy.js:64-70`
  (`socket.on('send-message', ...)` → `agent.respondFunc(from, message)`),
  routed server-side by `mindserver.js:199-209`
  (`socket.on('send-message', (agentName, data) => agent_connections[agentName].socket.emit(...))`)
  — the exact mechanism `public/index.html:940` uses for the web UI's own
  chat box. The agent's readiness message is broadcast to all connected
  mindserver clients via `bot-output` (`agent.js:436`
  `sendOutputToServer()` → `mindserver.js:211-213` `io.emit('bot-output', ...)`),
  which is what the orchestrator waits on before sending — sending before
  `_waiting_for_objective` is actually `true` gets silently dropped with no
  error, so this readiness signal isn't optional.

## Phases

### Phase 1 — Reusable world spin-up (host launch, no Docker) — ✅ Implemented

*Verified against code: extraction is low-complexity — `prepareManagedServer()`
already has no episode-state coupling, just needs `export` added. The eval
harness proves the whole flow works as plain host child processes; Docker is
only a documented convenience for the manual/interactive README flow, not a
hard requirement.*

- `prepareManagedServer()` exported from `evaluation_harness/lib/suite.js`
  (one-line change).
- `achievement_hunter/workshop_demo/server/world_launcher.js` (new):
  - `launchManagedWorld(worldConfig, seed)` — `chooseFreePort()` →
    `prepareManagedServer()` → `launchLoggedProcess()` (java server) →
    `waitForServerReady()` → `sendServerConsoleCommand('gamerule spawnRadius 0')`.
    Returns `{host, port, serverProcess, sendConsoleCommand, stop}`. Port is
    dynamic, not hardcoded, per the plan's original reasoning.
  - `buildAgentLaunchEnv({host, port, mindserverPort, ...})` — builds the
    `SETTINGS_JSON`/`MINECRAFT_PORT`/`MINDSERVER_PORT` env, setting
    `host: '127.0.0.1'` explicitly. **This is the host-override fix** —
    without it `main.js` inherits `settings.js`'s `host.docker.internal`
    default and silently fails to connect outside Docker.
- **Smoke-tested live:** launched a real Minecraft server via this module,
  spawned the actual agent (`node main.js`, no Docker) with the built env,
  confirmed the bot logged in (server log showed `logged in with entity id`),
  then tore both down via `.stop()`.

### Phase 2 — Objective injection & PTD selection — ✅ Implemented

*Verified against code: the original plan only covered which PTD file loads,
not how the agent receives an objective at all — this was a real gap.
**During implementation, the planned fix (benchmark `--task_path`/`--task_id`
mode + a PTD→task-id mapping table) was replaced with something simpler**:
the agent's own default chat-message objective flow, discovered while
building Phase 1 (see decision #7 and the "Chat-message objective injection"
note above).*

- `achievement_hunter/src/pipeline/structured_loop/config.js` —
  `PTD_JSON_OVERRIDE_PATH` now reads `process.env.AH_PTD_JSON_OVERRIDE_PATH`
  at module load, falling back to `null`. Single consumer (`loop.js:32`),
  trivial change as planned.
- `achievement_hunter/workshop_demo/server/ptd_catalog.js` (new) — lists
  `docs/ptd_jsons/*.json`, and derives a human-readable objective sentence
  from a filename (e.g. `cook_a_porkchop.json` → `"Cook a porkchop."`). The
  exact wording only affects display/logging, not which PTD loads, since
  `PTD_JSON_OVERRIDE_PATH` always wins over `to_snake_case(objective)`
  filename matching.
- `achievement_hunter/workshop_demo/server/objective_injector.js` (new) —
  `sendObjective({mindserverPort, agentName, objective})` connects a
  socket.io client to the agent's mindserver, waits for the `bot-output`
  readiness broadcast (`"Achievement Hunter ready"`), then emits
  `send-message` with the objective — the same call path the built-in web
  UI's chat box uses. No benchmark task-config JSON, no mapping table.
- **Env-var plumbing for the orchestrator:** set `AH_PTD_JSON_OVERRIDE_PATH`
  (repo-root-relative path) and `AH_ENABLE_LIVE_VIEWER=1` in the same `env`
  object `buildAgentLaunchEnv()` (Phase 1) produces, before spawning
  `node main.js`.
- **Smoke-tested live, full path:** picked `cook_a_porkchop.json` from the
  catalog → launched world (Phase 1) → launched agent with
  `AH_PTD_JSON_OVERRIDE_PATH` set → waited for the readiness broadcast →
  sent `"Cook a porkchop."` via `sendObjective()` → confirmed via the live
  JSON file (Phase 3) that `ptd.source === 'disk'` and `objective === "Cook
  a porkchop."` — i.e. no LLM call, correct PTD loaded, entirely through the
  real chat-injection path.
- **One race found and fixed during testing:** the injector's first
  implementation rejected on the socket's very first `connect_error` (fired
  because the mindserver process is still starting up at the moment the
  socket connects). socket.io's default reconnection logic already retries
  with backoff, so the fix was to stop treating the first `connect_error` as
  fatal and rely solely on the overall `timeoutMs` for failure.

### Phase 3 — Live state as JSON — ✅ Implemented

*Verified against code: correcting one detail from the original plan — the
insertion point is `render_live()`, not `write_dashboard()`, since that's
where `live_state` is actually in scope. Also, `live_state` alone is
missing elapsed-time/status fields needed for the dashboard header.*

- **`ENABLE_LIVE_VIEWER` env override — simpler than originally planned:**
  it's a plain top-level const (not a wrapper function like
  `ENABLE_ROLLOUT_LOGGING`/`is_rollout_logging_enabled()`). Redefining it in
  `config.js` as `export const ENABLE_LIVE_VIEWER = false ||
  env_truthy('AH_ENABLE_LIVE_VIEWER');` propagates to all 5 call sites in
  `rollout_logger.js` automatically — zero edits needed there.
- Inside `render_live()` (`rollout_logger.js:732-794`, where `live_state` is
  in closure scope), add a JSON write via the existing `live_writer.write_file()`
  helper (gets diff-caching for free, same as the markdown writes):
  `live_writer.write_file(LIVE_FILE.JSON, () => JSON.stringify(payload, null, 2))`.
- **Payload must be augmented, not a raw `live_state` dump:** include
  `rollout.status` and the output of `current_elapsed()` (`:726-730`)
  explicitly — these only exist today as pre-rendered markdown strings
  passed into `write_dashboard()`, not inside `live_state` itself. Without
  this, the dashboard's header/elapsed/status panel (decision #3) has
  nothing to render.

### Phase 4 — Dashboard web app — ✅ Implemented

*Verified against code: added an explicit port-pinning requirement not in
the original plan.*

New directory: `achievement_hunter/workshop_demo/` (all pieces below exist)
- `server/index.js` — Express server, listens on port **4173** (pinned, per
  the port-collision note below) serving `public/` plus:
  - `GET /api/ptds` — all 23 PTDs with `objectiveFromPtdFilename()` title
    and a mermaid preview (`graph_to_mermaid()` from
    `achievement_hunter/src/pipeline/graph_utils.js`, fence-stripped for the
    browser mermaid.js runtime)
  - `POST /api/start` — calls `orchestrator.startRun(filename)`, returns
    immediately with the initial status; client polls for the rest
  - `POST /api/stop`, `GET /api/status`
  - `/vendor/mermaid/*` — `express.static` mount straight onto
    `node_modules/mermaid/dist` (added as a real dependency, `mermaid.min.js`
    UMD bundle — the `.esm.min.mjs` build lazy-loads chunks over the
    network, unsuitable for a possibly offline venue)
- `server/orchestrator.js` — single-run state machine (`idle` →
  `launching_world` → `starting_agent` → `injecting_objective` → `running` /
  `error`). `startRun()` always calls `stopRun()` first (fresh world +
  fresh checkpoint per selection, not just fresh world as originally
  decided — see the checkpoint note below). Phase 5 (Prism join) is not
  wired in yet, so there's no `waiting_for_spectator` state yet.
- `public/index.html`, `app.js`, `styles.css` — dark-themed selection grid
  of PTD cards (mermaid preview rendered client-side via `mermaid.render()`)
  that POSTs to `/api/start` on click and switches to a run view.
- **Port pinned to 4173**, confirmed free of the 3000-3003 (prismarine-viewer)
  and 8080 (mindserver default) collision zone this plan flagged earlier.

**Live view (decision #3), implemented:** once a run starts, the client
polls `/api/status` and `/api/live` together every 1s. `/api/live` reads
`current_rollout.json` (Phase 3) and reshapes it: `render_live_mermaid()`
(new, `server/index.js`) takes the base diagram from `graph_to_mermaid()`
and layers on two extra mermaid `style` statements not present in the
static catalog preview — the in-progress node (`task_state.task.target_item`,
styled blue) and nodes no longer listed in the latest SCSG's remaining
vertices (styled dimmed gray), leaving untouched nodes at mermaid's default
style. The frontend renders header/elapsed/status, the graph, current-task
card, and current-action card — the same four panels `current_rollout.md`
has, mirrored into live HTML as decision #3 specified.

**Verified against real runs, both mid-run and completed:** polled
`/api/live` through an actual run and observed `elapsed` genuinely ticking
up (`0s` → `42s` → `46s` → `54s`) while `status: running`; then on a
completed run confirmed `elapsed` freezes at `total_elapsed` (matches
`rollout_logger.js`'s own `current_elapsed()` behavior), and the mermaid
payload had exactly 8 dimmed nodes + 1 blue current node + 1 green sink for
a 9-vertex graph where only the final smelt step remained — correct on both
counts.

**Real bug found and fixed during HTTP-driven testing — checkpoint
hijacking:** `achievement_agent.js` resumes automatically from
`achievement_hunter/rollouts/checkpoint.json` if one exists on spawn
(`achievement_agent.js:39-70`), **skipping the "waiting for objective" chat
flow entirely** — no readiness broadcast is ever sent in that path. A
checkpoint left over from an earlier interrupted run (this app's own
Phase 1/2 smoke tests included) silently made a *later* run resume the
*old* objective instead of the newly-selected PTD, while
`objective_injector.js`'s wait for the readiness broadcast timed out for a
completely different reason (the message it was waiting for was never
going to be sent). The agent was actually running successfully the whole
time — just running the wrong, stale task, invisibly. `evaluation_harness/lib/suite.js`
already guards against exactly this at suite start
(`clearAchievementHunterCheckpoint()`), but the workshop demo orchestrator
hadn't replicated it. **Fix:** `orchestrator.js`'s `stopRun()` now awaits
the previous agent process's actual exit (`waitForProcessExit`, not just
sending the kill signal) and then calls `clearCheckpoint()`
(`achievement_hunter/src/pipeline/checkpoint.js`) before every run,
including the first. Verified: planted a stale checkpoint for a different
objective, confirmed it's gone immediately after `/api/start`, and the
agent log showed the chat-injection path (`"[SPL] Received objective
from..."`), not the checkpoint-resume path, on the next run.

### Phase 5 — Spectator auto-join — ✅ Implemented

*Verified against code, then against a real live run — see below.*

- `server/prism_locator.js` (new) — `resolvePrismCommand()` checks a few
  candidate macOS paths (`/Applications`, `~/Applications`, `~/Downloads`,
  then `PATH`) for the Prism executable. Confirmed on this machine: Prism
  is installed at `~/Downloads/Prism Launcher.app/...` (not yet moved to
  `/Applications`) and correctly resolved.
- `PRISM_INSTANCE` (default `'1.21.6'`, matching an instance found already
  configured on this machine at `~/Library/Application Support/PrismLauncher/instances/1.21.6`)
  and `SPECTATOR_USERNAME` (default `'Spectator'`), both env-var
  overridable — originally in a dedicated `spectator_config.js`, later
  folded into the consolidated `server/config.js` in Phase 6.
- `server/spectator.js` (new) — `launchPrismSpectator({host, port})` shells
  out to `prismlauncher -l <instance> -s <host>:<port> -o <username>
  --show-window`. The `-o/--offline` flag (found via `prismlauncher --help`
  on this machine, not assumed from memory) launches with a given player
  name with no real Microsoft account needed — works because the managed
  server already sets `online-mode: false` (Phase 1). `waitForSpectatorLogin()`
  polls the server's stdout log for the spectator's login line, the same
  signal Phase 1 used to confirm the agent's own connection.
- `server/orchestrator.js` — `runSpectatorFlow()` runs **concurrently** with
  agent startup, not awaited by the main chain: a Prism/client hiccup
  should never stall the actual demo run. Progress is tracked in
  `current.spectator` (`idle` → `launching` → `joined` / `timeout` /
  `skipped` / `error`, plus a `spectating: true` flag once camera-follow
  succeeds) and surfaced in the dashboard. After a confirmed login, it
  calls `world.sendConsoleCommand('gamemode spectator <username>')`,
  reusing the same `sendServerConsoleCommand()` helper Phase 1 already uses
  for `gamerule spawnRadius 0` — no new stdin-writing needed, as originally
  planned. It then waits (briefly — `AH_Bot` is normally already connected
  by this point) for the bot's own login line via `waitForPlayerLogin()`
  (renamed from `waitForSpectatorLogin()` to be generic over which
  username it's watching for) and sends `spectate AH_Bot <username>` —
  vanilla Minecraft's camera-follow command, run from the console so it
  bypasses the permission check `/spectate` normally requires of the
  invoking player.
- One-time manual setup (documented, not code): presenter needs a Prism
  instance matching `PRISM_INSTANCE` already created (this machine already
  has one, `1.21.6`) — no logged-in account required given the offline-join
  flag above.

**Verified with three real live runs** (explicit user go-ahead, since this
pops a visible window): the first confirmed `spectator.status` progressing
`launching` → `joined` with the server log showing the gamemode switch
(`Set Spectator's game mode to Spectator Mode`), and the main `status`
already reaching `running` before the spectator finished joining
(concurrency working as designed). A follow-up — "have the client spectate
AH_Bot on join, not just free-fly" — was verified in a second live run:
`spectator.spectating: true` in the API response, and the server log
showing `Now spectating AH_Bot` directly.

**Reconnect handling (follow-up):** vanilla Minecraft drops `/spectate`'s
camera lock whenever the spectated entity leaves the world — including
`achievement_agent.js`'s own `RESTART_MSG` path ("Safely restarting to
update inventory"), which keeps the agent process alive but cycles the
mineflayer connection, producing a fresh server login line. The one-shot
spectate call was replaced with `watchBotLogins()` (`spectator.js`) — polls
the server log's `AH_Bot ... logged in` line *count*, and re-issues
`spectate AH_Bot <username>` every time that count increases, not just
once. `orchestrator.js` stores the watcher's stop function on `handles` and
calls it in `stopRun()` alongside the other teardown steps, so it doesn't
leak a timer across runs. **Verified live:** confirmed initial spectate,
then simulated a reconnect by killing and relaunching the agent process
against the same world/ports — the server log showed `Now spectating
AH_Bot` a second time, with no manual intervention.

### Addendum — AH_Bot's custom skin — ✅ Implemented

*Triggered by a direct request to give AH_Bot a specific skin
(`https://www.minecraftskins.com/uploads/skins/2026/02/16/computer-23869410.png?v950`).
Investigation found the mechanism already half-built:*
`achievement_hunter/src/profile.json` already had `skin: {model: "classic",
path: "<that exact URL>"}` configured, and base Mindcraft's `agent.js`
(`:101-105`) already sends `/skin set URL <model> <path>` automatically the
moment the bot logs in, when `profile.skin` is set — confirmed pre-existing,
not something built in this session. The repo's own `README.md:23` even
documents this exact URL for the manual (non-workshop-demo) flow via
`/execute as AH_Bot run skin set URL classic <url>`.

**The actual gap:** `/skin set` only exists if the server has the **Fabric
Tailor** mod installed (per a comment in `agent.js` and confirmed by
`README.md`'s manual instructions assuming a Fabric-modded world). Phase 1's
managed server template (`evaluation_harness/server_templates/minecraft_1_21_6_clean`)
is plain vanilla — the command would silently fail as unknown there. Fixed
by **not** modifying the eval harness's shared vanilla template (benchmark
runs should stay on an unmodified server for reproducibility) and instead
building a separate Fabric server template just for the workshop demo:

- `achievement_hunter/workshop_demo/server_templates/minecraft_1_21_6_fabric/`
  (new, ~62 MB, added the same way the eval harness's own vanilla
  `server.jar` is already committed directly to git in this repo — no LFS
  in use here) — built via Fabric's official installer (`fabric-installer
  1.1.2`, `fabric-loader 0.19.3`, both current-stable per Fabric's meta API
  at build time) run with `-downloadMinecraft`, producing
  `fabric-server-launch.jar` + `libraries/` + the vanilla `server.jar` it
  wraps. `mods/` holds `fabric-api-0.128.2+1.21.6.jar` (FabricTailor's
  declared dependency) and `fabrictailor-2.7.0.jar` (both resolved via
  Modrinth's API for the 1.21.6/fabric combination, not assumed).
  `config/fabrictailor.json` is pre-seeded with `debug: true` (so
  skin-change attempts are visible in the server console log — by default
  FabricTailor only replies to the *issuing player's own chat*, which our
  bot-issued command would otherwise make invisible to us entirely) and
  `skin_change_timer: -1` (disables the default 60s cooldown, since a demo
  may restart the same achievement repeatedly).
- `server/world_launcher.js` — `DEFAULT_WORLD_CONFIG.server_template_path`
  now points at the new Fabric template; added a `server_jar_name` field
  (`'fabric-server-launch.jar'`, the actual jar the Fabric installer
  produces — not `server.jar`, which under Fabric is just a dependency the
  launch jar wraps) so the launch command isn't hardcoded to the vanilla
  filename. Callers can still override both fields back to the vanilla
  template if mods are ever unwanted.

**Verified live, end to end, with `AH_ENABLE_LIVE_VIEWER`-style debug
logging:** the server log showed FabricTailor fetching the exact skin URL,
parsing a successful reply (even surfacing the skin's own tags — "robot",
"futuristic", "gray" — a good sign the right image was actually fetched),
and reloading it onto AH_Bot's client — all fully automatic, no new
command-sending code required beyond pointing at a server that supports the
command that already existed.

**Stale-client issue found during verification — now fixed.** A Minecraft
client left over from an *earlier* Prism launch does not reliably rejoin a
*new* server when `prismlauncher -l -s` is invoked again — a spectator-join
attempt timed out against a stale, already-running client from a prior
test, then succeeded immediately once that stale client was killed and the
same run retried from a clean slate. Investigated whether an already-running
client could be redirected in place instead of relaunched: **it can't** —
vanilla Minecraft's client has no external command channel while running
(no socket, no RPC); launch-time flags like `-s`/`--quickPlayMultiplayer`
only take effect at process start. The only alternatives would be OS-level
UI automation or a custom companion mod exposing an RPC hook — both
meaningfully more fragile than a clean relaunch.

**Fix:** `spectator.js`'s `launchPrismSpectator()` now always closes any
existing Prism/Minecraft client first (`pkill -9 -f <pattern>` against both
the resolved Prism executable path and `org.prismlauncher.EntryPoint`, the
actual game process's main class — SIGKILL since there's no spectator-side
game state worth a graceful shutdown for), waits 2s, then launches fresh.
`launchPrismSpectator()` became `async` for this (the kill+wait needs to be
awaited); this surfaced a real latent bug at the call site —
`orchestrator.js`'s `runSpectatorFlow()` was calling it without `await`,
which would have made `launch.launched` read as `undefined` on every run
(since a `Promise` has no `.launched` property) and silently report
`spectator: {status: 'skipped'}` forever. Fixed alongside the main change.
**Verified live:** confirmed two stale processes running from a prior test,
started a new run, confirmed those exact PIDs were gone and replaced by
fresh ones, and the server log showed a clean `Now spectating AH_Bot` — no
manual client close needed.

### Phase 6 — Config & cleanup — ✅ Implemented

Config values had already accumulated across Phases 1-5 spread over four
different files (`spectator_config.js`, an inline env read in
`prism_locator.js`, an inline `PORT` constant in `index.js`, and
`world_launcher.js`'s hardcoded `DEFAULT_WORLD_CONFIG`). Consolidated into
one module rather than the originally-planned `config.json`/`.env` — env
vars were already the established pattern across every prior phase
(`AH_PTD_JSON_OVERRIDE_PATH`, `AH_ENABLE_LIVE_VIEWER`,
`WORKSHOP_DEMO_PRISM_COMMAND`, etc.), so a second parallel config format
would have meant two sources of truth for no real benefit.

- `server/config.js` (new) — every `WORKSHOP_DEMO_*`-overridable setting in
  one place with a header comment listing all of them: `DASHBOARD_PORT`,
  `WORLD_CONFIG` (folded in from `world_launcher.js`'s old
  `DEFAULT_WORLD_CONFIG`), `AGENT_NAME` (folded in from a hardcoded const in
  `orchestrator.js`), `PRISM_COMMAND_OVERRIDE`, `PRISM_INSTANCE`,
  `SPECTATOR_USERNAME`.
- `server/spectator_config.js` deleted — its two exports moved into
  `config.js`. `world_launcher.js`, `prism_locator.js`, `spectator.js`,
  `orchestrator.js`, and `index.js` all updated to import from `config.js`
  instead of their previous scattered/inline definitions.
- `achievement_hunter/workshop_demo/README.md` (new) — quick-start (how to
  run it, one-time per-machine setup, where configuration lives) and a
  short troubleshooting section, so running the demo doesn't require
  reading all of this plan doc.
- Orchestrator teardown (fresh world/agent/checkpoint/spectator-watcher per
  run) was already fully built across Phases 1-5 — nothing left to do here,
  confirmed still intact through this refactor.

**Verified live, full pipeline, post-refactor:** ran the dashboard with no
env vars set at all (confirming every default in the new `config.js` is
correct) through a complete cycle — world boot, PTD load, objective
injection, spectator join, gamemode switch, `/spectate`, and the skin
(`Reloading player skin on player's client` appeared 3 times in the server
log, matching the same count seen in earlier verified runs) — then a clean
teardown with no lingering processes, checkpoint, or temp directories.

## Open risks to verify before the workshop

- ~~Exact Prism CLI flag behavior~~ — resolved: confirmed via
  `prismlauncher --help` on the actual presenter machine and verified with
  a real live spectator join (Phase 5). Also found `-o/--offline`, an
  auth-free join flag not in the original plan.
- ~~PTD → task-config coverage~~ — resolved: Phase 2's chat-injection
  mechanism doesn't use harness task-configs at all, so this risk no longer
  applies.
- ~~World spin-up time~~ — partially addressed, see "Post-launch fix — world
  boot speed" below. ~15-20% faster; the remainder would need a much bigger
  architectural change (see that section) that wasn't pursued.
- Mermaid rendering must be bundled locally, not loaded from a CDN, in case
  venue wifi is unreliable.
- ~~Stale Prism client not rejoining a new world~~ — resolved: `launchPrismSpectator()`
  now force-closes any existing client before every launch, verified live.

## Suggested build order

1. ✅ Phase 3 (env-var + JSON emission) — small, low-risk, testable headless
   without any world/client involved.
2. ✅ Phase 1 (world spin-up + host override) — validated against a manual
   run; confirmed the agent actually connects outside Docker.
3. ✅ Phase 2 (objective injection + PTD override) — validated end-to-end
   (no dashboard, no Prism yet) that a chosen PTD loads from disk and the
   agent starts on it via chat injection.
4. ✅ Phase 4, dashboard skeleton + selection view — click-to-launch flow
   validated end-to-end via the real HTTP API against Phases 1-3.
5. ✅ Phase 4, live view — polled `/api/live` through real mid-run and
   completed runs; elapsed ticks correctly, dimming/highlighting correct.
6. ✅ Phase 5 (Prism auto-join, including reconnect handling and the
   stale-client fix) — verified with real live spectator joins against
   this machine's actual Prism install.
7. ✅ Addendum (AH_Bot's custom skin) — new Fabric server template, verified
   live via server-console debug logging.
8. ✅ Phase 6 (config/cleanup) — consolidated into `server/config.js`,
   verified with a full run using every default (no env vars set).

**All phases complete.** The demo has been run live end-to-end multiple
times across every phase; nothing on the original plan remains open.

### Post-launch fix — "Back to selection" felt slow

Reported after the demo was otherwise done. Root cause:
`world_launcher.js`'s `stop()` routed through `evaluation_harness/lib/utils.js`'s
`stopServerProcess()` — sends a graceful `stop` console command and waits
**up to 60s** for the world to save before falling back to a kill (right
for the eval harness's real benchmark runs, where the world/logs are kept
as artifacts, but pointless here since the whole server directory is
deleted immediately after regardless). The frontend's "Back to selection"
handler also `await`ed the full `/api/stop` round-trip before switching
views at all, so the UI was blocked on that entire chain.

**Fix:** `world_launcher.js`'s `stop()` now uses `terminateProcessTree()`
(SIGTERM) plus a short 5s bounded wait instead of the graceful-shutdown
helper. `app.js`'s back button now switches views immediately and fires
`/api/stop` in the background — safe because `startRun()` already awaits
its own internal `stopRun()` before launching anything new, so there's no
correctness reason to block on a teardown that already happened (or is
still finishing) by the time the next run starts.

**Verified live:** timed `/api/stop` directly — **1.16s**, down from a
worst case of 75s+ under the old path.

**Unrelated discovery made while re-testing:** hit the checkpoint-hijacking
symptom from Phase 4 again, but from a stale objective that didn't match
the run just started. Root cause this time was an *orphaned* agent process
from earlier manual testing (a dashboard server process killed directly
without going through `/api/stop` first leaves its detached
world/agent children running, since `launchLoggedProcess()` spawns them
`detached: true` and killing the parent doesn't cascade to them) —
that leftover process kept periodically re-saving its own checkpoint,
resurrecting it after `clearCheckpoint()` ran for the new run.
`orchestrator.js`'s teardown already correctly tears down everything *it
knows about* via `handles`; this was purely a manual-testing hygiene issue
(killing the dashboard process directly instead of calling `/api/stop`),
not a bug in the orchestrator logic itself, so no code change was made for
it. Flagging in case it's worth a future hardening pass (e.g. detecting and
killing stray `node main.js` processes on startup) — not done now since
that pattern is broad enough to risk matching an unrelated process on the
presenter's machine, which felt like a decision worth surfacing rather than
making silently.

### Post-launch fix — orphan-process hardening

Implemented after the above was flagged. Rejected the broad
`pkill -f "node main.js"` approach for the reason already noted (risk of
matching an unrelated process on the presenter's machine — "node main.js"
is a common enough pattern that this isn't hypothetical). Used a
PID-tracking approach instead, which sidesteps that risk entirely by
construction: this app never searches for processes by name/pattern, only
ever kills PIDs it itself recorded.

- `server/orphan_guard.js` (new) — `recordRunPids({serverPid, agentPid})`
  writes the current run's PIDs to `achievement_hunter/workshop_demo/.run/pids.json`
  (independent of in-memory state, so it survives the dashboard process
  itself dying); `clearRunPids()` removes it on a clean teardown;
  `killOrphanedPidsFromPreviousSession()` reads it on dashboard startup and
  SIGTERMs each recorded PID's process group (matching
  `terminateProcessTree()`'s own convention, since these were all spawned
  `detached: true`).
- `orchestrator.js` — calls `killOrphanedPidsFromPreviousSession()` once at
  module load (dashboard boot, before any run can start), `recordRunPids()`
  right after the world's server process and the agent process each become
  known, and `clearRunPids()` alongside the rest of `stopRun()`'s teardown.

**Verified live, reproducing the exact original failure mode on purpose:**
started a run, confirmed `pids.json` was written with both PIDs, then
`kill -9`'d the dashboard process directly (simulating a crash — no
`/api/stop` call at all) and confirmed both the world and agent processes
were still running afterward, orphaned. Started a fresh dashboard process
and confirmed the log showed `[orphan_guard] Killed leftover process group
<pid>...`, both orphaned processes were gone, and `pids.json` was cleared.
A subsequent run's agent log showed the correct chat-injection path
(`"[SPL] Received objective from..."`), not a checkpoint resume — the
original symptom is gone.

**Minor leftover found during this test, cleaned up manually, not fixed in
code:** the orphaned world's temp server directory
(`tmp/workshop_demo_server_*`) isn't removed by the orphan-guard kill,
since only the PID was persisted, not the directory path — killing the
process doesn't trigger `world_launcher.js`'s own `stop()` (which is what
normally calls `safeRemoveTree()`). Cosmetic (leftover disk usage across
repeated crash-recovery cycles), not a correctness or demo-day risk, so
left as-is rather than expanding `pids.json` into a broader session-state
file for a low-stakes cleanup detail.

### Post-launch fix — world boot speed

Reported as "starting the new world takes a long time." Measured before
guessing at a fix: world boot alone (before the agent even connects) took
**12-14s**. Broke the server log down by timestamp to find where it went,
rather than assuming.

**Root cause:** every run copies the *entire* server template fresh into a
new temp directory — that's deliberate, it's how each run gets a clean
world. But `fabric-server-launch.jar` bundles its ~43 library jars and the
actual vanilla server jar *inside itself*, only unpacking them into
`libraries/`/`versions/` on what Fabric calls "first launch." Since the
checked-in template didn't already have those unpacked, **every run looked
like a first launch to Fabric**, and it redid that unpacking every time —
confirmed by diffing a live server's directory against the template
(51 library files present live vs. 8 in the template) and by the log
literally saying "Fabric is preparing JARs on first launch."

**Tested before applying:** copied the already-unpacked state (`.fabric/`,
`versions/`, the full `libraries/`, `fabric-server-launcher.properties`)
into a scratch copy of the template and re-measured in isolation — dropped
to ~10.8s. A ~15-20% win, not dramatic; the remainder is JVM cold start +
Fabric's Mixin subsystem processing all 42 mods (~3-4s) and actual
spawn-chunk generation (~3.5s), neither easily reducible without a bigger
architectural change (a kept-warm JVM/world reused across runs instead of
a fresh process each time) that wasn't pursued given the modest
remaining upside. Also tried JVM startup flags
(`-XX:TieredStopAtLevel=1 -Xshare:auto`) as a cheap complementary win — no
clear improvement in a quick test, not pursued further.

**Tradeoff surfaced before applying, not decided unilaterally:** baking in
the unpacked state roughly **doubles the checked-in template's size (62MB
→ 144MB)** for that ~2-4s. Asked; confirmed to proceed.

**Applied and verified on the real checked-in template** (not just the
scratch copy): isolated timing measured **10.7s**, consistent with the
scratch test. Ran a full pipeline test afterward to confirm nothing else
broke — PTD load, objective injection, spectator join, gamemode switch,
`/spectate`, and the skin (3 confirmations in the server log, matching
prior runs) all still worked, followed by a clean teardown.

### Post-launch change — restrict PTD selection to a curated set

Requested: only allow the 8 achievements in
`achievement_hunter/evaluation_harness/advancement_tester.json` minus
`oh_shiny` (golden apple) — 7 total, out of the 23 PTDs on disk.

Matched by each PTD's `objective` field against `advancement_tester.json`'s
`goal` text directly (not by filename pattern) — several PTDs have
near-duplicate objectives with different exact wording (e.g.
`cook_a_pork_chop.json` vs. `cook_a_porkchop.json`; only the former matches
`advancement_tester.json`'s exact phrasing), the same wording-sensitivity
trap documented earlier in this plan for `to_snake_case()` filename
derivation. Resolved mapping:

| `advancement_tester.json` key | PTD file |
|---|---|
| `acquire_hardware` | `smelt_an_iron_ingot_have_an_iron_ingot_in_the_inventory.json` |
| `hot_stuff` | `fill_a_bucket_with_lava_have_a_lava_bucket_in_the_inventory.json` |
| `diamonds` | `acquire_diamonds_have_a_diamond_in_the_inventory.json` |
| `moar_tools` | `construct_one_pickaxe_one_shovel_one_axe_and_one_hoe_with_the_same_material.json` |
| `pork_chop` | `cook_a_pork_chop.json` |
| `cover_me_in_diamonds` | `acquire_a_diamond_chestplate_have_a_diamond_chestplate_in_the_inventory.json` |
| `ice_bucket_challenge` | `obtain_a_block_of_obsidian_have_a_block_of_obsidian_in_the_inventory.json` |
| `oh_shiny` (excluded) | `craft_a_golden_apple_have_a_golden_apple_in_the_inventory.json` |

**`server/ptd_catalog.js`** — `listPtdFiles()` now filters against a
hardcoded `ALLOWED_PTD_FILES` list (the 7 above) instead of returning every
file in `docs/ptd_jsons/`. Hardcoded rather than derived automatically from
`advancement_tester.json` at runtime, since the goal-text matching above
isn't mechanical (required manual disambiguation between near-duplicates)
and this was a one-time curation decision, not something that should
silently re-resolve differently if `advancement_tester.json` changes later.
Since `orchestrator.js`'s `startRun()` already validates against
`listPtdFiles()`, this one change restricts both the dashboard's selection
cards and the backend's acceptance — not just a UI-layer hide.

**Verified live:** `/api/ptds` returns exactly the 7 expected files;
`/api/start` with the golden-apple filename returns
`{"error":"Unknown PTD: ..."}` instead of starting a run; a valid filename
from the list is still accepted normally.

### Post-launch feature — spectator window auto-positioned to the left half of the screen

Requested: have the Minecraft window always open positioned to the left
half of the screen. This required real investigation, not a quick config
flag — recorded in full since the mechanism is non-obvious and easy to
break by editing the wrong thing later.

**No mod-based path exists.** Checked Modrinth for a Fabric mod that lets a
client control its own window position (`window-control`, `splitscreen`,
`locked-window-size`, `borderless-windowed`, etc.) — none support Minecraft
1.21.6 specifically (they cluster around 1.21.1 or 1.21.7+), and installing
a mismatched-version build risks breaking the already-reliable client join.
Not pursued.

**OS-level window control requires Accessibility permission** — this is
mandatory on macOS for any app to move/resize another app's window via
System Events, and can only be granted through the System Settings GUI
(confirmed: `tccutil` only revokes, never grants; directly editing the TCC
database is blocked by System Integrity Protection on any modern macOS —
not attempted).

**Scoping the grant mattered.** The naive approach — grant Accessibility to
whatever runs the orchestrator (in this case VS Code, since that's what
hosts this session's terminal) — was rejected in favor of scoping the
grant to Prism Launcher specifically, a single-purpose app, rather than a
general-purpose editor with much broader capability if that permission
were ever misused.

**Getting the scoping to actually work took two real fixes, both found by
testing, not guessing:**

1. Granting Accessibility to Prism Launcher alone did nothing at first —
   `osascript` calls from a script triggered via Prism's `PreLaunchCommand`
   still failed with "assistive access not allowed." Root cause: this
   app's code launched Prism by `spawn()`-ing its binary directly, bypassing
   LaunchServices — and macOS's Accessibility check resolves permission
   against whichever app it considers "responsible" for a process tree,
   which stayed pinned to the spawning Node process (and therefore VS
   Code) rather than transferring to Prism. Switching to `open -n -a
   <bundle> --args ...` (which does go through LaunchServices) fixed it —
   confirmed live: identical script failed under raw `spawn()`, succeeded
   under `open -a`, with Accessibility granted only to Prism.
2. Testing the fix surfaced a second, unrelated bug: macOS "App
   Translocation" runs quarantined apps (anything not yet moved out of
   `~/Downloads`, matching this dev machine's actual Prism install location
   — see `SETUP.md`) from a randomized temp path, not their real location.
   `spectator.js`'s existing `killExistingClient()` matched against the
   *full resolved path*, which silently stopped matching once Prism ran
   translocated — meaning stale-client cleanup (the Phase 5 addendum fix)
   would have quietly broken the moment `open -a` was introduced. Fixed by
   matching on the bundle-relative suffix
   (`"Prism Launcher.app/Contents/MacOS/prismlauncher"`) instead of the
   full path, which holds regardless of where the OS actually runs the
   process from.

**What was built:**
- `scripts/position_window.sh` (new) — invoked via Prism's
  `PreLaunchCommand`. Backgrounds itself immediately (so it never blocks
  the actual game launch), polls for the game's window to appear (up to
  60s), then positions it to the left half of the *current* screen size —
  queried live via `tell application "Finder" to get bounds of window of
  desktop`, not hardcoded, so it adapts to whatever display is active.
  Logs its outcome to `.run/position_window.log` for verification (used
  during testing; harmless to leave enabled).
- `server/spectator.js` — `launchPrismSpectator()` now launches via
  `open -n -a <bundle> --args -l ... -s ... -o ... --show-window` instead
  of spawning the binary directly; added `resolveAppBundlePath()` to derive
  the bundle path `open -a` needs from `resolvePrismCommand()`'s binary
  path. `killExistingClient()` updated to the translocation-safe suffix
  pattern described above.
- **One-time manual setup, per machine** (documented in `SETUP.md`):
  grant Accessibility permission to Prism Launcher (System Settings ->
  Privacy & Security -> Accessibility), and set the Prism instance's
  `PreLaunchCommand` to the absolute path of `position_window.sh` with
  `OverrideCommands=true` in `instance.cfg`.

**Verified live, full integrated flow, twice** (window position confirmed
visually by the user both times, since I can't see the screen myself): ran
a complete demo through the real dashboard (not just the isolated
`open -a` test used to diagnose the mechanism) — world boot, PTD load,
objective injection, spectator join, gamemode switch, `/spectate`, the
skin (3 confirmations, unaffected by the launch-mechanism change), window
positioned to the left half, and clean teardown. `position_window.log`
showed `positioned OK, screenWidth=1728 screenHeight=1117` matching the
actual display.

### Post-launch change — order the 7 curated PTDs simplest to most complex

`ptd_catalog.js`'s `listPtdFiles()` alphabetized the curated list after
filtering. Requested: order by complexity instead. Measured objectively
per PTD (vertex count, edge count, longest dependency-chain depth via a
simple topological DFS) rather than guessing from achievement names —
`construct_..._same_material.json` (8 vertices) through
`obtain_a_block_of_obsidian_...json` (16 vertices) — sorted by vertex count
primarily, edge count as tiebreak for the two PTDs tied at 12 vertices.
The resulting order also matches sensible real-world Minecraft progression
difficulty (tools → food → iron → lava/diamonds → diamond armor →
obsidian), which was a useful sanity check that the metric wasn't
producing a nonsensical ranking.

`ALLOWED_PTD_FILES` reordered to this sequence (full vertex/edge/depth
table in the code comment for future reference); `listPtdFiles()`'s
trailing `.sort()` removed so the curated order is preserved rather than
re-alphabetized. **Verified live:** `/api/ptds` returns the 7 files in
exactly this order; confirmed the frontend does no independent sorting of
its own, so the selection cards render in the same order.

### Post-launch UI iteration — layout, caching, graph direction, panel removal

A short run of quick UI requests, each verified rather than assumed:

- **Selection cards top-down, not left-to-right:** `#ptd-grid` changed from
  `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))` to a single
  `1fr` column (max-width 900px, centered). First report of "still left to
  right" was the browser showing a cached stylesheet — fixed by adding
  `Cache-Control: no-store` to the dashboard's own static file serving
  (`server/index.js`; the large unchanging mermaid vendor bundle keeps
  normal caching). **Second** report of "still left to right" after that
  fix turned out to be a real, different bug: each PTD's *mermaid graph
  itself* was rendered `graph LR` (left-to-right node flow) regardless of
  card layout. Fixed in `graph_utils.js`'s `graph_to_mermaid()` by adding
  an optional `direction` parameter (default `'LR'`, so
  `rollout_logger.js`'s existing markdown-viewer callers are unaffected —
  verified directly, calling with no second argument still produces `graph
  LR`), with the workshop demo's two call sites passing `'TD'`.
- **Removed "World live at host:port" and "Spectator connected — watching
  AH_Bot" status text** — `app.js`. Kept the other spectator status
  messages (launching/timeout/skipped/error) since those remain useful for
  troubleshooting; only the "everything's fine" success text was removed
  as redundant once the live dashboard already shows the run progressing.
- **Removed the "Current task"/"Current action" panels** from the live
  view — `index.html`'s second `.live-row`, `app.js`'s corresponding
  render logic and the now-dead `escapeHtml()` helper, the now-dead
  `.task-line`/`.action-line`/`.muted` CSS rules, and the now-unused
  `task`/`action` fields `server/index.js`'s `/api/live` computed for them
  (kept `task_state`-derived `currentNodeId`, since that still feeds the
  graph's current-node highlight, unrelated to what was asked to be
  removed).

### Post-launch feature — SCSG/candidate node coloring + legend

Requested: distinguish SCSG-remaining nodes and next-task-selector
candidate nodes with their own colors on the live graph (previously only
current-node=blue and done=dimmed-gray existed), plus a legend so a
workshop participant can read the graph without narration.

**Data source, verified against `rollout_logger.js` before wiring anything
up:** `live_state.scsg_result.final.vertices` (already used for the
existing "done" dimming) and `live_state.candidates` (an array of
`compact_candidate()` objects with `.id`, previously unused by the
dashboard) are both already present in the live JSON — no changes needed
upstream, just consuming data that was already there.

**Color/precedence design** (`server/index.js`'s `NODE_COLOR` map, low to
high — later `style` lines win ties in mermaid): goal (green, from
`graph_to_mermaid()`'s existing sink styling) < remaining (new, amber
`#FF9800`) < candidate (new, purple `#9C27B0`) < current (blue, existing) <
done (gray, existing — done is a `style` line appended for any node no
longer in the SCSG's remaining set, so it doesn't compete with
remaining/candidate for the same node by construction, only with goal).
Sink nodes are deliberately excluded from the remaining/candidate overrides
so the target node stays visually anchored (green) while still pending,
rather than blending in with everything else labeled "remaining."

**Legend** — `index.html`, a static row of colored swatches + labels
(Goal/Remaining/Candidate/Current/Done) placed above the graph in
`.graph-panel`. Colors are hand-kept in sync with `NODE_COLOR` and
`graph_to_mermaid()`'s sink color via a comment in each file cross-
referencing the other, since there's no shared constant between the
Node-side color map and the static HTML — worth consolidating if this
grows further.

**Verified live against a real run, not synthetic data:** polled
`/api/live` through an actual "cook a porkchop" run and confirmed the
exact expected mermaid output — e.g. `porkchop` and `crafting_table` each
had *two* `style` lines (`remaining` amber followed by `candidate`
purple), with purple correctly winning per mermaid's last-line-wins
behavior; `stick` was current (blue); `any_plank`/`any_log` were done
(gray); the sink stayed green throughout since it was still pending.
Watched the counts shift across several polls as the run progressed
(remaining 7→5, done 0→2), confirming the coloring updates live, not just
once.

### Post-launch fix — Ctrl+C didn't actually stop the demo

Asked: "why doesn't control c kill the server?" Root cause: the world and
agent child processes `orchestrator.js` spawns are launched `detached:
true` (deliberately — so `stopRun()` can kill each one's entire process
group independently via `terminateProcessTree()`'s `process.kill(-pid,
...)`, without affecting siblings). A detached child gets its own process
group, separate from the terminal's — so Ctrl+C's SIGINT, which the
terminal only delivers to its *foreground* process group, never reaches
them. It only reached the dashboard process itself, which had no signal
handler at all and so just died via Node's default behavior, leaving
Minecraft and the agent running orphaned. The exact same failure mode
`orphan_guard.js` (Phase 6 hardening) cleans up on the *next* dashboard
startup — but nothing previously stopped it from happening in the first
place, and Ctrl+C is the most natural way a presenter would actually try
to stop the demo.

**Fix:** `server/index.js` now registers `SIGINT`/`SIGTERM` handlers that
call `orchestrator.stopRun()` (the same full teardown `/api/stop` uses —
world, agent, spectator watcher, checkpoint) before exiting, guarded
against double-invocation if both signals somehow arrive.

**Verified live:** started a real run, confirmed via `ps` that the
Minecraft server and agent processes were actually running, sent `SIGINT`
directly to the dashboard process (exactly what Ctrl+C sends), and
confirmed both the "tearing down" log line and `"[SPL] Checkpoint
cleared."` appeared, the dashboard process itself exited, and — critically
— the Minecraft server and agent processes were both actually gone
afterward, not just the dashboard.

### Post-launch fix — candidate coloring silently erased other state

Reported: "not obvious that the current action is a candidate, and not
obvious when the goals are candidates." Root cause was a real design flaw
in the original coloring scheme (the SCSG/candidate-coloring feature two
sessions back): candidate was its own solid fill color (`#9C27B0`,
purple), applied as an independent `style` line appended after
goal/remaining/current — and mermaid's `style` directive fully *replaces*
a node's style on repeat, it doesn't merge. So a node that was both
"current" and "candidate" just showed plain blue (current's line came
last), and the old code explicitly *excluded* sinks from ever getting the
candidate color at all (`if (... || sinks.has(id)) continue;`) — both
silently dropping information the whole feature was supposed to surface.

**Fix:** restructured to compute one merged style per node instead of
independent per-category lines. `STATE_COLOR` (renamed from `NODE_COLOR`)
still governs fill/text/border for the four mutually-exclusive states
(goal/remaining/current/done — a node is in exactly one). "Candidate" is
no longer a fifth fill color at all — it's a `CANDIDATE_STROKE` overlay
(thick white ring, `stroke-width:4px`) applied on top of *whichever* fill
already applies, independent of it. So "goal AND candidate" now renders as
green fill + white ring, "current AND candidate" as blue fill + white
ring, instead of one property erasing the other. The legend's candidate
swatch changed from a solid purple square to a neutral-fill square with a
white ring, matching the "it's an overlay, not a color" reality.

**Verified live against a real run:** polled `/api/live` through a full
"cook a porkchop" run and confirmed the exact scenario that was broken —
multiple nodes (`wooden_pickaxe`, `cobblestone`, `furnace`, and eventually
`cooked_porkchop` itself, the actual goal node) each appeared with
`fill:#2196F3` (current/blue) *and* `stroke:#FFFFFF,stroke-width:4px`
(candidate ring) simultaneously at different points in the run, where the
old code would have shown plain blue with the candidate information
silently lost. `porkchop` similarly showed amber fill + white ring
(remaining + candidate) consistently across several polls.

### Post-launch fix — elapsed display only moved when other panels updated

Root cause: the poll cycle already ran every 1s, but `renderLive()` just
copied whatever `live.elapsed` string the *backend* returned — and the
backend only re-renders that string when an actual pipeline event fires
(`ptd()`/`task()`/`am()`/etc. in `rollout_logger.js`), not on a timer. A
single action (a long search, a slow collect) can run for well more than a
second between events, so the displayed elapsed value would visibly freeze
for stretches, then jump.

**Fix, entirely client-side, zero new network requests** (the explicit
constraint — polling more often to chase this was rejected as the wrong
direction): `app.js` now computes the displayed elapsed time from
`Date.now() - clockAnchorMs` on its own dedicated `setInterval(...,
1000)`, independent of the poll cycle. `formatElapsedMs()`/
`parseElapsedMs()` mirror `rollout_logger.js`'s `format_elapsed()`/
`pad2()` exactly (verified with a round-trip test:
`formatElapsedMs(parseElapsedMs(x)) === x` for several values spanning
seconds/minutes/hours) so the two "clocks" never visibly disagree. Every
time a fresh `live.elapsed` *does* arrive from a poll, `clockAnchorMs` is
re-synced to it — self-correcting any drift rather than accumulating it —
and the local ticking stops the moment `live.status` isn't `'running'`
(freezing on the last known value, matching the backend's own
freeze-on-complete behavior instead of continuing to count up past it).
Reset on both `startRun()` (new run, stale anchor from the previous one
shouldn't carry over even for a frame) and the back-button handler.

Verified the parse/format math directly (round-trip test above) and the
full pipeline end-to-end for regressions; the actual smooth-ticking visual
effect needs eyes on a browser to fully confirm, which isn't available in
this environment — left for the user to check.

**Follow-up: reported "it doesn't work."** The parse/format logic and
element IDs were re-checked and found correct; no root cause was found or
confirmed (this environment has no browser to inspect the actual runtime
behavior or console, and the user didn't confirm the specifics — frozen
vs. still jumping vs. a console error — before deciding to drop it).
**Removed rather than debugged further**, at the user's call: the elapsed
clock display (`#live-elapsed`, `formatElapsedMs()`/`parseElapsedMs()`/
`tickClock()`/`stopClock()` and the clock state vars in `app.js`, the
`.elapsed-value` CSS rule, and the `elapsed` field `server/index.js`'s
`/api/live` no longer needs to compute or return). The status badge
(Running/Completed) in the same panel was kept — that was never part of
the complaint, only the numeric clock was. If revisited later, actually
inspecting the browser console/DevTools first (not available in this
session) would be the right starting point rather than re-guessing at
the implementation.

**Immediate follow-up: "get rid of the entire running component."** Removed
the whole panel that badge lived in, not just the clock. `index.html`'s
`.live-row`/`.elapsed-panel` wrapper is gone — the graph panel is now
`#live-dashboard`'s only, direct child (no longer needs the 72%/1fr
two-column split that existed to make room for the panel next to it).
`app.js`'s `liveStatusBadge` and its update logic removed. This also
surfaced that `/api/live`'s `objective`/`status`/`completion` fields had
*all* become dead — `objective` was always redundant with `/api/status`'s
own field (never actually consumed), and `status`/`completion` existed
specifically to feed the now-removed badge — so `server/index.js`'s
`/api/live` response was simplified down to just `{mermaid}`, the one
field still actually used. Verified live: full run through the real
pipeline, confirmed `/api/live` returns exactly `{mermaid}` and nothing
else broke.

### Post-launch change — hide the page header once a run starts

The `<header>` ("Achievement Hunter — pick an achievement") sat outside
both `#selection-view` and `#status-view`, so it stayed visible
regardless of which was showing. Gave it `id="page-header"` and toggled
`.hidden` on it alongside the existing selection/status view switches in
`app.js` (`startRun()` hides it, the back button restores it). Verified
by fetching the served page directly and confirming the id/JS wiring
matches.

### Post-launch feature — recovery visualization (failure/search replanner)

**Ask:** "if the agent goes into the failure or search replanner sections
of the structure that the visual shows what is happening instead of the
PTD... This is a large addition so can you take your time and think of
the best way to do this."

**Research.** Explored `src/pipeline/structured_loop/failure_replanner.js`
and `search_replanner.js`, and `rollout_logger.js`'s `live_state` shapes:

- `live_state.recovery = {task, attempts: [{attempt, diagnosis,
  planned_actions, results}]}` — failure replanner, keyed off a single
  failed task.
- `live_state.search_recovery = {task, target, attempts: [{attempt,
  summary, planned_actions, results, end_state}]}` — search replanner,
  keyed off a multi-target search sweep that exhausted (`target` is
  already a pre-joined display string, e.g. `"oak_log, birch_log"`, not
  an array).
- Both are set to `null` by `recovery_end()`/`search_recovery_end()` —
  the exact signal to revert to the graph view.
- `results[i]` fills in progressively as each planned action executes
  (a sparse array — later indices are `undefined` until their action
  runs), giving a natural pending/success/fail state machine per action.
- **Mutual exclusivity confirmed by tracing the actual call graph in
  `actions.js`**, not assumed from the naming: search recovery always
  runs to completion — including its own `search_recovery_end()` — before
  a failure recovery episode can ever begin. So at most one of
  `recovery`/`search_recovery` is ever non-null at a time; the frontend
  never needs to reconcile or prioritize between them.
- `MAX_RECOVERY_ATTEMPTS`/`MAX_SEARCH_REPLANNER_ATTEMPTS` = 10
  (`structured_loop/config.js`) — a recovery episode can run several
  attempts; on crash-resume `attempts[0].attempt` isn't guaranteed to
  start at 1, so attempt numbers/counts are read off the data, never
  assumed.

**Design decisions:**

- **Normalize server-side, render generically client-side.** `server/
  index.js` collapses whichever of the two subsystems is active into one
  shape — `{kind, label, context, attemptNumber, priorAttempts, note,
  actions: [{command, status, message}]}` — via `build_recovery_view()`.
  The frontend has no failure-vs-search branching logic at all beyond a
  CSS class keyed on `kind` for the accent color; the two subsystems'
  actual field-name differences (`diagnosis` vs. `summary`, `task` vs.
  `target`) are absorbed in one place instead of leaking into the UI
  layer.
- **Keep computing the mermaid graph even while recovery is active.**
  `/api/live` always includes `mermaid` regardless of `recovery`, so the
  moment recovery ends the graph is already current — reverting is an
  instant visibility toggle, not a render-then-wait.
- **Show only the current attempt, not full history.** `attempts.at(-1)`
  only. Earlier attempts already played out live in front of the
  audience; replaying them as scrollback in the panel would be clutter,
  not information. `priorAttempts` (a count) is still surfaced so it's
  clear this isn't necessarily attempt 1.
- **Distinct accent colors per kind, not just a label change.** Failure
  recovery reuses `--error` (red, already used for run errors elsewhere,
  so it doesn't need a new "this is bad" color). Search recovery gets
  purple (`#9C27B0`) — free to use since "candidate" state moved to a
  white-ring border overlay instead of a solid fill (see the candidate-
  coloring fix earlier in this doc), so no existing swatch collides with
  it. The two panel variants are visually distinguishable at a glance
  without reading the title text, which matters for a room watching a
  screen from a distance.
- **Safe DOM construction for the action list, not `innerHTML` string
  interpolation.** `note`/`command`/`message` originate from LLM
  output (diagnosis text, tool-call args, failure messages) — rendered
  via `createElement`/`textContent` in `renderRecovery()`, never
  concatenated into an HTML string.

**Implementation:**

- `server/index.js`: `format_recovery_command()` (mirrors
  `rollout_logger.js`'s private formatter — `{name, args} ->
  name(arg1, arg2)`), `format_task_context()`, and
  `build_recovery_view(raw)`, wired into `/api/live`'s response as a new
  `recovery` field alongside the existing `mermaid` field.
- `public/index.html`: added `#recovery-panel` (title, attempt count,
  context line, note, action list) as a sibling of the graph panel inside
  `#live-dashboard`; gave the graph panel `id="graph-panel"` so JS can
  toggle it.
- `public/app.js`: `renderRecovery(recovery)` builds the panel via DOM
  APIs; `renderLive(live)` now toggles `graphPanel`/`recoveryPanel`
  visibility based on whether `live.recovery` is present, in addition to
  its existing mermaid-diffing logic (unchanged — still only re-renders
  the graph when the mermaid source actually changes).
- `public/styles.css`: `.recovery-panel` (+ `--failure`/`--search`
  variants), header/title/attempt/context/note layout, and
  `.recovery-action` rows with `--pending`/`--success`/`--fail`
  modifiers (opacity for pending, green/red border for success/fail).

**Verification.** Actually triggering a real failure/search recovery
episode requires a genuine in-game failure, which isn't reliably
reproducible on demand. Followed the same approach used earlier in this
doc for `render_live_mermaid()`: ran the real dashboard server, wrote
synthetic data matching the verified real `live_state` schema directly to
`rollout_live/current_rollout.json`, and hit the real `/api/live`
endpoint with curl — exercising the actual production code path, not a
reimplementation. Confirmed via `node --check` (both files) plus:

- Failure recovery, attempt 2 with 1 prior attempt, one success + one
  pending action → `build_recovery_view()` produced exactly the expected
  `{kind: "failure", attemptNumber: 2, priorAttempts: 1, ...}` shape.
- Search recovery with a joined multi-target string and a failed action
  carrying a message → `context` and the failed action's `message` came
  through correctly.
- Both `recovery`/`search_recovery` null → `recovery: null` while
  `mermaid` stayed populated, confirming the graph is always ready for an
  instant revert.
- Fetched `/index.html`, `/app.js`, `/styles.css` from the running server
  and grepped for the new panel markup, `renderRecovery`, and the
  `--search` accent class to confirm nothing was stale/cached.

Synthetic data and the test server were removed/killed afterward
(`rollout_live/current_rollout*` is gitignored and doesn't affect git
status either way). The actual panel styling/switching in a real browser
during a real recovery episode hasn't been visually confirmed — no
browser tool is available in this environment — left for the user to
check the next time a run genuinely hits a failure or search recovery.

### Post-launch feature — night vision on launch

**Ask:** give the client(s) night vision on launch, via `/effect give
<client> minecraft:night_vision infinite` or simpler, apply it to
everyone on the server.

Went with the "everyone" option, per the user's own suggestion — a
single `effect give @a minecraft:night_vision infinite 0 true` covers
both AH_Bot and the spectator without tracking which specific username(s)
are online, and matches how `gamerule spawnRadius 0` is already applied
world-wide in `world_launcher.js` rather than per-player. `0` is the
amplifier (plain Night Vision, not Night Vision II); `true` hides the
swirling particle ring so it doesn't clutter the spectator footage.

**Why a single call at world-launch time isn't enough:** effects apply
only to entities that exist at the moment the command runs, and neither
AH_Bot nor the spectator has logged in yet when the world first comes up
— an `@a` call then would silently match zero players. Effects also
reset on a fresh login (a reconnect is a new entity), so this needs to
re-fire on every login, not just once.

**Implementation** (`server/orchestrator.js`): `applyNightVision(world)`
wraps the console command in try/catch (best-effort — matches the
existing rationale for the spectator flow's own error handling; this is
a nice-to-have, not something that should fail the whole run). Called
from two places, covering both clients independently since either can be
missing or can reconnect independently of the other:

- A new `watchBotLogins` watcher, set up unconditionally in
  `runInBackground` (not nested inside `runSpectatorFlow`, which only
  runs at all if Prism is configured) — fires on AH_Bot's initial login
  and every reconnect. This is the one that matters even on a machine
  with no spectator client set up at all.
- Once in `runSpectatorFlow`, right after the existing `gamemode
  spectator` command succeeds — covers the spectator specifically, since
  Prism/spectator join is typically the slower of the two (per the Phase
  5 timing notes above), so it usually joins *after* the bot's watcher
  already fired and wouldn't otherwise get it.

The new watcher's stop function is tracked as
`handles.stopNightVisionWatcher` and torn down in `stopRun()` alongside
the existing `stopSpectatorWatcher`, so it doesn't leak a running
interval across runs or on shutdown.

**Verification.** `node --check` on the modified file, then a live test:
launched a real managed world via `launchManagedWorld()` directly (no
mocking) and sent the exact command through the real
`sendServerConsoleCommand` path. Server log confirmed the command parsed
correctly — `No entity was found` (the expected vanilla response for
`@a` matching zero online players), not an "Unknown or incomplete
command" syntax error — confirming `infinite` as a duration keyword and
the full argument order are valid on this server's Minecraft version.
Actually confirming a joined client visually has night vision needs a
real client connecting, which wasn't done in this pass (no browser/game
client available here) — left for the user to confirm on the next real
run.

### Post-launch fix — AH_Bot occasionally spawns with the default skin

**Report:** "Sometimes AH_BOT has a gold skin instead of the robot skin
we want."

**Root cause.** The skin is set in `src/agent/agent.js`'s `login` handler
(this predates the workshop demo — it's the same code path for every
AH_Bot run, eval-harness or demo), as a single fire-and-forget
`/skin set URL classic <path>` chat command, sent once, with no
verification and no retry. FabricTailor (the server mod that makes
`/skin set` a real command — `server_templates/minecraft_1_21_6_fabric/
mods/fabrictailor-2.7.0.jar`) does its own fetch of the skin URL at that
moment. Confirmed live (see Verification below) that this fetch actually
goes through an external skin-lookup/proxy service with its own
documented rate limit and a "Mojang skin not found, trying via proxy"
fallback chain — i.e. a real external dependency with real failure
modes, sitting behind a command that's only ever sent once. A single
transient hiccup in that chain has nothing to retry it, so the client
silently falls back to its offline-mode default skin instead — read by
the reporter as "gold" (an artifact of the offline-mode UUID's default
Alex/Steve variant, not an actual FabricTailor default-skin config —
`fabrictailor.json`'s `default_skin.apply_to_all` is `false`, ruling out
a config-driven override).

**Fix** (`src/agent/agent.js`, `login` handler — wrapped in `// Start of
AH code` / `// End of AH code` markers per this repo's convention for
edits outside `achievement_hunter/`, since this block had none
previously): send the same `/skin set`/`/skin clear` command up to 3
times, 2 seconds apart, via `setTimeout`, instead of once. This is safe
to do blindly — no confirmation channel is read — because repeats are
idempotent and `fabrictailor.json`'s `skin_change_timer` is `-1` (no
mod-side cooldown) in this project's config.

**Verification.** Rather than guessing, ran the actual mechanism live:
launched a real managed world via `launchManagedWorld()`, connected a
raw `mineflayer` bot directly (bypassing the full agent/LLM stack, which
needs API keys — this isolates just the skin-setting behavior), and sent
the exact `/skin set URL classic <profile.json path>` command 3 times, 2s
apart, exactly like the new retry loop does. Server log confirmed all
three were accepted and independently completed the full fetch chain —
`Fetching skin from URL` → `Parsing skin reply` (each including the
`rateLimit` object: `used` climbed 1→2 across the 3 calls, `remaining`
9→8 out of a 10/minute cap — nowhere near tripping it for one run) →
`Setting skin for player` → `Reloading player skin on player's client`,
three times over, no rejection or rate-limit block on the repeats. This
both validates the retry-is-safe assumption and directly confirms the
external-fetch/rate-limited-proxy chain that's the actual root cause.
Also syntax-checked with `node --check`. Not verified: actually
reproducing the original transient-failure moment itself (not
reliably triggerable on demand) or a client visually confirming the
robot skin — left for the user to notice this stops recurring in
practice.

### Post-launch fix — stale live view flashes on a new run

**Report:** "When you choose an achievement it initially shows the last
live view from the previous rollout before loading the new achievement
PTD, can we have it so it shows nothing until the PTD loads?"

**Root cause.** `server/index.js`'s `GET /api/live` reads
`achievement_hunter/rollout_live/current_rollout.json` unconditionally
whenever it exists. That file is written by `rollout_logger.js`'s
`render_live()` — but `render_live()` isn't called for the first time in
a fresh agent process until its PTD stage completes, which is *after*
world boot, agent connect, and objective injection (several seconds).
Nothing deleted the file when a new run started, so during that window
`/api/live` kept serving the *previous* run's graph — same category of
bug as the checkpoint-hijacking issue from Phase 4 (stale on-disk state
from a prior run silently affecting the next one), just a different
file.

**Fix** (`server/orchestrator.js`): added `LIVE_JSON_PATH` (mirrors
`index.js`'s constant of the same name/value) and delete it in
`stopRun()` right next to the existing `clearCheckpoint()` call —
`stopRun()` already runs unconditionally at the top of every
`startRun()`, before the new world launches, so this guarantees the
stale file is gone before the client's poll loop can ever see it. Once
deleted, `/api/live` naturally falls back to its existing `null`
response (the `!existsSync` branch, unchanged), and `app.js`'s
`pollLive()` already only calls `renderLive()` when the response is
truthy — so no frontend change was needed at all; the dashboard simply
shows nothing (graph panel stays hidden, as `startRun()` already sets it
on click) until the new agent's first `render_live()` call.

**Verification.** Live end-to-end against the real server (not
mocked): wrote a fake `current_rollout.json`, confirmed `/api/live`
served it (reproducing the bug), called the real `POST /api/stop` (same
`stopRun()` code path `startRun()` uses), confirmed the file was gone
from disk and `/api/live` now returns literal `null`. Also unit-tested
`stopRun()` directly via dynamic import before the full HTTP pass. (One
false start: an initial HTTP test run appeared to show the file
persisting — turned out to be a stale dashboard server process left
running on port 4173 from earlier in this session, still serving the
pre-fix code; the new test server crashed on `EADDRINUSE` and the curl
calls silently hit the old process. Killed it and reran against a clean
process, which passed.) `node --check` on the modified file.
