import {existsSync, mkdirSync, unlinkSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {graph_to_mermaid} from './graph_utils.js';
import {ioQueue} from './io_queue.js';
import {
  ENABLE_LIVE_VIEWER,
  ENABLE_ROLLOUT_LOGGING,
} from './structured_loop/config.js';

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
  TASK: 'TASK',
  AM: 'AM',
  AM_WARN: 'AM_WARN',
  RECOVERY: 'RECOVERY',
  SEARCH_RECOVERY: 'SEARCH_RECOVERY',
};

const SOURCE = {
  LLM: 'llm',
  SEARCH: 'search',
  CHECKPOINT: 'checkpoint',
  DETERMINISTIC: 'deterministic',
};

const LIVE_FILE = {
  PTD: 'current_ptd.md',
  PTD_REFINEMENT: 'current_ptd_refinement.md',
  SCSG: 'current_scsg.md',
  DASHBOARD: 'current_rollout.md',
  LEGACY_DASHBOARD: 'current_graphs.md',
  BREADCRUMBS: 'current_breadcrumbs.md',
  SEARCH_RECOVERY: 'current_search_recovery.md',
};

const PLACEHOLDER = {
  PTD: '_PTD not yet generated._',
  PTD_REFINEMENT: '_PTD self-refine not yet started._',
  SCSG: '_SCSG not yet computed._',
  CANDIDATES: '_Candidates not yet computed._',
  TASK: '**Current Task**\n\n_No task selected yet._',
  AM: '**Current Action**\n\n_No action executed yet._',
  BREADCRUMBS: '# Breadcrumbs\n\n_No breadcrumbs recorded yet._\n',
  SEARCH_RECOVERY:
      '# Search Recovery\n\n_No search recovery currently active._\n',
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

function format_kind_list(kinds) {
  if (!kinds || kinds.length === 0) return '_(none)_';
  return escape_markdown(kinds.join(', '));
}

// Multi-line markdown rendering of a search_replanner attempt's
// end_state ({position, inventory, craftable_items}). Returns null when
// the snapshot is empty/absent so callers can skip the section.
function format_end_state(state) {
  if (!state || typeof state !== 'object') return null;

  const lines = [];

  const pos = state.position;
  if (pos && pos.x != null) {
    lines.push(`pos: \`${pos.x}, ${pos.y}, ${pos.z}\``);
  }

  const inv = state.inventory;
  if (inv && Object.keys(inv).length > 0) {
    const items = Object.entries(inv)
                      .map(([k, v]) => `${k} ×${v}`)
                      .join(', ');
    lines.push(`inventory: ${escape_markdown(items)}`);
  } else if (inv) {
    lines.push('inventory: _(empty)_');
  }

  const craft = state.craftable_items;
  if (craft && craft.length > 0) {
    lines.push(`craftable: ${escape_markdown(craft.join(', '))}`);
  } else if (craft) {
    lines.push('craftable: _(none)_');
  }

  if (lines.length === 0) return null;
  return lines.join('; ');
}

// Strips fields whose value would be the structural default so the persisted
// candidate is the minimum information needed to reconstruct the original.
// Consumers should treat any missing key as the listed default.
function compact_candidate(candidate) {
  const result = {id: candidate.id, qty: candidate.qty};
  if (candidate.item_type != null) result.item_type = candidate.item_type;
  if (candidate.acquisition_dependency &&
      candidate.acquisition_dependency !== 'none') {
    result.acquisition_dependency = candidate.acquisition_dependency;
  }
  if (candidate.satisfied_inputs?.length > 0) {
    result.satisfied_inputs = candidate.satisfied_inputs;
  }
  if (candidate.source_hint != null) result.source_hint = candidate.source_hint;
  if (candidate.source_kind != null) result.source_kind = candidate.source_kind;
  if (candidate.grounded_nearby_source != null) {
    result.grounded_nearby_source = candidate.grounded_nearby_source;
  }
  return result;
}

// Builds a one-shot rollout-level summary so offline consumers don't need
// to re-scan all stages to compute basic counts.
function build_rollout_summary(rollout) {
  const summary = {
    outer_iterations: 0,
    tasks_attempted: 0,
    am_attempts: 0,
    recovery_attempts: 0,
    search_recovery_attempts: 0,
  };
  for (const stage of rollout.stages) {
    if (stage.stage === STAGE.SCSG) summary.outer_iterations += 1;
    else if (stage.stage === STAGE.TASK) summary.tasks_attempted += 1;
    else if (stage.stage === STAGE.AM) summary.am_attempts += 1;
    else if (stage.stage === STAGE.RECOVERY && stage.type === 'attempt_start') {
      summary.recovery_attempts += 1;
    } else if (
        stage.stage === STAGE.SEARCH_RECOVERY &&
        stage.type === 'attempt_start') {
      summary.search_recovery_attempts += 1;
    }
  }
  return summary;
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
      return header('SCSG') + '**All sinks satisfied — task complete.**\n';
    }

    if (!parsed?.final) return null;

    const vertices = parsed.final.vertices || [];
    const note_parts = [`${vertices.length} node(s) remaining`];
    if (parsed.why) note_parts.push(parsed.why);

    const graph = {
      objective,
      sinks: parsed.s,
      vertices,
      edges: parsed.final.edges || [],
    };

    return header(`SCSG — ${objective}`, note_parts.join(' · ')) +
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

  task(task_state) {
    if (!task_state) return PLACEHOLDER.TASK;

    const {task} = task_state;
    const action_type = escape_markdown(task.action_type);
    const target = escape_markdown(task.target_item);
    const qty = task.qty;

    const param_lines = [];
    for (const [key, value] of Object.entries(task.parameters ?? {})) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const items = value
            .map(v => v && typeof v === 'object' && 'item' in v ?
                     `${v.item}${v.qty != null ? ` ×${v.qty}` : ''}` :
                     String(v))
            .join(', ');
        param_lines.push(`- **${escape_markdown(key)}:** ${escape_markdown(items)}`);
      } else {
        param_lines.push(
            `- **${escape_markdown(key)}:** ${escape_markdown(String(value))}`);
      }
    }

    const params_block =
        param_lines.length > 0 ? `\n${param_lines.join('\n')}` : '';

    return `**Current Task** _(${action_type})_\n\n` +
        `${action_type} \`${target}\` ×${qty}${params_block}`;
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

  breadcrumbs(breadcrumbs) {
    if (!breadcrumbs || breadcrumbs.length === 0) {
      return PLACEHOLDER.BREADCRUMBS;
    }

    const lines = [
      header(
          'Breadcrumbs',
          `${breadcrumbs.length} held · sorted by distance from bot (closest first)`),
      '| # | Coords | Biome | Nearby blocks | Nearby mobs |',
      '|---|--------|-------|---------------|-------------|',
    ];

    for (let i = 0; i < breadcrumbs.length; i++) {
      const b = breadcrumbs[i];
      const coords = `(${Math.round(b.x)}, ${Math.round(b.y)}, ${
          Math.round(b.z)})`;
      const biome = b.biome ? escape_markdown(b.biome) : '_(unknown)_';
      const blocks = format_kind_list(b.nearby_block_kinds);
      const mobs = format_kind_list(b.nearby_mob_kinds);
      lines.push(`| ${i + 1} | ${coords} | ${biome} | ${blocks} | ${mobs} |`);
    }

    return lines.join('\n') + '\n';
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

  search_recovery_status(search_recovery) {
    if (!search_recovery) return null;
    const target = escape_markdown(search_recovery.target ?? 'unknown');
    const current = search_recovery.attempts.at(-1);
    if (!current) {
      return `**Search Recovery** _(target: \`${target}\`)_\n\n_Awaiting LLM..._`;
    }

    const parts = [
      `**Search Recovery** _(attempt ${current.attempt}, target: \`${
          target}\`)_\n\n`,
      `**Summary:** ${escape_markdown(current.summary)}\n\n`,
      `**Plan:**\n`,
    ];
    for (const action of current.planned_actions) {
      parts.push(`- ${inline_code(format_recovery_command(action))}\n`);
    }

    const previous = search_recovery.attempts.slice(0, -1);
    if (previous.length > 0) {
      parts.push('\n**Previous summaries:**\n');
      for (const prev of [...previous].reverse()) {
        parts.push(`- _(attempt ${prev.attempt})_ ${
            escape_markdown(prev.summary)}\n`);
        const end_line = format_end_state(prev.end_state);
        if (end_line) parts.push(`  - _end state:_ ${end_line}\n`);
      }
    }

    return parts.join('');
  },

  search_recovery_actions(search_recovery) {
    if (!search_recovery) return PLACEHOLDER.AM;
    const current = search_recovery.attempts.at(-1);
    if (!current) {
      return '**Search Recovery Actions**\n\n_Awaiting actions..._';
    }

    const parts = [
      `**Search Recovery Actions** _(attempt ${current.attempt})_\n\n`,
    ];
    for (let i = 0; i < current.planned_actions.length; i++) {
      const command =
          inline_code(format_recovery_command(current.planned_actions[i]));
      const result = current.results[i];
      if (!result) {
        parts.push(`- ⏳ ${command}\n`);
      } else if (result.success) {
        parts.push(`- ✅ ${command}\n`);
      } else {
        const msg = result.message ?
            ` — ${escape_markdown(result.message)}` :
            '';
        parts.push(`- ❌ ${command}${msg}\n`);
      }
    }
    return parts.join('');
  },
};

const am_renderer = {
  current(entry) {
    const body = inline_code(entry.raw);

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
    const body = inline_code(preview_text(entry.raw));

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
    if (!ENABLE_LIVE_VIEWER) return;

    const next = String(content ?? '');
    const previous = this.cache.get(filename);

    if (previous === next) return;

    ioQueue.write(path.join(LIVE_DIR, filename), next);
    this.cache.set(filename, next);
  },

  remove_file(filename) {
    if (!ENABLE_LIVE_VIEWER) return;

    const file_path = path.join(LIVE_DIR, filename);
    if (existsSync(file_path)) unlinkSync(file_path);
    this.cache.delete(filename);
  },

  write_dashboard({ptd, elapsed_panel, scsg, candidates, task, am}) {
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
      make_row(task, am),
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
  if (ENABLE_LIVE_VIEWER) mkdirSync(LIVE_DIR, {recursive: true});

  const started_at = iso_now();
  const started_ms = Date.now();
  const timestamp = started_at.replace(/[:.]/g, '-');
  const safe_objective = objective.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const rollout_dir = path.join(ROLLOUTS_DIR, `${timestamp}_${safe_objective}`);
  const rollout_path = path.join(rollout_dir, 'rollout_trace.json');
  if (ENABLE_ROLLOUT_LOGGING) mkdirSync(rollout_dir, {recursive: true});

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
    task_state: null,
    am_history: [],
    completion: null,
    recovery: null,
    search_recovery: null,
  };

  live_writer.remove_file(LIVE_FILE.LEGACY_DASHBOARD);
  live_writer.write_file(LIVE_FILE.PTD_REFINEMENT, PLACEHOLDER.PTD_REFINEMENT);
  live_writer.write_file(LIVE_FILE.BREADCRUMBS, PLACEHOLDER.BREADCRUMBS);
  live_writer.write_file(
      LIVE_FILE.SEARCH_RECOVERY, PLACEHOLDER.SEARCH_RECOVERY);

  // ── Private helpers
  // ───────────────────────────────────────────────────────────

  function flush_rollout() {
    if (!ENABLE_ROLLOUT_LOGGING) return;
    // Thunk form: coalesced calls skip the stringify of all but the latest
    // `rollout` state. The closure captures the mutable object by reference,
    // so the deferred read picks up every stage pushed before the write
    // actually runs.
    ioQueue.write(rollout_path, () => JSON.stringify(rollout, null, 2));
  }

  function record_stage(entry) {
    if (!ENABLE_ROLLOUT_LOGGING) return;
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
    if (!ENABLE_LIVE_VIEWER) return;

    const ptd_content = stage_renderer.ptd(live_state.ptd);
    const elapsed_panel =
        render_elapsed_panel(current_elapsed(), rollout.status);

    const scsg_content = rollout.status === STATUS.COMPLETED ?
        stage_renderer.completion(objective, live_state.completion) :
        stage_renderer.scsg(live_state.scsg_result, objective);

    // Search recovery takes precedence over failure recovery in dashboard
    // overrides — the two never actually coexist (search runs first; failure
    // runs only if search returned 'fail' and was already cleared), but the
    // explicit precedence keeps the conditional readable.
    const in_search_recovery = live_state.search_recovery != null;
    const in_recovery = !in_search_recovery && live_state.recovery != null;

    const candidates_content = rollout.status === STATUS.COMPLETED ?
        null :
        in_search_recovery ?
        stage_renderer.search_recovery_status(live_state.search_recovery) :
        in_recovery ?
        stage_renderer.recovery_status(live_state.recovery) :
        stage_renderer.candidates(objective, live_state.candidates);

    const task_content = stage_renderer.task(live_state.task_state);

    const am_content = in_search_recovery ?
        stage_renderer.search_recovery_actions(live_state.search_recovery) :
        in_recovery ?
        stage_renderer.recovery_actions(live_state.recovery) :
        am_renderer.panel(live_state.am_history);

    live_writer.write_file(LIVE_FILE.PTD, ptd_content);
    live_writer.write_file(LIVE_FILE.SCSG, scsg_content || PLACEHOLDER.SCSG);

    // Dedicated standalone view: refreshes whether or not search recovery is
    // active so the file stays in sync with the dashboard. Clears to the
    // placeholder once the recovery ends (live_state.search_recovery = null).
    if (live_state.search_recovery != null) {
      const status =
          stage_renderer.search_recovery_status(live_state.search_recovery);
      const actions =
          stage_renderer.search_recovery_actions(live_state.search_recovery);
      live_writer.write_file(
          LIVE_FILE.SEARCH_RECOVERY,
          `${status}\n\n---\n\n${actions}\n`);
    } else {
      live_writer.write_file(
          LIVE_FILE.SEARCH_RECOVERY, PLACEHOLDER.SEARCH_RECOVERY);
    }

    live_writer.write_dashboard({
      ptd: ptd_content,
      elapsed_panel,
      scsg: scsg_content || PLACEHOLDER.SCSG,
      candidates: candidates_content ||
          (rollout.status === STATUS.COMPLETED ? null : PLACEHOLDER.CANDIDATES),
      task: task_content,
      am: am_content,
    });
  }

  // ── Public API
  // ───────────────────────────────────────────────────────────

  return {
    rollout_dir: ENABLE_ROLLOUT_LOGGING ? rollout_dir : null,
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
      // `raw` is intentionally not persisted: the structured loop only ever
      // passes the constant string '[deterministic]' (SCSG has no LLM path),
      // so it adds bytes without information. Kept in the signature for
      // forward-compat with any future non-deterministic SCSG source.
      record_stage({
        stage: STAGE.SCSG,
        parsed,
        ...(state && {state}),
      });
      live_state.scsg_result = parsed || null;
      render_live();
    },

    candidates(candidates) {
      record_stage({
        stage: STAGE.CANDIDATES,
        candidates: candidates.map(compact_candidate),
      });
      live_state.candidates = candidates;
      render_live();
    },

    // Records the deterministically-selected task for the current outer
    // iteration. Resets the AM history so the "Current Action" panel only
    // shows attempts belonging to this task — without the reset, retries
    // from previous tasks bleed into the new task's panel.
    task(task) {
      record_stage({stage: STAGE.TASK, task});
      live_state.task_state = {task};
      live_state.am_history = [];
      render_live();
    },

    am(attempt, raw, state = null, meta = {}) {
      // Suppress `meta` when it carries only the default deterministic
      // source — that's the implicit default for any AM entry and adds
      // ~30 bytes to every attempt. The `'search'` source (from search.js)
      // is the only value that needs to be persisted explicitly.
      const meta_to_persist = {...meta};
      if (meta_to_persist.source === SOURCE.DETERMINISTIC) {
        delete meta_to_persist.source;
      }

      record_stage({
        stage: STAGE.AM,
        attempt,
        raw,
        ...(state && {state}),
        ...(Object.keys(meta_to_persist).length > 0 ? {meta: meta_to_persist} :
                                                      {}),
      });

      live_state.am_history.push({
        attempt,
        raw,
        source: meta.source ?? SOURCE.DETERMINISTIC,
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

    // Search-replanner equivalents of the recovery_* methods. Kept as a
    // parallel API rather than discriminator-on-recovery so the live view
    // can label panels distinctly ("Search Recovery" vs "Recovery") and so
    // build_rollout_summary can track the two replanner kinds separately.
    search_recovery_attempt(attempt, task, target, summary, planned_actions) {
      if (!live_state.search_recovery) {
        live_state.search_recovery = {task, target, attempts: []};
      }
      live_state.search_recovery.attempts.push(
          {attempt, summary, planned_actions, results: [], end_state: null});
      record_stage({
        stage: STAGE.SEARCH_RECOVERY,
        type: 'attempt_start',
        attempt,
        task,
        target,
        summary,
        planned_actions,
      });
      render_live();
    },

    search_recovery_action_result(attempt_num, action_index, result) {
      const entry = live_state.search_recovery?.attempts.find(
          a => a.attempt === attempt_num);
      if (entry) entry.results[action_index] = result;
      record_stage({
        stage: STAGE.SEARCH_RECOVERY,
        type: 'action_result',
        attempt: attempt_num,
        action_index,
        result,
      });
      render_live();
    },

    search_recovery_attempt_end(attempt_num, end_state) {
      const entry = live_state.search_recovery?.attempts.find(
          a => a.attempt === attempt_num);
      if (entry) entry.end_state = end_state;
      record_stage({
        stage: STAGE.SEARCH_RECOVERY,
        type: 'attempt_end',
        attempt: attempt_num,
        end_state,
      });
      render_live();
    },

    search_recovery_end(final_status) {
      record_stage(
          {stage: STAGE.SEARCH_RECOVERY, type: 'end', status: final_status});
      live_state.search_recovery = null;
      render_live();
    },

    // Snapshots the current breadcrumb map. Not recorded as a stage — this is
    // a continuously-overwritten view, not an event. Persists JSON to the
    // rollout directory and refreshes the live markdown view.
    breadcrumbs(breadcrumbs_list) {
      if (ENABLE_ROLLOUT_LOGGING) {
        ioQueue.write(
            path.join(rollout_dir, 'breadcrumbs.json'),
            () => JSON.stringify(breadcrumbs_list ?? [], null, 2));
      }

      live_writer.write_file(
          LIVE_FILE.BREADCRUMBS, stage_renderer.breadcrumbs(breadcrumbs_list));
    },

    async complete(reason) {
      const total_elapsed = format_elapsed(started_ms);

      rollout.status = STATUS.COMPLETED;
      rollout.completed_at = iso_now();
      rollout.total_elapsed = total_elapsed;
      rollout.completion_reason = reason;
      rollout.summary = build_rollout_summary(rollout);

      live_state.completion = {
        reason,
        total_elapsed,
      };

      flush_rollout();
      render_live();

      // Drain the async write queue so the final rollout JSON + live view
      // are on disk before the SPL run returns. Without this, fast-finishing
      // runs (e.g. tests) can race the queue and observe stale files.
      await ioQueue.drain();

      if (ENABLE_ROLLOUT_LOGGING) {
        console.log('[SPL] Rollout saved to', rollout_path);
      }
    },
  };
}