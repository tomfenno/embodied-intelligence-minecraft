import {appendFile, writeFile} from 'fs/promises';

// Per-path write queue. Replaces blocking `writeFileSync` / `appendFileSync`
// calls on the agent's hot path: callers enqueue and return immediately; the
// actual disk write happens on the microtask queue.
//
// Two modes per path:
//
//   - `write(path, content)` (overwrite): while a write to a given path is
//     in flight, additional `write()` calls for that path overwrite the
//     pending content rather than queueing. This naturally coalesces
//     bursts (10 dashboard re-renders during a single `record_stage` → 1
//     disk write of the final state).
//
//   - `append(path, chunk)`: chunks are buffered in order; when the write
//     fires, all buffered chunks are concatenated and written in one
//     `appendFile` call. A burst of N appends collapses to one file open,
//     not N. Order is preserved.
//
// A given path uses one mode for its lifetime — mixing append and write on
// the same path is not supported.
//
// `content` to `write()` may be a string or a `() => string` thunk. Thunks
// are evaluated lazily, just before the write, so coalesced calls skip the
// `JSON.stringify` work for all but the latest value — which matters for
// `rollout_trace.json`, where the structure can grow to multi-MB.
//
// An `await writeFile()`/`appendFile()` call has no timeout of its own, so
// a slow disk write (seen live: a workshop demo run where the machine was
// also running two Minecraft JVMs at once) can silently stall — and
// because `write()`/`append()` above only start a new drain when
// `state.in_flight` is falsy, one stuck write permanently blocks every
// future write to that same path for the rest of the process, with no
// error and no way to notice short of the file simply never updating
// again.
//
// `_watch_for_stall` (append mode) only logs — it doesn't touch the write
// itself (fs.promises gives no way to cancel or inspect an in-flight call),
// so it can't unstick anything, but appending twice if a "stuck" append
// actually lands late would duplicate a line, so append mode never gives
// up on one.
//
// `_write_with_timeout` (overwrite mode) can safely do better: a 'w'-mode
// write fully replaces file content, so whichever write reaches disk last
// always wins — an abandoned write finishing late just gets clobbered by a
// newer one, never corrupts anything. So past WRITE_ABANDON_MS it stops
// waiting on the dead promise and lets `_drain_write`'s loop retry with
// the latest pending content on a fresh `writeFile()` call, self-healing
// instead of bricking the path for the rest of the run.
const STALL_WARN_MS = 5000;
const WRITE_ABANDON_MS = 15000;

async function _watch_for_stall(file_path, op_label, promise) {
  const started = Date.now();
  let warned = false;
  const timer = setTimeout(() => {
    warned = true;
    console.warn(
        `[io_queue] ${op_label} to ${file_path} still pending after ${
            STALL_WARN_MS}ms`);
  }, STALL_WARN_MS);

  try {
    await promise;
  } finally {
    clearTimeout(timer);
    if (warned) {
      console.warn(
          `[io_queue] ${op_label} to ${file_path} finally completed after ${
              Date.now() - started}ms`);
    }
  }
}

// Never throws — success/failure/abandonment are all logged here directly,
// so `_drain_write`'s loop just calls this and moves on to whatever's
// pending next.
async function _write_with_timeout(file_path, content, state) {
  const started = Date.now();
  let warned = false;
  const warn_timer = setTimeout(() => {
    warned = true;
    console.warn(
        `[io_queue] write to ${file_path} still pending after ${
            STALL_WARN_MS}ms`);
  }, STALL_WARN_MS);

  const write_promise = writeFile(file_path, content, 'utf8');
  // Attached independently of the race below, so a write that gets
  // abandoned still has its eventual real outcome logged instead of
  // vanishing silently.
  write_promise
      .then(() => {
        if (warned) {
          console.warn(
              `[io_queue] write to ${file_path} finally completed after ${
                  Date.now() - started}ms`);
        }
      })
      .catch((e) => {
        console.warn(`[io_queue] write failed for ${file_path}: ${e.message}`);
      })
      .finally(() => clearTimeout(warn_timer));

  const outcome = await Promise.race([
    write_promise.then(() => 'done', () => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), WRITE_ABANDON_MS)),
  ]);

  if (outcome === 'timeout') {
    console.warn(
        `[io_queue] write to ${file_path} exceeded ${
            WRITE_ABANDON_MS}ms — abandoning it and retrying with the ` +
        `latest content rather than blocking this path indefinitely.`);
    // Only re-queues if nothing newer arrived while we were waiting —
    // otherwise the next loop iteration already has fresher content to
    // write, and retrying this now-stale snapshot would just throw away
    // that newer update.
    if (state.pending === null) state.pending = content;
  }
}

class IOQueue {
  constructor() {
    this._states = new Map();
  }

  write(file_path, content_or_thunk) {
    let state = this._states.get(file_path);
    if (!state) {
      state = {mode: 'write', pending: null, in_flight: null};
      this._states.set(file_path, state);
    }
    state.pending = content_or_thunk;
    if (state.in_flight) return;
    state.in_flight = this._drain_write(file_path, state);
  }

  append(file_path, chunk) {
    let state = this._states.get(file_path);
    if (!state) {
      state = {mode: 'append', buffer: [], in_flight: null};
      this._states.set(file_path, state);
    }
    state.buffer.push(String(chunk ?? ''));
    if (state.in_flight) return;
    state.in_flight = this._drain_append(file_path, state);
  }

  async _drain_write(file_path, state) {
    while (state.pending !== null) {
      const next = state.pending;
      state.pending = null;
      const content =
          typeof next === 'function' ? next() : String(next ?? '');
      await _write_with_timeout(file_path, content, state);
    }
    state.in_flight = null;
  }

  async _drain_append(file_path, state) {
    while (state.buffer.length > 0) {
      const chunks = state.buffer;
      state.buffer = [];
      const content = chunks.join('');
      try {
        await _watch_for_stall(
            file_path, 'append', appendFile(file_path, content, 'utf8'));
      } catch (e) {
        console.warn(
            `[io_queue] append failed for ${file_path}: ${e.message}`);
      }
    }
    state.in_flight = null;
  }

  // Resolves when every queued write — including any added during the drain
  // itself — has settled. Call before process exit / test teardown to avoid
  // losing the last few writes.
  async drain() {
    while (true) {
      const promises = [];
      for (const state of this._states.values()) {
        if (state.in_flight) promises.push(state.in_flight);
      }
      if (promises.length === 0) return;
      await Promise.all(promises);
    }
  }
}

export const ioQueue = new IOQueue();
