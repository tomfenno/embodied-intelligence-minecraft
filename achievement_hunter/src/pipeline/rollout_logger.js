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
  RECOVERY: 'RECOVERY',
};

const SOURCE = {
  LLM: 'llm',
  SEARCH: 'search',
  CHECKPOINT: 'checkpoint',
};

const LIVE_FILE = {
  PTD: 'current_ptd.md',
  PTD_REFINEMENT: 'current_ptd_refinement.md',
  SCSG: 'current_scsg.md',
  DASHBOARD: 'current_rollout.md',
  LEGACY_DASHBOARD: 'current_graphs.md',
};

const PLACEHOLDER = {
  PTD: '_PTD not yet generated._',
  PTD_REFINEMENT: '_PTD self-refine not yet started._',
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

function format_latency(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const total_seconds = ms / 1000;
  if (total_seconds < 10) return `${total_seconds.toFixed(2)} s`;
  if (total_seconds < 60) return `${total_seconds.toFixed(1)} s`;

  const hours = Math.floor(total_seconds / 3600);
  const minutes = Math.floor((total_seconds % 3600) / 60);
  const seconds = total_seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${pad2(Math.floor(seconds))}s`;
  if (seconds < 10) return `${minutes}m ${seconds.toFixed(1)}s`;
  return `${minutes}m ${Math.round(seconds)}s`;
}

function escape_markdown(value) {
  return String(value ?? '').replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function escape_html(value) {
  return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

function header(title, note = null) {
  const safe_title = escape_markdown(title);
  if (!note) return `# ${safe_title}\n\n`;
  return `# ${safe_title}\n_${escape_markdown(note)}_\n\n`;
}

function json_block(obj) {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

function code_block(text) {
  return `\`\`\`\n${String(text ?? '')}\n\`\`\``;
}

function render_single_latency_block(label, latency_ms) {
  if (latency_ms == null) return null;
  return `**LLM latency**\n- **${escape_markdown(label)}:** ${
      format_latency(latency_ms)}`;
}

function render_elapsed_panel(elapsed, status) {
  const status_label = status === STATUS.COMPLETED ? 'Completed' : 'Running';

  return [
    '<div align="center" style="height: 100%; display: flex; flex-direction: column; justify-content: center;">',
    '<div style="font-size: 0.85em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; margin-bottom: 0.6em;">Elapsed</div>',
    `<div style="font-size: 3.4em; font-weight: 800; line-height: 1; margin: 0 0 0.3em 0; white-space: nowrap;">${
        escape_html(elapsed)}</div>`,
    `<div style="font-size: 0.95em; font-weight: 600;">${
        escape_html(status_label)}</div>`,
    '</div>',
  ].join('\n');
}

function format_recovery_command(action) {
  const args = (action.args ?? []).map(a => JSON.stringify(a)).join(', ');
  return `${action.name}(${args})`;
}

// ── Renderers
// ─────────────────────────────────────────────────────────────

const stage_renderer = {
  ptd(ptd_state) {
    if (!ptd_state || ptd_state.status === 'idle') return PLACEHOLDER.PTD;

    const objective = ptd_state.objective || 'unknown';

    if (ptd_state.status === 'failed') {
      const latency =
          render_single_latency_block('PTD generation', ptd_state.latency_ms);

      const error_line = ptd_state.error ?
          `**Status:** ${escape_markdown(ptd_state.error)}\n\n` :
          '';

      const body = ptd_state.raw ? code_block(ptd_state.raw) :
                                   '_No model output captured._';

      return header(`PTD — ${objective}`, 'failed') +
          (latency ? `${latency}\n\n` : '') + error_line + body;
    }

    const latency =
        render_single_latency_block('PTD generation', ptd_state.latency_ms);

    const source_line = ptd_state.source === SOURCE.CHECKPOINT ?
        '**Source:** loaded from checkpoint\n\n' :
        '';

    return header(`PTD — ${objective}`) + (latency ? `${latency}\n\n` : '') +
        source_line + graph_to_mermaid(ptd_state.parsed);
  },

  ptd_refinement(rounds, objective) {
    if (!rounds || rounds.length === 0) return PLACEHOLDER.PTD_REFINEMENT;

    const parts = [header(`PTD Self-Refine — ${objective}`)];

    for (const entry of rounds) {
      const stage_label =
          entry.stage.charAt(0).toUpperCase() + entry.stage.slice(1);
      parts.push(`## Round ${entry.round} · ${escape_markdown(stage_label)}\n`);

      if (entry.latency_ms != null) {
        parts.push(`**Latency:** ${format_latency(entry.latency_ms)}\n`);
      }

      if (entry.error) {
        parts.push(`**Error:** ${escape_markdown(entry.error)}\n`);
        if (entry.raw) parts.push(code_block(entry.raw));
      } else if (entry.stage === 'validate') {
        const vo = entry.validator_output;
        if (vo) {
          const icon = vo.verdict === 'pass' ? '✅' : '❌';
          parts.push(`**Verdict:** ${icon} ${escape_markdown(vo.verdict)}\n`);
          if (vo.definite_issues?.length > 0) {
            parts.push(
                '**Definite issues:**\n' +
                vo.definite_issues.map(i => `- ${escape_markdown(i)}`)
                    .join('\n') +
                '\n');
          }
          if (vo.possible_issues?.length > 0) {
            parts.push(
                '**Possible issues:**\n' +
                vo.possible_issues.map(i => `- ${escape_markdown(i)}`)
                    .join('\n') +
                '\n');
          }
          if (vo.summary) {
            parts.push(`**Summary:** ${escape_markdown(vo.summary)}\n`);
          }
        } else {
          parts.push('_Validator output unavailable._\n');
          if (entry.raw) parts.push(code_block(entry.raw));
        }
      } else {
        if (entry.graph) {
          parts.push(graph_to_mermaid(entry.graph));
        } else {
          parts.push('_Graph extraction failed._\n');
          if (entry.raw) parts.push(code_block(entry.raw));
        }
      }

      parts.push('\n---\n');
    }

    return parts.join('\n');
  },

  scsg(parsed, objective) {
    if (parsed?.r === 2) {
      return header('SCSG') +
          '**All sinks satisfied (r=2) — task complete.**\n';
    }

    if (!parsed?.final) return null;

    const graph = {
      objective,
      sinks: parsed.s,
      vertices: parsed.final.vertices || [],
      edges: parsed.final.edges || [],
    };

    return header(`SCSG — ${objective}`, `r=${parsed.r}`) +
        graph_to_mermaid(graph);
  },

  candidates(objective, candidates) {
    if (candidates === null) return null;

    const graph = {
      objective,
      sinks: [],
      vertices: candidates,
      edges: [],
    };

    return header(
               `Candidates — ${objective}`,
               `${candidates.length} source node(s)`) +
        graph_to_mermaid(graph);
  },

  nts(nts_state) {
    if (!nts_state) return PLACEHOLDER.NTS;

    const body = nts_state.parsed ?
        json_block(nts_state.parsed) :
        `_NTS parse failed._\n\n${code_block(nts_state.raw)}`;

    return `**Current Task**\n\n${body}`;
  },

  completion(objective, completion_state) {
    if (!completion_state) return null;

    const safe_reason = escape_markdown(completion_state.reason);
    return header(`Completed — ${objective}`) + `**Task complete.**\n\n` +
        `- **Reason:** ${safe_reason}\n` +
        `- **Total elapsed:** ${completion_state.total_elapsed}\n`;
  },

  recovery_status(recovery) {
    if (!recovery) return null;
    const current = recovery.attempts.at(-1);
    if (!current) return '**Recovery**\n\n_Awaiting LLM..._';

    const parts = [
      `**Recovery** _(attempt ${current.attempt})_\n\n`,
      `**Diagnosis:** ${escape_markdown(current.diagnosis)}\n\n`,
      `**Plan:**\n`,
    ];
    for (const action of current.planned_actions) {
      parts.push(`- ${inline_code(format_recovery_command(action))}\n`);
    }

    const previous = recovery.attempts.slice(0, -1);
    if (previous.length > 0) {
      parts.push('\n**Previous diagnoses:**\n');
      for (const prev of [...previous].reverse()) {
        parts.push(`- _(attempt ${prev.attempt})_ ${escape_markdown(prev.diagnosis)}\n`);
      }
    }

    return parts.join('');
  },

  recovery_actions(recovery) {
    if (!recovery) return PLACEHOLDER.AM;
    const current = recovery.attempts.at(-1);
    if (!current) return '**Recovery Actions**\n\n_Awaiting actions..._';

    const parts = [`**Recovery Actions** _(attempt ${current.attempt})_\n\n`];
    for (let i = 0; i < current.planned_actions.length; i++) {
      const command = inline_code(format_recovery_command(current.planned_actions[i]));
      const result = current.results[i];
      if (!result) {
        parts.push(`- ⏳ ${command}\n`);
      } else if (result.success) {
        parts.push(`- ✅ ${command}\n`);
      } else {
        const msg = result.message ? ` — ${escape_markdown(result.message)}` : '';
        parts.push(`- ❌ ${command}${msg}\n`);
      }
    }
    return parts.join('');
  },
};

const am_renderer = {
  current(entry) {
    const body =
        entry.parsed ? json_block(entry.parsed) : code_block(entry.raw);

    let title = `**Current Action** _(attempt ${entry.attempt}`;
    if (entry.source === SOURCE.SEARCH) title += ' · search';
    title += ')_';

    let block = `${title}\n\n${body}`;

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

    const source = entry.source === SOURCE.SEARCH ? ' · search' : '';
    const warn =
        entry.warning ? ` _(warning: ${escape_markdown(entry.warning)})_` : '';

    return `- _(attempt ${entry.attempt}${source})_ ${body}${warn}`;
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

  write_dashboard({ptd, elapsed_panel, scsg, candidates, nts, am}) {
    const divider = '\n\n---\n\n';
    const card_style =
        'border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;';
    const row_style =
        'table-layout: fixed; border-collapse: separate; border-spacing: 0;';

    function make_row(left, right, left_width = '50%', right_width = '50%') {
      return `<table width="100%" style="${row_style}"><tr>\n` +
          `<td width="${left_width}" valign="top" style="${card_style}">\n\n${
                 left}\n\n</td>\n` +
          `<td width="2%"></td>\n` +
          `<td width="${right_width}" valign="top" style="${card_style}">\n\n${
                 right}\n\n</td>\n` +
          `</tr></table>`;
    }

    const sections = [
      make_row(ptd, elapsed_panel, '72%', '26%'),
      make_row(scsg, candidates || PLACEHOLDER.CANDIDATES),
      make_row(nts, am),
    ].filter(Boolean);

    this.write_file(LIVE_FILE.DASHBOARD, sections.join(divider));
  },
};

// ── Logger factory
// ─────────────────────────────────────────────────────────────

/**
 * Creates a new rollout log file for a single structured loop run.
 */
export function createRolloutLogger(objective) {
  mkdirSync(LIVE_DIR, {recursive: true});

  const started_at = iso_now();
  const started_ms = Date.now();
  const timestamp = started_at.replace(/[:.]/g, '-');
  const safe_objective = objective.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const rollout_dir = path.join(ROLLOUTS_DIR, `${timestamp}_${safe_objective}`);
  const rollout_path = path.join(rollout_dir, 'rollout_trace.json');
  mkdirSync(rollout_dir, {recursive: true});

  const rollout = {
    objective,
    status: STATUS.RUNNING,
    started_at,
    stages: [],
  };

  const live_state = {
    ptd: {
      status: 'idle',
      objective,
      raw: '',
      parsed: null,
      latency_ms: null,
      error: null,
      source: null,
    },
    ptd_refinement_rounds: [],
    scsg_result: null,
    candidates: null,
    nts_result: null,
    am_history: [],
    completion: null,
    recovery: null,
  };

  live_writer.remove_file(LIVE_FILE.LEGACY_DASHBOARD);
  live_writer.write_file(LIVE_FILE.PTD_REFINEMENT, PLACEHOLDER.PTD_REFINEMENT);

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

  function current_elapsed() {
    return rollout.status === STATUS.COMPLETED && rollout.total_elapsed ?
        rollout.total_elapsed :
        format_elapsed(started_ms);
  }

  function render_live() {
    const ptd_content = stage_renderer.ptd(live_state.ptd);
    const elapsed_panel =
        render_elapsed_panel(current_elapsed(), rollout.status);

    const scsg_content = rollout.status === STATUS.COMPLETED ?
        stage_renderer.completion(objective, live_state.completion) :
        stage_renderer.scsg(live_state.scsg_result, objective);

    const in_recovery = live_state.recovery != null;

    const candidates_content = rollout.status === STATUS.COMPLETED ? null :
        in_recovery ? stage_renderer.recovery_status(live_state.recovery) :
                      stage_renderer.candidates(objective, live_state.candidates);

    const nts_content = stage_renderer.nts(live_state.nts_result);

    const am_content = in_recovery ?
        stage_renderer.recovery_actions(live_state.recovery) :
        am_renderer.panel(live_state.am_history);

    live_writer.write_file(LIVE_FILE.PTD, ptd_content);
    live_writer.write_file(LIVE_FILE.SCSG, scsg_content || PLACEHOLDER.SCSG);

    live_writer.write_dashboard({
      ptd: ptd_content,
      elapsed_panel,
      scsg: scsg_content || PLACEHOLDER.SCSG,
      candidates: candidates_content ||
          (rollout.status === STATUS.COMPLETED ? null : PLACEHOLDER.CANDIDATES),
      nts: nts_content,
      am: am_content,
    });
  }

  // ── Public API
  // ───────────────────────────────────────────────────────────

  return {
    rollout_dir,
    objective,

    ptd(raw, parsed, meta = {}) {
      record_stage({
        stage: STAGE.PTD,
        raw,
        parsed,
        ...(Object.keys(meta).length > 0 ? {meta} : {}),
      });

      if (meta.stage) {
        const entry = {
          stage: meta.stage,
          round: meta.round ?? 0,
          latency_ms: meta.latency_ms ?? null,
          raw: raw ?? '',
          error: meta.error ?? null,
        };

        if (meta.stage === 'validate') {
          entry.validator_output = parsed;
        } else {
          entry.graph = parsed;
        }

        live_state.ptd_refinement_rounds.push(entry);
        live_writer.write_file(
            LIVE_FILE.PTD_REFINEMENT,
            stage_renderer.ptd_refinement(
                live_state.ptd_refinement_rounds, objective));

        if (meta.stage === 'validate') return;
      }

      live_state.ptd = {
        status: parsed ? 'complete' : 'failed',
        objective: parsed?.objective || objective,
        raw: raw ?? '',
        parsed: parsed ?? null,
        latency_ms: meta.latency_ms ?? null,
        error: meta.error ?? null,
        source: meta.source ?? SOURCE.LLM,
      };

      render_live();
    },

    scsg(raw, parsed, state = null) {
      record_stage({
        stage: STAGE.SCSG,
        raw,
        parsed,
        ...(state && {state}),
      });
      live_state.scsg_result = parsed || null;
      render_live();
    },

    candidates(candidates) {
      record_stage({stage: STAGE.CANDIDATES, candidates});
      live_state.candidates = candidates;
      render_live();
    },

    nts(raw, parsed, meta = {}) {
      record_stage({
        stage: STAGE.NTS,
        raw,
        parsed,
        ...(Object.keys(meta).length > 0 ? {meta} : {}),
      });

      live_state.nts_result = {raw, parsed};

      render_live();
    },

    am(attempt, raw, state = null, meta = {}) {
      record_stage({
        stage: STAGE.AM,
        attempt,
        raw,
        ...(state && {state}),
        ...(Object.keys(meta).length > 0 ? {meta} : {}),
      });

      live_state.am_history.push({
        attempt,
        raw,
        parsed: extract_json(raw),
        source: meta.source ?? SOURCE.LLM,
      });

      render_live();
    },

    am_warn(message) {
      if (live_state.am_history.length === 0) return;

      live_state.am_history.at(-1).warning = message;
      record_stage({stage: STAGE.AM_WARN, message});
      render_live();
    },

    recovery_attempt(attempt, task, diagnosis, planned_actions) {
      if (!live_state.recovery) {
        live_state.recovery = {task, attempts: []};
      }
      live_state.recovery.attempts.push(
          {attempt, diagnosis, planned_actions, results: []});
      record_stage({
        stage: STAGE.RECOVERY,
        type: 'attempt_start',
        attempt,
        task,
        diagnosis,
        planned_actions,
      });
      render_live();
    },

    recovery_action_result(attempt_num, action_index, result) {
      const entry =
          live_state.recovery?.attempts.find(a => a.attempt === attempt_num);
      if (entry) entry.results[action_index] = result;
      record_stage({
        stage: STAGE.RECOVERY,
        type: 'action_result',
        attempt: attempt_num,
        action_index,
        result,
      });
      render_live();
    },

    recovery_end(final_status) {
      record_stage({stage: STAGE.RECOVERY, type: 'end', status: final_status});
      live_state.recovery = null;
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