import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extract_json } from './json_utils.js';
import { graph_to_mermaid } from './graph_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUTS_DIR = path.join(__dirname, '../../rollouts');
const LIVE_DIR = path.join(__dirname, '../..');


function _write_live(filename, content) {
    mkdirSync(LIVE_DIR, { recursive: true });
    writeFileSync(path.join(LIVE_DIR, filename), content, 'utf8');
}

function _write_combined(live) {
    const divider = '\n\n---\n\n';
    const side_by_side =
        `<table width="100%"><tr>\n` +
        `<td width="50%" valign="top">\n\n${live.nts}\n\n</td>\n` +
        `<td width="50%" valign="top">\n\n${live.am}\n\n</td>\n` +
        `</tr></table>`;
    _write_live('current_graphs.md',
        live.ptd + divider + live.scsg + divider +
        live.candidates + divider + side_by_side
    );
}

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

    // Track latest rendered content for the combined view
    const live = {
        ptd: '_PTD not yet generated._',
        scsg: '_SCSG not yet generated._',
        candidates: '_Candidates not yet computed._',
        nts: '## Current Task\n_NTS not yet run._',
        am: '## Current Action\n_AM not yet run._',
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
            if (parsed) {
                const ts = new Date().toISOString();
                const header = `# PTD — ${parsed.objective || 'unknown'}\n_Updated: ${ts}_\n\n`;
                live.ptd = header + graph_to_mermaid(parsed);
                _write_live('current_ptd.md', live.ptd);
                _write_combined(live);
            }
        },
        scsg(raw, parsed) {
            push({ stage: 'SCSG', raw, parsed });
            const ts = new Date().toISOString();
            if (parsed && parsed.r === 2) {
                live.scsg = `# SCSG\n_Updated: ${ts}_\n\n**All sinks satisfied (r=2) — task complete.**\n`;
            } else if (parsed && parsed.final) {
                const graph = {
                    objective: rollout.objective,
                    sinks: parsed.s,
                    vertices: parsed.final.vertices || [],
                    edges: parsed.final.edges || [],
                };
                const header = `# SCSG — ${rollout.objective}\n_Updated: ${ts} · r=${parsed.r}_\n\n`;
                live.scsg = header + graph_to_mermaid(graph);
            }
            _write_live('current_scsg.md', live.scsg);
            _write_combined(live);
        },
        candidates(candidates) {
            push({ stage: 'CANDIDATES', candidates });
            const ts = new Date().toISOString();
            const header = `# Candidates — ${rollout.objective}\n_Updated: ${ts} · ${candidates.length} source node(s)_\n\n`;
            const graph = {
                objective: rollout.objective,
                sinks: [],
                vertices: candidates,
                edges: [],
            };
            live.candidates = header + graph_to_mermaid(graph);
            _write_combined(live);
        },
        nts(raw, parsed) {
            push({ stage: 'NTS', raw, parsed });
            const ts = new Date().toISOString();
            const body = parsed
                ? `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
                : `_NTS parse failed._\n\n\`\`\`\n${raw}\n\`\`\``;
            live.nts = `## Current Task\n_Updated: ${ts}_\n\n${body}`;
            _write_combined(live);
        },
        am(attempt, raw, state = null) {
            push({ stage: 'AM', attempt, raw, ...(state && {state}) });
            const ts = new Date().toISOString();
            const parsed = extract_json(raw);
            const body = parsed
                ? `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
                : `\`\`\`\n${raw}\n\`\`\``;
            live.am = `## Current Action _(attempt ${attempt})_\n_Updated: ${ts}_\n\n${body}`;
            _write_combined(live);
        },
        complete(reason) {
            rollout.completed_at = new Date().toISOString();
            rollout.completion_reason = reason;
            _flush();
            console.log('[SPL] Rollout saved to', file_path);
        },
    };
}
