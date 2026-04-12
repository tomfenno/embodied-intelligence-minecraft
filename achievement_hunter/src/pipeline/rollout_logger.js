import {existsSync, mkdirSync, unlinkSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {graph_to_mermaid} from './graph_utils.js';
import {extract_json} from './json_utils.js';

// ── Paths + constants
// ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUTS_DIR = path.join(__dirname, '../../rollouts');
const LIVE_DIR = path.join(__dirname, '../../rollout_live');

const STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
};

const STAGE = {
  PTD: 'PTD',
  SCSG: 'SCSG',
  CANDIDATES: 'CANDIDATES',
  NTS: 'NTS',
  AM: 'AM',
  AM_WARN: 'AM_WARN',
};

const LIVE_FILE = {
  PTD: 'current_ptd.md',
  SCSG: 'current_scsg.md',
  DASHBOARD: 'current_rollout.md',
  LEGACY_DASHBOARD: 'current_graphs.md',
};

const PLACEHOLDER = {
  PTD: '_PTD not yet generated._',
  SCSG: '_SCSG not yet generated._',
  CANDIDATES: '_Candidates not yet computed._',
  NTS: '**Current Task**\n\n_NTS not yet run._',
  AM: '**Current Action**\n\n_AM not yet run._',
};

// ── Generic helpers
// ─────────────────────────────────────────────────────────────

const iso_now = () => new Date().toISOString();

function pad2(value) {
  return String(value).padStart(2, '0');
}

function format_elapsed(start_ms) {
  const total_seconds = Math.floor((Date.now() - start_ms) / 1000);
  const hours = Math.floor(total_seconds / 3600);
  const minutes = Math.floor((total_seconds % 3600) / 60);
  const seconds = total_seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${pad2(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

function escape_markdown(value) {
  return String(value ?? '').replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function preview_text(value, max_length = 80) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max_length) return compact;
  return `${compact.slice(0, Math.max(0, max_length - 1))}…`;
}

function inline_code(value) {
  const safe = String(value ?? '').replace(/`/g, '\'').replace(/\n/g, ' ');
  return `\`${safe}\``;
}

function header(title, start_ms, note = null) {
  const updated = `+${format_elapsed(start_ms)}`;
  const safe_title = escape_markdown(title);
  const safe_note = note ? ` · ${escape_markdown(note)}` : '';
  return `# ${safe_title}\n_Updated: ${updated}${safe_note}_\n\n`;
}

function json_block(obj) {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

function code_block(text) {
  return `\`\`\`\n${String(text ?? '')}\n\`\`\``;
}

// ── Renderers
// ─────────────────────────────────────────────────────────────

const stage_renderer = {
  ptd(parsed, start_ms) {
    if (!parsed) return null;

    const objective = parsed.objective || 'unknown';
    return header(`PTD — ${objective}`, start_ms) + graph_to_mermaid(parsed);
  },

  scsg(parsed, objective, start_ms) {
    if (parsed?.r === 2) {
      return header('SCSG', start_ms) +
          '**All sinks satisfied (r=2) — task complete.**\n';
    }

    if (!parsed?.final) return null;

    const graph = {
      objective,
      sinks: parsed.s,
      vertices: parsed.final.vertices || [],
      edges: parsed.final.edges || [],
    };

    return header(`SCSG — ${objective}`, start_ms, `r=${parsed.r}`) +
        graph_to_mermaid(graph);
  },

  candidates(objective, candidates, start_ms) {
    if (candidates === null) return null;

    const graph = {
      objective,
      sinks: [],
      vertices: candidates,
      edges: [],
    };

    return header(
               `Candidates — ${objective}`, start_ms,
               `${candidates.length} source node(s)`) +
        graph_to_mermaid(graph);
  },

  nts(nts_state, start_ms) {
    if (!nts_state) return PLACEHOLDER.NTS;

    const body = nts_state.parsed ?
        json_block(nts_state.parsed) :
        `_NTS parse failed._\n\n${code_block(nts_state.raw)}`;

    return `**Current Task**\n_Updated: +${format_elapsed(start_ms)}_\n\n${
        body}`;
  },

  completion(objective, completion_state, start_ms) {
    if (!completion_state) return null;

    const safe_reason = escape_markdown(completion_state.reason);
    return header(`Completed — ${objective}`, start_ms) +
        `**Task complete.**\n\n` +
        `- **Reason:** ${safe_reason}\n` +
        `- **Total elapsed:** ${completion_state.total_elapsed}\n`;
  },
};

const am_renderer = {
  current(entry) {
    const body =
        entry.parsed ? json_block(entry.parsed) : code_block(entry.raw);
    const when = entry.elapsed ? ` · +${entry.elapsed}` : '';

    let block =
        `**Current Action** _(attempt ${entry.attempt}${when})_\n\n${body}`;

    if (entry.warning) {
      block += `\n\n> **Warning:** ${escape_markdown(entry.warning)}`;
    }

    return block;
  },

  history_entry(entry) {
    const body = entry.parsed ? entry.parsed.status === 'TASK_COMPLETE' ?
                                inline_code('TASK_COMPLETE') :
                                inline_code(JSON.stringify(entry.parsed)) :
                                inline_code(preview_text(entry.raw));

    const when = entry.elapsed ? ` · +${entry.elapsed}` : '';
    const warn =
        entry.warning ? ` _(warning: ${escape_markdown(entry.warning)})_` : '';

    return `- _(attempt ${entry.attempt}${when})_ ${body}${warn}`;
  },

  panel(history) {
    if (history.length === 0) return PLACEHOLDER.AM;

    const current = history.at(-1);
    const previous = history.slice(0, -1).reverse();

    let block = this.current(current);

    if (previous.length > 0) {
      block += '\n\n**Previous:**\n\n' +
          previous.map(entry => this.history_entry(entry)).join('\n');
    }

    return block;
  },
};

// ── Live writer
// ─────────────────────────────────────────────────────────────

const live_writer = {
  cache: new Map(),

  write_file(filename, content) {
    const next = String(content ?? '');
    const previous = this.cache.get(filename);

    if (previous === next) return;

    writeFileSync(path.join(LIVE_DIR, filename), next, 'utf8');
    this.cache.set(filename, next);
  },

  remove_file(filename) {
    const file_path = path.join(LIVE_DIR, filename);
    if (existsSync(file_path)) unlinkSync(file_path);
    this.cache.delete(filename);
  },

  write_dashboard({sections, nts, am}) {
    const divider = '\n\n---\n\n';
    const non_empty_sections = sections.filter(Boolean);

    const side_by_side = `<table width="100%"><tr>\n` +
        `<td width="50%" valign="top">\n\n${nts}\n\n</td>\n` +
        `<td width="50%" valign="top">\n\n${am}\n\n</td>\n` +
        `</tr></table>`;

    non_empty_sections.push(side_by_side);
    this.write_file(LIVE_FILE.DASHBOARD, non_empty_sections.join(divider));
  },
};

// ── Logger factory
// ─────────────────────────────────────────────────────────────

/**
 * Creates a new rollout log file for a single structured loop run.
 *
 * Usage:
 *   const log = createRolloutLogger('craft a diamond sword');
 *   log.ptd(raw_response, parsed_graph);
 *   log.scsg(raw_response, parsed_result);
 *   log.candidates(candidate_nodes);
 *   log.nts(raw_response, parsed_task);
 *   log.am(attempt, raw_response, state);
 *   log.am_warn(message);
 *   log.complete(reason);
 */
export function createRolloutLogger(objective) {
  mkdirSync(ROLLOUTS_DIR, {recursive: true});
  mkdirSync(LIVE_DIR, {recursive: true});

  const started_at = iso_now();
  const started_ms = Date.now();
  const timestamp = started_at.replace(/[:.]/g, '-');
  const safe_objective = objective.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const rollout_path =
      path.join(ROLLOUTS_DIR, `${timestamp}_${safe_objective}.json`);

  const rollout = {
    objective,
    status: STATUS.RUNNING,
    started_at,
    stages: [],
  };

  const live_state = {
    ptd_graph: null,
    scsg_result: null,
    candidates: null,
    nts_result: null,
    am_history: [],
    completion: null,
  };

  live_writer.remove_file(LIVE_FILE.LEGACY_DASHBOARD);

  // ── Private helpers
  // ───────────────────────────────────────────────────────────

  function flush_rollout() {
    writeFileSync(rollout_path, JSON.stringify(rollout, null, 2), 'utf8');
  }

  function record_stage(entry) {
    rollout.stages.push({
      timestamp: iso_now(),
      elapsed: format_elapsed(started_ms),
      ...entry,
    });
    flush_rollout();
  }

  function render_live() {
    const ptd_content =
        stage_renderer.ptd(live_state.ptd_graph, started_ms) || PLACEHOLDER.PTD;

    const scsg_content = rollout.status === STATUS.COMPLETED ?
        stage_renderer.completion(
            objective, live_state.completion, started_ms) :
        stage_renderer.scsg(live_state.scsg_result, objective, started_ms);

    const candidates_content = rollout.status === STATUS.COMPLETED ?
        null :
        stage_renderer.candidates(objective, live_state.candidates, started_ms);

    const nts_content = stage_renderer.nts(live_state.nts_result, started_ms);
    const am_content = am_renderer.panel(live_state.am_history);

    live_writer.write_file(LIVE_FILE.PTD, ptd_content);
    live_writer.write_file(LIVE_FILE.SCSG, scsg_content || PLACEHOLDER.SCSG);

    live_writer.write_dashboard({
      sections: [
        ptd_content,
        scsg_content || PLACEHOLDER.SCSG,
        candidates_content ||
            (rollout.status === STATUS.COMPLETED ? null :
                                                   PLACEHOLDER.CANDIDATES),
      ],
      nts: nts_content,
      am: am_content,
    });
  }

  // ── Public API
  // ───────────────────────────────────────────────────────────

  return {
    ptd(raw, parsed) {
      record_stage({stage: STAGE.PTD, raw, parsed});
      live_state.ptd_graph = parsed || null;
      render_live();
    },

    scsg(raw, parsed) {
      record_stage({stage: STAGE.SCSG, raw, parsed});
      live_state.scsg_result = parsed || null;
      render_live();
    },

    candidates(candidates) {
      record_stage({stage: STAGE.CANDIDATES, candidates});
      live_state.candidates = candidates;
      render_live();
    },

    nts(raw, parsed) {
      record_stage({stage: STAGE.NTS, raw, parsed});
      live_state.nts_result = {raw, parsed};
      render_live();
    },

    am(attempt, raw, state = null) {
      record_stage({stage: STAGE.AM, attempt, raw, ...(state && {state})});

      live_state.am_history.push({
        attempt,
        raw,
        parsed: extract_json(raw),
        elapsed: format_elapsed(started_ms),
      });

      render_live();
    },

    am_warn(message) {
      if (live_state.am_history.length === 0) return;

      live_state.am_history.at(-1).warning = message;
      record_stage({stage: STAGE.AM_WARN, message});
      render_live();
    },

    complete(reason) {
      const total_elapsed = format_elapsed(started_ms);

      rollout.status = STATUS.COMPLETED;
      rollout.completed_at = iso_now();
      rollout.total_elapsed = total_elapsed;
      rollout.completion_reason = reason;

      live_state.completion = {
        reason,
        total_elapsed,
      };

      flush_rollout();
      render_live();

      console.log('[SPL] Rollout saved to', rollout_path);
    },
  };
}