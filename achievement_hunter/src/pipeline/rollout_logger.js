import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extract_json } from './json_utils.js';
import { graph_to_mermaid } from './graph_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUTS_DIR = path.join(__dirname, '../../rollouts');
const LIVE_DIR     = path.join(__dirname, '../..');

// ── Formatting helpers ────────────────────────────────────────────────────────

const _ts = () => new Date().toISOString();

function _header(title, note = null) {
    return `# ${title}\n_Updated: ${_ts()}${note ? ` · ${note}` : ''}_\n\n`;
}

const _json_block = obj  => `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
const _code_block = text => `\`\`\`\n${text}\n\`\`\``;

// ── Stage renderers ───────────────────────────────────────────────────────────

/**
 * Builds the SCSG section content string from a parsed SCSG result.
 * Returns null if the result has no renderable state.
 */
function _render_scsg_content(parsed, objective) {
    if (parsed?.r === 2)
        return _header('SCSG') + '**All sinks satisfied (r=2) — task complete.**\n';

    if (parsed?.final) {
        const graph = {
            objective,
            sinks:    parsed.s,
            vertices: parsed.final.vertices || [],
            edges:    parsed.final.edges    || [],
        };
        return _header(`SCSG — ${objective}`, `r=${parsed.r}`) + graph_to_mermaid(graph);
    }

    return null;
}

/**
 * Formats the current (most recent) AM history entry as a full detail block.
 */
function _format_am_current(entry) {
    const body = entry.parsed ? _json_block(entry.parsed) : _code_block(entry.raw);
    let block = `## Current Action _(attempt ${entry.attempt})_\n_Updated: ${entry.ts}_\n\n${body}`;
    if (entry.warning) block += `\n\n> **Warning:** ${entry.warning}`;
    return block;
}

/**
 * Formats a single previous AM history entry as a one-line summary bullet.
 */
function _format_am_history_entry(entry) {
    const body = entry.parsed
        ? entry.parsed.status === 'TASK_COMPLETE'
            ? '`TASK_COMPLETE`'
            : `\`${JSON.stringify(entry.parsed)}\``
        : `\`${entry.raw.trim().slice(0, 80)}\``;
    const warn = entry.warning ? ` _(warning: ${entry.warning})_` : '';
    return `- _(attempt ${entry.attempt})_ ${body}${warn}`;
}

// ── File I/O helpers ──────────────────────────────────────────────────────────

function _write_live(filename, content) {
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

// ── Logger factory ────────────────────────────────────────────────────────────

/**
 * Creates a new rollout log file for a single structured loop run.
 * Returns a logger object with methods for each pipeline stage.
 *
 * Usage:
 *   const log = createRolloutLogger('craft a diamond sword');
 *   log.ptd(raw_response, parsed_graph);
 *   log.scsg(raw_response, parsed_result);
 *   log.nts(raw_response, parsed_task);
 *   log.am(attempt, raw_response, state);
 *   log.am_warn(message);
 *   log.complete(reason);
 */
export function createRolloutLogger(objective) {
    mkdirSync(ROLLOUTS_DIR, { recursive: true });

    const started_at = _ts();
    const timestamp  = started_at.replace(/[:.]/g, '-');
    const safe_obj   = objective.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const file_path  = path.join(ROLLOUTS_DIR, `${timestamp}_${safe_obj}.json`);

    const rollout = { objective, started_at, stages: [] };

    const live = {
        ptd:        '_PTD not yet generated._',
        scsg:       '_SCSG not yet generated._',
        candidates: '_Candidates not yet computed._',
        nts:        '## Current Task\n_NTS not yet run._',
        am:         '## Current Action\n_AM not yet run._',
    };

    const am_history = [];

    // ── Stateful helpers ──────────────────────────────────────────────────────

    function _flush() {
        writeFileSync(file_path, JSON.stringify(rollout, null, 2), 'utf8');
    }

    function push(entry) {
        rollout.stages.push({ timestamp: _ts(), ...entry });
        _flush();
    }

    /** Updates a live section, optionally writing a dedicated file, then redraws the combined view. */
    function _update(key, content, dedicated_file = null) {
        live[key] = content;
        if (dedicated_file) _write_live(dedicated_file, content);
        _write_combined(live);
    }

    /** Rebuilds live.am from the full am_history. */
    function _render_am() {
        if (am_history.length === 0) return;
        const current  = am_history.at(-1);
        const previous = am_history.slice(0, -1).reverse();

        let block = _format_am_current(current);
        if (previous.length > 0)
            block += '\n\n**Previous:**\n\n' + previous.map(_format_am_history_entry).join('\n');

        live.am = block;
    }

    function _commit_am() {
        _render_am();
        _write_combined(live);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        ptd(raw, parsed) {
            push({ stage: 'PTD', raw, parsed });
            if (!parsed) return;
            _update('ptd',
                _header(`PTD — ${parsed.objective || 'unknown'}`) + graph_to_mermaid(parsed),
                'current_ptd.md');
        },

        scsg(raw, parsed) {
            push({ stage: 'SCSG', raw, parsed });
            const content = _render_scsg_content(parsed, rollout.objective);
            if (content) live.scsg = content;
            _write_live('current_scsg.md', live.scsg);
            _write_combined(live);
        },

        candidates(candidates) {
            push({ stage: 'CANDIDATES', candidates });
            const graph = { objective: rollout.objective, sinks: [], vertices: candidates, edges: [] };
            _update('candidates',
                _header(`Candidates — ${rollout.objective}`, `${candidates.length} source node(s)`) +
                graph_to_mermaid(graph));
        },

        nts(raw, parsed) {
            push({ stage: 'NTS', raw, parsed });
            const body = parsed ? _json_block(parsed) : `_NTS parse failed._\n\n${_code_block(raw)}`;
            _update('nts', `## Current Task\n_Updated: ${_ts()}_\n\n${body}`);
        },

        am(attempt, raw, state = null) {
            push({ stage: 'AM', attempt, raw, ...(state && { state }) });
            am_history.push({ attempt, raw, parsed: extract_json(raw), ts: _ts() });
            _commit_am();
        },

        am_warn(message) {
            if (am_history.length === 0) return;
            am_history[am_history.length - 1].warning = message;
            push({ stage: 'AM_WARN', message });
            _commit_am();
        },

        complete(reason) {
            rollout.completed_at = _ts();
            rollout.completion_reason = reason;
            _flush();
            console.log('[SPL] Rollout saved to', file_path);
        },
    };
}
