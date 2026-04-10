import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUTS_DIR = path.join(__dirname, '../rollouts');

/**
 * Creates a new rollout log file for a single structured loop run.
 * Returns a logger object with methods for each pipeline stage.
 *
 * Usage:
 *   const log = createRolloutLogger('craft a diamond sword');
 *   log.ptd(raw_response, parsed_graph);
 *   log.scsg(raw_response, parsed_result);
 *   log.nts(raw_response, parsed_task);
 *   log.am(attempt, raw_response);
 *   log.save();
 */
export function createRolloutLogger(objective) {
    mkdirSync(ROLLOUTS_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe_obj = objective.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const file_path = path.join(ROLLOUTS_DIR, `${timestamp}_${safe_obj}.json`);

    const rollout = {
        objective,
        started_at: new Date().toISOString(),
        stages: [],
    };

    function push(entry) {
        rollout.stages.push({ timestamp: new Date().toISOString(), ...entry });
        _flush();
    }

    function _flush() {
        writeFileSync(file_path, JSON.stringify(rollout, null, 2), 'utf8');
    }

    return {
        ptd(raw, parsed) {
            push({ stage: 'PTD', raw, parsed });
        },
        scsg(raw, parsed) {
            push({ stage: 'SCSG', raw, parsed });
        },
        nts(raw, parsed) {
            push({ stage: 'NTS', raw, parsed });
        },
        am(attempt, raw) {
            push({ stage: 'AM', attempt, raw });
        },
        complete(reason) {
            rollout.completed_at = new Date().toISOString();
            rollout.completion_reason = reason;
            _flush();
            console.log('[SPL] Rollout saved to', file_path);
        },
    };
}
