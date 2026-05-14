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

// Minimum XZ-distance reduction required to count an iteration as
// forward progress. If an iteration ends with the bot less than this
// many blocks closer to the target than it started, the wrapper bails
// rather than spin in place. Covers both "no forward progress"
// (delta near 0) and "backward progress" (delta negative).
//
// A successful midpoint hop typically reduces distance by
// ~iter_start_dist/2 (midpoint is halfway between bot and target),
// which dominates this threshold for any non-trivial path. The check
// is intended to catch the pathological "bot did not move at all"
// case where retrying from the same position would produce the same
// outcome.
const MIN_FORWARD_PROGRESS_BLOCKS = 1.0;

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

// XZ-only distance — the wrapper's notion of progress matches its
// notion of midpoint (XZ plane). Returns null if either position is
// missing x/z coordinates so callers can disable the progress check
// rather than compare against NaN.
function distanceXZ(a, b) {
    if (a == null || b == null) return null;
    if (a.x == null || a.z == null || b.x == null || b.z == null) return null;
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

function formatPos(p) {
    if (p == null) return null;
    const fmt = (v) => typeof v === 'number' ? v.toFixed(1) : (v ?? '?');
    return `(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)})`;
}

function logAttempt({ label, attempt, phase, depth, outcome, elapsedMs, message, mid, target, reason, retry, pos, moved }) {
    const ts = new Date().toISOString();
    const rawTail = (message || '').replace(/\s+/g, ' ').trim();
    const tailMax = PATHFINDING_WRAPPER_LOG_TAIL_MAX_CHARS;
    const tail = rawTail.length > tailMax ? '…' + rawTail.slice(-tailMax) : rawTail;
    const midStr = mid ? ` mid=(${mid.x},${mid.z})` : '';
    const targetStr = target ? ` target=(${target.x},${target.y ?? '?'},${target.z})` : '';
    const posStr = pos ? ` pos=${formatPos(pos)}` : '';
    const movedStr = moved == null ? '' : ` moved=${moved.toFixed(1)}`;
    const reasonStr = reason ? ` reason=${reason}` : '';
    const attemptStr = attempt == null ? '' : ` attempt=${attempt}`;
    const outcomeStr = outcome == null ? '' : ` outcome=${outcome}`;
    const elapsedStr = elapsedMs == null ? '' : ` elapsed=${elapsedMs}ms`;
    const tailStr = message == null ? '' : ` tail="${tail}"`;
    const retryStr = retry ? ' retry=true' : '';
    const line = `[${ts}] [pathfinding_wrapper] ${label}${attemptStr} phase=${phase} depth=${depth}${retryStr}${outcomeStr}${elapsedStr}${targetStr}${midStr}${posStr}${movedStr}${reasonStr}${tailStr}`;
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
            // --- Progress snapshot ---
            // Resolve target at iter start for the no-forward-progress
            // check at the bottom. Some consumers (searchForBlock)
            // derive target from the previous runFinal's message and
            // return null on iter 1; goToSurface omits getTarget
            // entirely. In both cases iter_start_dist stays null and
            // the bottom-of-loop check is skipped for this iteration.
            const iter_target = getTarget ? getTarget(agent, args, lastMessage) : null;
            const iter_start_dist = iter_target
                ? distanceXZ(agent.bot.entity.position, iter_target)
                : null;

            // --- Final-goal attempt ---
            attempt++;
            const isRetry = attempt > 1;
            const finalStartPos = agent.bot.entity.position.clone();
            logAttempt({ label, attempt, phase: 'start_final', depth, retry: isRetry, pos: finalStartPos, target: iter_target });
            const tFinal = Date.now();
            const finalReturn = await agent.actions.runAction(
                actionLabel,
                async () => { await runFinal(agent, ...args); },
                { timeout: -1, resume: false },
            );
            const finalElapsed = Date.now() - tFinal;
            // `moved` is null if positions are malformed; logAttempt omits
            // the field in that case rather than logging a misleading 0.0.
            const finalMoved = distanceXZ(finalStartPos, agent.bot.entity.position);
            if (finalReturn.interrupted && !finalReturn.timedout) {
                logAttempt({ label, attempt, phase: 'final_interrupted', depth, elapsedMs: finalElapsed, moved: finalMoved });
                return { success: false, message: '' };
            }
            lastMessage = finalReturn.message;
            const finalOutcome = classifyOutcome(lastMessage);
            logAttempt({ label, attempt, phase: 'final', depth, outcome: finalOutcome, elapsedMs: finalElapsed, moved: finalMoved, message: lastMessage });

            if (finalOutcome === 'success') return { success: true, message: lastMessage };
            if (finalOutcome === 'non_retryable') return { success: false, message: lastMessage };
            if (depth >= maxDepth) {
                logAttempt({ label, attempt, phase: 'give_up', depth, pos: agent.bot.entity.position, reason: `maxDepth=${maxDepth} reached` });
                return { success: false, message: lastMessage };
            }

            // --- Midpoint hop (only if we have a target to aim halfway toward) ---
            const target = getTarget ? getTarget(agent, args, lastMessage) : null;
            if (!target) {
                logAttempt({
                    label, phase: 'skip_midpoint', depth,
                    reason: getTarget ? 'no_target' : 'no_getTarget',
                    // Surface the runFinal message when target resolution
                    // failed — usually shows why getTarget couldn't parse
                    // it (e.g. "Could not find any X" or an unexpected
                    // message variant).
                    message: getTarget ? lastMessage : null,
                });
                depth++;
            } else {
                const mid = midpoint(agent.bot.entity.position, target);

                attempt++;
                const midStartPos = agent.bot.entity.position.clone();
                logAttempt({ label, attempt, phase: 'start_midpoint', depth, mid, target, pos: midStartPos });
                const tMid = Date.now();
                const midReturn = await agent.actions.runAction(
                    midpointLabel,
                    async () => { await skills.goToXZPosition(agent.bot, mid.x, mid.z, PATHFINDING_WRAPPER_MIDPOINT_CLOSENESS); },
                    { timeout: -1, resume: false },
                );
                const midElapsed = Date.now() - tMid;
                const midMoved = distanceXZ(midStartPos, agent.bot.entity.position);
                if (midReturn.interrupted && !midReturn.timedout) {
                    logAttempt({ label, attempt, phase: 'midpoint_interrupted', depth, elapsedMs: midElapsed, mid, target, moved: midMoved });
                    return { success: false, message: '' };
                }
                const midOutcome = classifyOutcome(midReturn.message);
                logAttempt({ label, attempt, phase: 'midpoint', depth, outcome: midOutcome, elapsedMs: midElapsed, moved: midMoved, message: midReturn.message, mid, target });

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

            // --- Progress check ---
            // After this iteration's final + midpoint phases, verify
            // the bot ended meaningfully closer to the target than it
            // started. If not, subsequent iterations starting from
            // approximately the same position would produce the same
            // failure — bail. Skipped when no target was resolvable
            // for this iteration (iter_start_dist == null).
            if (iter_target != null && iter_start_dist != null) {
                const iter_end_pos = agent.bot.entity.position;
                const iter_end_dist = distanceXZ(iter_end_pos, iter_target);
                if (iter_end_dist != null) {
                    const delta = iter_start_dist - iter_end_dist;
                    if (delta < MIN_FORWARD_PROGRESS_BLOCKS) {
                        logAttempt({
                            label,
                            attempt,
                            phase: 'give_up',
                            depth,
                            target: iter_target,
                            pos: iter_end_pos,
                            reason: `no_forward_progress: xz_dist=${iter_start_dist.toFixed(1)}→${iter_end_dist.toFixed(1)} delta=${delta.toFixed(2)} min=${MIN_FORWARD_PROGRESS_BLOCKS}`,
                        });
                        return { success: false, message: lastMessage };
                    }
                }
            }
        }
    };
}
