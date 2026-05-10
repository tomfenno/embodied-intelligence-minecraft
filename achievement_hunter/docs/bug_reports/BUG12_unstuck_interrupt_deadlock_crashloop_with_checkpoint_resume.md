# BUG 12 — Unstuck-Mode Interrupt Deadlock + Checkpoint Resume Causes Infinite Crash-Restart Loop

**Severity:** Critical (silent infinite restart loop; rollout never terminates, never
fails over to `failure_replanner`, no progress and no diagnosable failure trace)
**Status:** Reported — fix proposed, not yet applied
**Branch:** `hard-code-nts-am`
**Related files:**
- `src/agent/action_manager.js:26–37` (`stop()` busy-loop + `cleanKill` timeout)
- `src/agent/agent.js:233–239` (`requestInterrupt` calls `bot.collectBlock.cancelTask()`)
- `node_modules/mineflayer-collectblock/lib/CollectBlock.js:268–280` (`cancelTask` adds listeners)
- `achievement_hunter/src/pipeline/checkpoint.js` (resume policy)
- `achievement_hunter/src/pipeline/structured_loop/loop.js:46` (checkpoint write timing)

---

## Symptom

The bot is collecting `iron_ore` near `(-898, 49, -3006)` (an underground location, likely
in/adjacent to water given the y=48 stratum and the >5-block vertical moveAway response).
Each achievement-agent process invocation follows the same shape and ends the same way:

```
[SPL] Action (attempt 1/5): !collectBlocks("iron_ore", 1)
parsed command: { commandName: '!collectBlocks', args: [ 'iron_ore', 1 ] }
executing code...
executing code...
action "mode:unstuck" trying to interrupt current action "action:collectBlocks"
waiting for code to finish executing...
waiting for code to finish executing...
...  (~33 repetitions = ~10 seconds)
(node:33) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
          11 error listeners added to [EventEmitter]. ...
(node:33) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
          11 collectBlock_finished listeners added to [EventEmitter]. ...
waiting for code to finish executing...
...
Saved memory to: ./bots/AH_Bot/memory.json
Agent AH_Bot disconnected
Achievement agent process exited with code 1 and signal null
Restarting achievement agent...
```

Then a fresh process boots, prints
`[SPL] Checkpoint found — resuming: test 2 (saved at 2026-04-28T18:55:35.815Z)`,
selects the **same** next task
(`{"target_item":"raw_iron","qty":1,"action_type":"collect", ...}`), issues the **same**
command, hits the **same** unstuck trigger, and crashes the **same** way. The supervisor
restarts again. This repeats indefinitely with no rollout progress, no failure trace ever
written by `failure_replanner`, and no `max_outer_retries` exit (since each crash kills
the process before the SPL can count it as a failure).

In a later attempt the same dynamic plays out with `!searchForBlock("iron_ore", 32)` after
unstuck partially succeeds (it moves the bot from y=49 → y=55) — the next action restarts,
unstuck fires again because the new spot is also stuck, and the same crash sequence runs.

---

## Root Cause

Three independently-imperfect mechanisms compose into an infinite restart loop:

### 1. `ActionManager.stop()` cannot evict a non-yielding action and falls back to `cleanKill`

`action_manager.js:26–37`:

```js
async stop() {
    if (!this.executing) return;
    const timeout = setTimeout(() => {
        this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
    }, 10000);
    while (this.executing) {
        this.agent.requestInterrupt();
        console.log('waiting for code to finish executing...');
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    clearTimeout(timeout);
}
```

When `mode:unstuck` fires while `action:collectBlocks` (or `searchForBlock`) is still
executing, unstuck calls `agent.actions.runAction(...)` → `_executeAction(...)` →
`await this.stop()`. `stop()` polls `executing` every 300 ms, calling `requestInterrupt()`
each tick. `requestInterrupt()` does:

```js
requestInterrupt() {
    this.bot.interrupt_code = true;
    this.bot.stopDigging();
    this.bot.collectBlock.cancelTask();
    this.bot.pathfinder.stop();
    this.bot.pvp.stop();
}
```

If the running command is stuck in a state where none of those signals causes the
top-level promise to resolve quickly (e.g., the collectblock plugin is between
`pathfinder.goto` retries, or the underlying `mineBlock` is mid-await on a packet that
never arrives because the bot is in water/sand and physics is fighting it), `executing`
stays true. After ~10 seconds the watchdog calls
`agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.')` →
`process.exit(1)`.

This is by design — it prevents a permanently-wedged action from blocking the agent
forever. The problem is what happens *after* the kill.

### 2. `requestInterrupt` leaks `once`-listeners on `bot.collectBlock` for every poll tick

`bot.collectBlock.cancelTask()`
(`node_modules/mineflayer-collectblock/lib/CollectBlock.js:268–280`):

```js
cancelTask(cb) {
  return __awaiter(this, void 0, void 0, function*() {
    if (this.targets.empty) { ... return yield Promise.resolve(); }
    this.bot.pathfinder.stop();
    if (cb != null) { this.bot.once('collectBlock_finished', cb); }
    yield (0, events_1.once)(this.bot, 'collectBlock_finished');
  });
}
```

`requestInterrupt` invokes `cancelTask()` **without awaiting it** — every call returns a
pending promise that has subscribed a fresh `once('collectBlock_finished', ...)` listener
plus an internal `error` listener (Node's `events.once` adds both, removing only the one
that fires first). Because the underlying collection never finishes (the action is
wedged), no listener ever fires; they accumulate.

`stop()` ticks every 300 ms × ~33 ticks before the 10 s timeout. Two listeners per tick
breach Node's default `MaxListeners=10` warning at ~tick 6, which exactly matches the
observed warnings (`11 error listeners added`, `11 collectBlock_finished listeners added`).

This isn't fatal in 10 seconds, but it's evidence that the interrupt path is wrong: a
side-effecting async API is being used as if it were a fire-and-forget signal, and the
process is shut down before GC can reclaim the leaked subscriptions.

### 3. Checkpoint resume is deterministic — no awareness that the previous run crashed here

`achievement_hunter/src/pipeline/structured_loop/loop.js:46`:

```js
save_checkpoint(task_name, graph);  // written once, immediately after PTD success
```

`checkpoint.json` stores `{ objective, graph, saved_at }`. It does **not** record:
- which task was last attempted,
- how many crashes have occurred since the last successful task,
- whether the previous process exited cleanly or via `cleanKill`,
- the bot's location at last attempt.

On restart the SPL recomputes SCSG against the (preserved server-side) post-disconnect
inventory, lands on the same `select_next_task` result, and emits the same command from
the same physical position. With unstuck firing on the same physical condition, the crash
sequence is bit-for-bit identical.

`Achievement agent process exited with code 1 and signal null / Restarting achievement
agent...` indicates a watchdog (Docker auto-restart or a parent supervisor) brings the
process back up. That watchdog has no knowledge of progress either; from its perspective
this is just `exit 1 → restart`.

### Why this composes into an infinite loop and not just "one bad task"

The SPL was designed so that an action that fails repeatedly within one process gets
escalated:
1. `executeCommandWithModeRecovery` retries past mode interrupts up to `MAX_MODE_INTERRUPTS=10`.
2. `execute_task_action` retries the task up to 5 attempts.
3. Persistent failures hand off to `failure_replanner` for diagnosis.
4. After `max_outer_retries=10` consecutive top-level failures, the loop aborts.

**Every one of those guards lives in process memory.** Because the process is killed *during*
the very first `executeCommand` call of the very first attempt of the very first task post-
checkpoint, none of those counters ever increments. After restart they are all zero again.
The retry budgets reset every time, so the loop cannot self-terminate.

The 10 s `cleanKill` watchdog protects against a single hung command but, paired with a
checkpoint that resumes deterministically and a watchdog that restarts unconditionally,
turns a single deterministic-deadlock bug into permanent rollout dead-air.

---

## Fix

### Framing: `cleanKill` is the smoke alarm, not the disease

The disease is **"actions don't yield to cancellation."** `bot.interrupt_code` is a flag,
`bot.collectBlock.cancelTask()` is an async API used as if it were a fire-and-forget
signal, and `bot.pathfinder.stop()` is a best-effort plugin nudge. None of these is a
cancellation primitive; collectively they are a side-channel that the action layer hopes
will unwedge whatever it is awaiting. When that hope fails, `ActionManager.stop()`'s 10 s
`setTimeout` fires `cleanKill` and the whole process disappears.

Every fix that lives *above* the action layer (checkpoint crash counter, supervisor
hardening, smarter watchdog) is also a bandaid on the same wound. The robust fix is to
change the contract of an action: an action either makes progress, returns, or rejects
within bounded time, by construction. Once that holds, `stop()` returns in milliseconds
and `cleanKill` becomes unreachable in practice.

### Primary fix — cooperative cancellation via `AbortSignal`

Replace `bot.interrupt_code` and the 300 ms poll loop with a single `AbortController`
owned by `ActionManager`, threaded as a `signal` argument into every skill. This is the
standard JS pattern; the loop in `stop()` and the listener-leak in `cancelTask` both
disappear as side effects.

#### a. `ActionManager` owns one `AbortController` per action

`src/agent/action_manager.js:_executeAction`:

```js
async _executeAction(actionLabel, actionFn, timeout = 10) {
    this.controller = new AbortController();
    const { signal } = this.controller;
    // ...
    this.currentActionPromise = actionFn(signal);   // skills now take a signal
    await this.currentActionPromise;
}

async stop() {
    if (!this.executing) return;
    this.controller.abort(new Error('superseded by new action'));
    // best-effort plugin nudges — hints, not the cancellation primitive
    this.bot.pathfinder.stop();
    this.bot.collectBlock.cancelTask();
    // bounded await of the action's own rejection
    await Promise.race([
        this.currentActionPromise.catch(() => {}),
        new Promise(r => setTimeout(r, 1000)),  // last-resort budget
    ]);
}
```

`stop()` no longer polls. It aborts the signal once, gives plugins a one-time nudge, and
awaits the action's own rejection. The 10 s `setTimeout` calling `cleanKill` is no longer
load-bearing — keep it as defense-in-depth at the same level as a synchronous infinite
loop, but normal cancellation never reaches it.

This also fixes the listener leak in (root-cause #2) without any change to `requestInterrupt`:
because `cancelTask()` is invoked once per `stop()` rather than every 300 ms, only one
`once('collectBlock_finished', ...)` listener is ever subscribed per cancellation.
`requestInterrupt` itself can be deleted — `signal.abort()` is the new primitive.

#### b. Make every long await abortable

Every skill takes a `signal` and threads it. For plugin calls that don't natively accept
a signal (`mineflayer-pathfinder`, `mineflayer-collectblock`), wrap them with a small
helper:

```js
function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject)
               .finally(() => signal.removeEventListener('abort', onAbort));
    });
}

// inside skills.goToNearestBlock, skills.collectBlock, ...
await abortable(bot.pathfinder.goto(goal), signal);
```

The underlying pathfinder may keep thinking briefly in the background after `abortable`
rejects, but combined with the `bot.pathfinder.stop()` nudge inside `ActionManager.stop()`
it settles within a tick or two. The action layer's promise rejects immediately, which is
what matters — the next action can start.

The principled-but-larger version is to patch `mineflayer-pathfinder` and
`mineflayer-collectblock` to accept signals natively (similar to the existing
`patches/mineflayer-tool+1.2.0.patch`). The wrapper version above gets ~80 % of the
benefit without forking the plugins; the patches can land later if "background thinking"
turns out to cause subtle state issues.

#### c. Progress watchdog inside long-running skills

Even with cooperative cancellation, an entirely new bug class — pathfinder oscillating
between two cells, action ticking forward by its own measure but the bot making no
externally-visible progress — would still appear as a hang to the SPL because no mode
fires to interrupt it. Defend against that at the action layer:

```js
// inside collectBlock's outer loop, and inside goToNearestBlock
const watchdog = startProgressWatchdog(bot, {
    stillFor: 8_000,   // ms with no position change AND no block broken
    signal,            // composes with the AbortController above
});
try {
    await abortable(bot.collectBlock.collect(target), watchdog.signal);
} finally {
    watchdog.stop();
}
```

`startProgressWatchdog` rejects with `ProgressTimeout` when the bot's xz-position has
moved <0.5 blocks **and** no `bot.diggingCompleted` has fired in `stillFor` ms. That
rejection propagates as a normal action failure → `executeCommandWithModeRecovery` →
`execute_task_action`'s retry counter → `failure_replanner`, which can diagnose
"inescapable position, relocate" and produce a meaningful recovery plan.

`unstuck`'s built-in 10 s self-kill (`modes.js:126`,
`agent.cleanKill("Got stuck and couldn't get unstuck")`) is the dual of this — it kills
when the *unstuck action itself* is wedged. (a) + (c) together give the *interrupted*
action the same escape valve.

### Secondary — last-resort safety net

Keep one supervisor-level guard so that a future bug at a layer the action contract can't
reach (e.g., synchronous infinite loop with no awaits, or a hard libuv hang) doesn't
reproduce the infinite restart loop documented above:

Persist a `unclean_exit_count` in `checkpoint.json`. Increment on every `cleanKill(_,
code=1)`. On startup, if the count exceeds a small threshold (e.g. 3), refuse to resume,
clear the checkpoint, and emit `log.complete('aborted: repeated unclean exits during
resume')`. This converts a hard-to-reach failure mode from "silent rollout dead-air" into
"clean rollout failure with a trace."

```js
// checkpoint.js
export function recordUncleanExit() {
  const data = loadCheckpoint() ?? {};
  data.unclean_exit_count = (data.unclean_exit_count ?? 0) + 1;
  data.last_unclean_exit_at = new Date().toISOString();
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// agent.js — in cleanKill, before process.exit
if (code !== 0) recordUncleanExit();
```

This was originally proposed as the load-bearing fix; with cooperative cancellation in
place it correctly drops to "defense in depth, almost never triggers."

### What happens to `cleanKill` after the fix

Three call sites today:
- `ActionManager.stop()` 10 s timeout — becomes unreachable in normal operation.
- `modes.js:unstuck` "Got stuck and couldn't get unstuck" — still appropriate; this is the
  unstuck action itself wedging, where there is no enclosing action to fail.
- `agent.js:466,476` (other guards) — unchanged.

`cleanKill` stays in the codebase as a true last resort for synchronous wedges. The
expectation after the fix is that no rollout should ever hit it via the `stop()` path.

### Sequencing

In order of impact-per-line-of-change:
1. **(a) `AbortController` in `ActionManager`** + bounded-await `stop()`. Single file
   change, no plugin patches. Eliminates the crash for this bug.
2. **(c) Progress watchdog in `skills.collectBlock` and `skills.goToNearestBlock`**.
   Two-file change. Converts the remaining wedge classes into clean task failures.
3. **(b) Thread `signal` through `skills.js`**. Larger refactor; can land
   incrementally per skill. Each call wrapped in `abortable()` is independent.
4. **Secondary `unclean_exit_count` guard.** One-file change in `checkpoint.js` plus a
   hook in `cleanKill`. Lands whenever convenient — it's defense-in-depth.

(1) and (2) alone would have turned the supplied rollout into a clean
`failure_replanner` invocation rather than an infinite restart loop.

---

## Evidence

From the supplied log, four consecutive process lifecycles, all on objective `test 2`:

| Process (pid hint) | Resume from checkpoint @ | Action attempted | Mode that interrupted | Listener warnings before kill | Outcome |
|---|---|---|---|---|---|
| node:33 | 18:54:46.466Z | `!collectBlocks("iron_ore", 3)` | unstuck | 11 error / 11 `collectBlock_finished` | exit 1 |
| node:45 | 18:55:35.815Z | `!collectBlocks("iron_ore", 1)` | unstuck | 11 / 11 | exit 1 |
| node:57 | 18:59:40.349Z | `!collectBlocks("iron_ore", 1)` | unstuck (recovered once via `executeCommandWithModeRecovery`'s waitForIdle), then refired | none reached | exit 1 |
| node:69 | 19:01:32.044Z | `!searchForBlock("iron_ore", 32)` (after `!search` mediation) | unstuck (after partial success: y=49→55) | none reached | exit 1 |
| node:81 | 19:02:09.853Z | `!search("iron_ore")` | … (log truncates here, but the pattern is established) | … | … |

Three observations support the diagnosis:

1. **`executing code...` printed twice in succession** before the unstuck-interrupt log
   line. The first print is `_executeAction` for the SPL command; the second is
   `_executeAction` for the unstuck mode's `moveAway`. This is exactly the call sequence
   `mode:unstuck → execute() → runAction → _executeAction → stop()` and confirms unstuck
   is the interrupter.
2. **Listener warnings cap at 11** for both `error` and `collectBlock_finished`,
   indicating a fixed leak rate per `stop()` poll tick (consistent with one
   `events.once` call per tick — both Node and the plugin-installed listener — adding 2
   listeners every 300 ms × ~6 ticks before threshold, then 1 more per tick until kill).
3. **Identical `Next task` JSON across restarts** with identical `Action (attempt 1/5):`
   command — `consecutive_failures` and `attempt` counters are clearly resetting per
   process, demonstrating the SPL's in-memory retry budgets are not surviving the kill.

## Relation to Other Bugs

- **BUG 5** (lava_death_pathfinder_escape_failure): same family — the bot ends up in an
  environmental trap that pathfinder/unstuck cannot resolve. BUG 5 was about death; this
  is about a wedge that doesn't kill the bot but kills the agent process.
- **BUG 6** (drowning_during_llm_call): related — also an environmental trap that becomes
  catastrophic because the surrounding process layer doesn't recover. Both motivate (3)
  above (a progress watchdog inside the action layer).
- **BUG 9** (goalchanged_crashes_spl_at_recovery_boundary): adjacent failure mode where
  an exception escapes the SPL and crashes the process. BUG 12's crash is a `cleanKill`
  rather than an uncaught throw, but the post-restart behaviour is identical because the
  checkpoint resume path treats both the same (resume blindly).
- **BUG 10** (stone_pickaxe_break_oom_collectblock): different root cause (infinite async
  recursion in the tool plugin) but same outcome shape (process exits during
  `collectBlocks`, restart resumes the same task). BUG 10 was fixed by patching the
  plugin and handling the cleanly-thrown error; BUG 12 needs the *generic* infinite-
  restart guard (fix 1 above) so future BUG-10-class issues fail cleanly even if their
  specific root cause hasn't been patched yet.
