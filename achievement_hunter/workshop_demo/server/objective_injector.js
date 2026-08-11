// Injects the chosen objective into a running achievement_hunter agent over
// the same mindserver socket.io channel the built-in web UI uses to send a
// player chat message (src/mindcraft/public/index.html:940,
// `socket.emit('send-message', agentName, {from, message})`).
//
// This is deliberately not the eval harness's --task_path/--task_id
// benchmark mode: the agent already waits for a chat-message objective on
// spawn by default (achievement_hunter/src/agent/achievement_agent.js), so
// reusing that path avoids needing a PTD-filename-to-harness-task-id
// mapping table. See achievement_hunter/workshop_demo/PLAN.md, Phase 2.

import {io} from 'socket.io-client';

const READY_MESSAGE_SUBSTRING = 'Achievement Hunter ready';

/**
 * Waits for the agent's readiness chat message, then sends it the objective.
 * Waiting for the actual readiness broadcast (rather than e.g. a fixed
 * delay or the earlier "logged in" server-log line) avoids a race: a
 * message sent before achievement_agent.js sets `_waiting_for_objective =
 * true` is silently dropped, with no error and no retry.
 */
export async function sendObjective({
  mindserverPort,
  agentName,
  objective,
  from = 'Workshop Demo',
  timeoutMs = 60_000,
}) {
  const socket = io(`http://localhost:${mindserverPort}`);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
            `Timed out after ${timeoutMs}ms waiting for ${
                agentName} to report ready`));
      }, timeoutMs);

      // Don't reject on the first 'connect_error': the mindserver may not
      // be listening yet at the exact moment this connects (agent process
      // just spawned), and socket.io's default reconnection logic already
      // retries with backoff. Only the overall timeout above should fail
      // this call.
      socket.on('bot-output', (sourceAgentName, message) => {
        if (sourceAgentName !== agentName) return;
        if (typeof message !== 'string' ||
            !message.includes(READY_MESSAGE_SUBSTRING)) {
          return;
        }
        clearTimeout(timer);
        resolve();
      });
    });

    // Waits for mindserver.js's ack before disconnecting — `emit()` only
    // queues the packet on the transport, it doesn't guarantee delivery, and
    // disconnecting right after (the old behavior here) could close the
    // connection before that packet actually went out, silently dropping
    // the objective. Confirmed live: dashboard showed "running" with the
    // agent never having received anything. `.timeout()` rejects on its own
    // if mindserver.js never acks at all (e.g. an old server build without
    // the ack support this pairs with), so this can't hang forever either.
    await new Promise((resolve, reject) => {
      socket.timeout(5_000).emit(
          'send-message', agentName, {from, message: objective},
          (err, ack) => {
            if (err) {
              reject(new Error(
                  `mindserver never acknowledged the objective for ${
                      agentName} (no response within 5s)`));
            } else if (!ack?.success) {
              reject(new Error(
                  ack?.error ||
                  `mindserver failed to relay the objective to ${agentName}`));
            } else {
              resolve();
            }
          });
    });
  } finally {
    socket.disconnect();
  }
}
