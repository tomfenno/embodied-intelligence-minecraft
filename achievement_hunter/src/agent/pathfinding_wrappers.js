// Retry wrappers for pathfinding actions.
//
// Pattern-driven outcome classifier — see plan in
// achievement_hunter/docs/pathfinding_wrapper_plan.md §2.
//
// PRECEDENCE: non_retryable > success > retryable > default(retryable).
// `Cannot break X` and `Path was stopped` co-occur in real logs, and the
// true cause is the tool issue, so non_retryable must win the tie.
//
// Add new variants below as they're observed in
// achievement_hunter/logs/pathfinding_wrappers/.

import { mkdirSync, appendFileSync } from 'fs';
import path from 'path';
import * as skills from '../../../src/agent/library/skills.js';
import {
    PATHFINDING_WRAPPER_LOG_DIR,
    PATHFINDING_WRAPPER_LOG_TAIL_MAX_CHARS,
    PATHFINDING_WRAPPER_MAX_DEPTH,
    PATHFINDING_WRAPPER_MIDPOINT_CLOSENESS,
} from '../pipeline/structured_loop/config.js';

const NON_RETRYABLE_PATTERNS = [
    /Pathfinding stopped: Cannot break .+ with current tools\./,
    /Could not find any /,
    /Could not find [^ ]+\./,
    /Could not find a bed to sleep in\./,
    /Missing coordinates,/,
    /No location named ".+" saved\./,
    /No land found within \d+ blocks\./,
    /!!Code threw exception!!/,
];

const SUCCESS_PATTERNS = [
    /You have reached at /,
    /You have reached column /,
    /Already on land\./,
    /You have reached [^ ]+\./,
];

const RETRYABLE_PATTERNS = [
    /Pathfinding stopped: Path was stopped before/,
    /Pathfinding stopped: Took to long to decide path/,
    /Pathfinding stopped: No path to the goal/,
    /Unable to reach .+ blocks away/,
    /Pathfinding stopped:/,
];

export function classifyOutcome(message) {
    if (!message) return 'retryable';
    for (const p of NON_RETRYABLE_PATTERNS) if (p.test(message)) return 'non_retryable';
    for (const p of SUCCESS_PATTERNS) if (p.test(message)) return 'success';
    for (const p of RETRYABLE_PATTERNS) if (p.test(message)) return 'retryable';
    return 'retryable';
}

function midpoint(botPos, target) {
    return {
        x: Math.round((botPos.x + target.x) / 2),
        z: Math.round((botPos.z + target.z) / 2),
    };
}

function logAttempt({ label, attempt, phase, depth, outcome, elapsedMs, message, mid, target, reason, retry }) {
    const ts = new Date().toISOString();
    const tail = (message || '').replace(/\s+/g, ' ').trim().slice(-PATHFINDING_WRAPPER_LOG_TAIL_MAX_CHARS);
    const midStr = mid ? ` mid=(${mid.x},${mid.z})` : '';
    const targetStr = target ? ` target=(${target.x},${target.y ?? '?'},${target.z})` : '';
    const reasonStr = reason ? ` reason=${reason}` : '';
    const attemptStr = attempt == null ? '' : ` attempt=${attempt}`;
    const outcomeStr = outcome == null ? '' : ` outcome=${outcome}`;
    const elapsedStr = elapsedMs == null ? '' : ` elapsed=${elapsedMs}ms`;
    const tailStr = message == null ? '' : ` tail="${tail}"`;
    const retryStr = retry ? ' retry=true' : '';
    const line = `[${ts}] [pathfinding_wrapper] ${label}${attemptStr} phase=${phase} depth=${depth}${retryStr}${outcomeStr}${elapsedStr}${targetStr}${midStr}${reasonStr}${tailStr}`;
    console.log(line);
    try {
        mkdirSync(PATHFINDING_WRAPPER_LOG_DIR, { recursive: true });
        const date = ts.slice(0, 10);
        appendFileSync(path.join(PATHFINDING_WRAPPER_LOG_DIR, `${date}.log`), line + '\n', 'utf8');
    } catch (e) {
        console.warn(`pathfinding_wrappers: log write failed: ${e.message}`);
    }
}

export function withPathRetry({ label, runFinal, getTarget, maxDepth = PATHFINDING_WRAPPER_MAX_DEPTH }) {
    return async function (agent, ...args) {
        const actionLabel = `action:${label}`;
        const midpointLabel = `action:${label}:midpoint`;
        let depth = 0;
        let attempt = 0;
        let lastMessage = null;

        while (true) {
            // --- Final-goal attempt ---
            attempt++;
            const isRetry = attempt > 1;
            logAttempt({ label, attempt, phase: 'start_final', depth, retry: isRetry });
            const tFinal = Date.now();
            const finalReturn = await agent.actions.runAction(
                actionLabel,
                async () => { await runFinal(agent, ...args); },
                { timeout: -1, resume: false },
            );
            const finalElapsed = Date.now() - tFinal;
            if (finalReturn.interrupted && !finalReturn.timedout) {
                logAttempt({ label, attempt, phase: 'interrupted', depth, elapsedMs: finalElapsed, reason: 'final_interrupted' });
                return { success: false, message: '' };
            }
            lastMessage = finalReturn.message;
            const finalOutcome = classifyOutcome(lastMessage);
            logAttempt({ label, attempt, phase: 'final', depth, outcome: finalOutcome, elapsedMs: finalElapsed, message: lastMessage });

            if (finalOutcome === 'success') return { success: true, message: lastMessage };
            if (finalOutcome === 'non_retryable') return { success: false, message: lastMessage };
            if (depth >= maxDepth) {
                logAttempt({ label, phase: 'give_up', depth, reason: `maxDepth=${maxDepth} reached` });
                return { success: false, message: lastMessage };
            }

            // --- Midpoint hop (only if we have a target to aim halfway toward) ---
            const target = getTarget ? getTarget(agent, args, lastMessage) : null;
            if (!target) {
                logAttempt({ label, phase: 'skip_midpoint', depth, reason: getTarget ? 'no_target' : 'no_getTarget' });
                depth++;
                continue;
            }
            const mid = midpoint(agent.bot.entity.position, target);

            attempt++;
            logAttempt({ label, attempt, phase: 'start_midpoint', depth, retry: true, mid, target });
            const tMid = Date.now();
            const midReturn = await agent.actions.runAction(
                midpointLabel,
                async () => { await skills.goToXZPosition(agent.bot, mid.x, mid.z, PATHFINDING_WRAPPER_MIDPOINT_CLOSENESS); },
                { timeout: -1, resume: false },
            );
            const midElapsed = Date.now() - tMid;
            if (midReturn.interrupted && !midReturn.timedout) {
                logAttempt({ label, attempt, phase: 'interrupted', depth, elapsedMs: midElapsed, mid, target, reason: 'midpoint_interrupted' });
                return { success: false, message: '' };
            }
            const midOutcome = classifyOutcome(midReturn.message);
            logAttempt({ label, attempt, phase: 'midpoint', depth, outcome: midOutcome, elapsedMs: midElapsed, message: midReturn.message, mid, target });

            if (midOutcome === 'success') {
                depth = 0;
            } else if (midOutcome === 'non_retryable') {
                // The midpoint hit a permanent obstacle (e.g. needs tools we don't have).
                // The final goal won't fare better — surface the original failure.
                return { success: false, message: lastMessage };
            } else {
                depth++;
            }
        }
    };
}
