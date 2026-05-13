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
      try {
        await writeFile(file_path, content, 'utf8');
      } catch (e) {
        console.warn(
            `[io_queue] write failed for ${file_path}: ${e.message}`);
      }
    }
    state.in_flight = null;
  }

  async _drain_append(file_path, state) {
    while (state.buffer.length > 0) {
      const chunks = state.buffer;
      state.buffer = [];
      const content = chunks.join('');
      try {
        await appendFile(file_path, content, 'utf8');
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
