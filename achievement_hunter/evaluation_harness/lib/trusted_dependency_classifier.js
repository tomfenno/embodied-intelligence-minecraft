import fs from 'fs';
import path from 'path';

import {
  KIND,
  classifyMessage,
  detectDependencyCandidate,
} from '../../src/pipeline/dependency_error_classifier.js';
import {
  extract_command_args,
  extract_command_name,
} from '../../src/pipeline/command_verifier.js';
import {
  is_workstation_item,
} from '../../src/pipeline/structured_loop/dependency_context.js';
import {walkFiles} from './utils.js';

const EVENT_STATUS = Object.freeze({
  CONFIRMED_MISSING: 'confirmed_missing',
  SUPPRESSED_TRANSIENT: 'suppressed_transient',
  AMBIGUOUS: 'ambiguous',
});

const TRUSTED_KIND = Object.freeze({
  TOOL: 'tool',
  RESOURCE: 'resource',
  FUEL: 'fuel',
  WORKSTATION: 'workstation',
});

const TOOL_TEMPLATE_IDS = new Set([
  'collect.no_bucket',
  'collect.no_tool',
  'break.no_tool',
  'path.cant_break',
  'till.no_hoe',
]);

const RESOURCE_TEMPLATE_IDS = new Set([
  'craft.no_resources',
  'smelt.not_enough_input',
  'verifier.craft_no_delta',
  'verifier.smelt_no_delta',
]);

const FUEL_TEMPLATE_IDS = new Set([
  'smelt.no_fuel',
  'smelt.not_enough_fuel',
]);

const WORKSTATION_TEMPLATE_IDS = new Set([
  'craft.needs_table',
  'smelt.no_furnace',
  'trusted_candidate.recipe_requires_crafting_table',
  'trusted_candidate.failed_to_place_crafting_table',
  'trusted_candidate.failed_to_place_furnace',
]);

const LOCAL_RECOVERY_LOOKAHEAD = 6;

function ensure_parent_dir(filePath) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

function write_jsonl(filePath, rows) {
  ensure_parent_dir(filePath);
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}${content ? '\n' : ''}`, 'utf8');
}

function write_text(filePath, content) {
  ensure_parent_dir(filePath);
  fs.writeFileSync(filePath, content, 'utf8');
}

function collapse_whitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function normalize_summary_value(value) {
  return value == null ? null : value;
}

function get_primary_target(record) {
  if (typeof record.task?.target_item === 'string' && record.task.target_item) {
    return record.task.target_item;
  }
  return typeof record.args?.[0] === 'string' ? record.args[0] : null;
}

function get_required_workstation(record, candidate) {
  const explicit = record.dependency_context?.required?.workstation;
  if (explicit != null) return explicit;

  const ids = new Set([
    ...candidate.candidateTemplateIds,
    ...candidate.extraCandidateIds,
  ]);
  const message = candidate.rawMessage;

  if (ids.has('craft.needs_table') ||
      ids.has('trusted_candidate.recipe_requires_crafting_table') ||
      ids.has('trusted_candidate.failed_to_place_crafting_table') ||
      /crafting table|craftingTable/.test(message)) {
    return 'crafting_table';
  }

  if (ids.has('smelt.no_furnace') ||
      ids.has('trusted_candidate.failed_to_place_furnace') ||
      /furnace/.test(message)) {
    return 'furnace';
  }

  const command_target =
      typeof record.args?.[0] === 'string' ? record.args[0] : null;
  return is_workstation_item(command_target) ? command_target : null;
}

function record_outcome_classification(record) {
  if (!record._classification) {
    record._classification = classifyMessage(record.actionName, record.result);
  }
  return record._classification;
}

function record_shows_success(record) {
  const classification = record_outcome_classification(record);
  return classification.kinds.has(KIND.SUCCESS) ||
      classification.kinds.has(KIND.PARTIAL_SUCCESS);
}

function record_matches_target(record, target) {
  if (target == null) return false;
  return get_primary_target(record) === target;
}

function record_provisions_workstation(record, workstation) {
  if (workstation == null) return false;
  const target = get_primary_target(record);
  if (target == null || target !== workstation) return false;

  return (record.actionName === '!craftRecipe' ||
          record.actionName === '!placeHere') &&
      record_shows_success(record);
}

function find_later_success_in_task(records, startIndex, record) {
  const task_record_id = record.task_record_id ?? null;
  if (task_record_id == null) return null;

  for (let index = startIndex + 1; index < records.length; index++) {
    const candidate = records[index];
    if (candidate.task_record_id !== task_record_id) break;
    if (record_shows_success(candidate)) return candidate;
  }

  return null;
}

function find_local_workstation_recovery(records, startIndex, record, candidate) {
  const workstation = get_required_workstation(record, candidate);
  const target = get_primary_target(record);
  let saw_workstation_provision = false;

  for (let offset = 1; offset <= LOCAL_RECOVERY_LOOKAHEAD; offset++) {
    const candidate_record = records[startIndex + offset];
    if (!candidate_record) break;

    if (record.task_record_id != null &&
        candidate_record.task_record_id != null &&
        candidate_record.task_record_id !== record.task_record_id) {
      break;
    }

    if (record_provisions_workstation(candidate_record, workstation)) {
      saw_workstation_provision = true;
      continue;
    }

    if (saw_workstation_provision &&
        record_matches_target(candidate_record, target) &&
        record_shows_success(candidate_record)) {
      return candidate_record;
    }
  }

  return null;
}

function infer_candidate_kind(record, candidate) {
  const ids = new Set([
    ...candidate.candidateTemplateIds,
    ...candidate.extraCandidateIds,
  ]);
  const command_target =
      typeof record.args?.[0] === 'string' ? record.args[0] : null;

  if ([...ids].some((id) => FUEL_TEMPLATE_IDS.has(id))) {
    return TRUSTED_KIND.FUEL;
  }

  if ([...ids].some((id) => TOOL_TEMPLATE_IDS.has(id))) {
    return TRUSTED_KIND.TOOL;
  }

  if ([...ids].some((id) => RESOURCE_TEMPLATE_IDS.has(id))) {
    return TRUSTED_KIND.RESOURCE;
  }

  if ([...ids].some((id) => WORKSTATION_TEMPLATE_IDS.has(id))) {
    return TRUSTED_KIND.WORKSTATION;
  }

  if (ids.has('place.no_item') && is_workstation_item(command_target)) {
    return TRUSTED_KIND.WORKSTATION;
  }

  return null;
}

function resolve_tool_state(context) {
  if (!context?.required?.tool) return 'unknown';
  if (context.availability?.tool_in_inventory === true ||
      context.availability?.tool_equipped === true) {
    return 'available';
  }
  if (context.availability?.tool_in_inventory === false &&
      context.availability?.tool_equipped === false) {
    return 'missing';
  }
  return 'unknown';
}

function resolve_resource_state(context) {
  const required_inputs = [
    ...(context?.required?.crafting_inputs ?? []),
    ...(context?.required?.smelting_inputs ?? []),
  ];
  if (required_inputs.length === 0) return 'unknown';
  return (context?.availability?.missing_inputs ?? []).length > 0 ?
      'missing' :
      'available';
}

function resolve_fuel_state(context) {
  const required_fuel = context?.required?.fuel_inputs ?? [];
  if (required_fuel.length === 0) return 'unknown';
  return (context?.availability?.missing_fuel ?? []).length > 0 ?
      'missing' :
      'available';
}

function resolve_workstation_state(context) {
  if (context?.availability?.craftable_now === true ||
      context?.availability?.workstation_in_inventory === true ||
      context?.availability?.workstation_nearby === true) {
    return 'available';
  }

  if (context?.required?.workstation != null &&
      context?.availability?.craftable_now === false &&
      context?.availability?.workstation_in_inventory === false &&
      context?.availability?.workstation_nearby === false) {
    return 'missing';
  }

  return 'unknown';
}

function build_missing_signature(kind, record, candidate) {
  const context = record.dependency_context;
  if (kind === TRUSTED_KIND.TOOL) {
    return context?.required?.tool ?? 'unknown_tool';
  }

  if (kind === TRUSTED_KIND.WORKSTATION) {
    return get_required_workstation(record, candidate) ?? 'unknown_workstation';
  }

  if (kind === TRUSTED_KIND.FUEL) {
    const missing_fuel = context?.availability?.missing_fuel ?? [];
    if (missing_fuel.length > 0) {
      return missing_fuel.map((item) => item.item).join(',');
    }
    const required_fuel = context?.required?.fuel_inputs ?? [];
    return required_fuel.map((item) => item.item).join(',') || 'unknown_fuel';
  }

  const missing_inputs = context?.availability?.missing_inputs ?? [];
  if (missing_inputs.length > 0) {
    return missing_inputs.map((item) => item.item).join(',');
  }
  const required_inputs = [
    ...(context?.required?.crafting_inputs ?? []),
    ...(context?.required?.smelting_inputs ?? []),
  ];
  return required_inputs.map((item) => item.item).join(',') || 'unknown_resource';
}

function build_reason(kind, record, contextState, evidence, candidate) {
  const context = record.dependency_context;
  if (contextState === 'missing') {
    if (kind === TRUSTED_KIND.TOOL) {
      return `required tool "${
          context?.required?.tool}" was absent from inventory and not equipped`;
    }
    if (kind === TRUSTED_KIND.FUEL) {
      return `required fuel was missing: ${
          (context?.availability?.missing_fuel ?? [])
              .map((item) => `${item.item} (-${item.missing})`)
              .join(', ')}`;
    }
    if (kind === TRUSTED_KIND.RESOURCE) {
      return `required inputs were missing: ${
          (context?.availability?.missing_inputs ?? [])
              .map((item) => `${item.item} (-${item.missing})`)
              .join(', ')}`;
    }
    return `required workstation "${
        get_required_workstation(record, candidate)}" was neither nearby nor in inventory`;
  }

  if (contextState === 'available') {
    if (kind === TRUSTED_KIND.WORKSTATION &&
        context?.availability?.craftable_now === true) {
      return 'task was already craftable at failure time, so the workstation cue was transient';
    }
    return `required ${kind} was already available at failure time`;
  }

  if (evidence?.type === 'later_task_success') {
    return `same task succeeded later at step ${evidence.step_index}`;
  }

  if (evidence?.type === 'local_workstation_recovery') {
    return `local recovery crafted/placed the workstation and succeeded soon after at step ${
        evidence.step_index}`;
  }

  return 'candidate dependency cue could not be confirmed from trusted context';
}

function classify_candidate_record(records, index, record, candidate, kind) {
  const context = record.dependency_context ?? null;
  const later_task_success = find_later_success_in_task(records, index, record);
  const local_workstation_recovery =
      kind === TRUSTED_KIND.WORKSTATION ?
      find_local_workstation_recovery(records, index, record, candidate) :
      null;

  let context_state = 'unknown';
  if (kind === TRUSTED_KIND.TOOL) {
    context_state = resolve_tool_state(context);
  } else if (kind === TRUSTED_KIND.RESOURCE) {
    context_state = resolve_resource_state(context);
  } else if (kind === TRUSTED_KIND.FUEL) {
    context_state = resolve_fuel_state(context);
  } else if (kind === TRUSTED_KIND.WORKSTATION) {
    context_state = resolve_workstation_state(context);
  }

  let status = EVENT_STATUS.AMBIGUOUS;
  let evidence = null;

  if (context_state === 'missing') {
    status = EVENT_STATUS.CONFIRMED_MISSING;
  } else if (context_state === 'available') {
    status = EVENT_STATUS.SUPPRESSED_TRANSIENT;
  } else if (later_task_success) {
    status = EVENT_STATUS.SUPPRESSED_TRANSIENT;
    evidence = {
      type: 'later_task_success',
      step_index: later_task_success.step_index,
      command: later_task_success.command,
    };
  } else if (local_workstation_recovery) {
    status = EVENT_STATUS.SUPPRESSED_TRANSIENT;
    evidence = {
      type: 'local_workstation_recovery',
      step_index: local_workstation_recovery.step_index,
      command: local_workstation_recovery.command,
    };
  }

  const missing_signature = build_missing_signature(kind, record, candidate);
  const incident_key = [
    record.task_record_id ?? `${record.source_file}#history`,
    kind,
    missing_signature,
  ].join('::');

  return {
    event_id: `${record.record_id}::${kind}`,
    record_id: record.record_id,
    task_record_id: record.task_record_id,
    source_file: record.source_file,
    task_target_item: record.task?.target_item ?? null,
    task_action_type: record.task?.action_type ?? null,
    step_index: record.step_index,
    command: record.command,
    action_name: record.actionName,
    result_success: record.result?.success ?? null,
    dependency_kind: kind,
    status,
    reason: build_reason(kind, record, context_state, evidence, candidate),
    incident_key,
    missing_signature,
    candidate_template_ids: candidate.candidateTemplateIds,
    extra_candidate_ids: candidate.extraCandidateIds,
    matched_template_ids: candidate.matchedTemplateIds,
    message_excerpt: collapse_whitespace(candidate.rawMessage).slice(0, 400),
    recovery_evidence: evidence,
    dependency_context: record.dependency_context ?? null,
  };
}

export function analyzeTrustedDependencyRecords(records) {
  const normalized_records = records.map((record, index) => ({
    record_id: record.record_id ?? `record_${index + 1}`,
    task_record_id: record.task_record_id ?? null,
    source_file: record.source_file ?? null,
    step_index: record.step_index ?? null,
    command: record.command ?? null,
    actionName: record.actionName ?? extract_command_name(record.command),
    args: record.args ?? extract_command_args(record.command),
    task: record.task ?? null,
    result: record.result ?? {success: null, message: ''},
    dependency_context: record.dependency_context ?? null,
  }));

  const events = [];
  for (let index = 0; index < normalized_records.length; index++) {
    const record = normalized_records[index];
    if (!record.actionName) continue;

    const candidate = detectDependencyCandidate({
      actionName: record.actionName,
      command: record.command,
      result: record.result,
    });
    if (!candidate.isCandidate) continue;

    const kind = infer_candidate_kind(record, candidate);
    if (kind == null) continue;

    events.push(classify_candidate_record(
        normalized_records, index, record, candidate, kind));
  }

  return events;
}

function count_by(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function build_trusted_summary({
  available,
  unavailable_reason = null,
  total_commands = null,
  unparseable_command_records = 0,
  events = [],
} = {}) {
  if (!available) {
    return {
      available: false,
      unavailable_reason,
      source: 'task_traces',
      totalCommands: null,
      dependencyFailures: null,
      dependencyIncidents: null,
      ambiguousEvents: null,
      suppressedTransientEvents: null,
      dependencyErrorRate: null,
      failuresByKind: null,
      unparseable_command_records,
    };
  }

  const confirmed_events =
      events.filter((event) => event.status === EVENT_STATUS.CONFIRMED_MISSING);
  const ambiguous_events =
      events.filter((event) => event.status === EVENT_STATUS.AMBIGUOUS);
  const suppressed_events = events.filter((event) => {
    return event.status === EVENT_STATUS.SUPPRESSED_TRANSIENT;
  });
  const incident_count =
      new Set(confirmed_events.map((event) => event.incident_key)).size;

  return {
    available: true,
    unavailable_reason: null,
    source: 'task_traces',
    totalCommands: total_commands,
    dependencyFailures: confirmed_events.length,
    dependencyIncidents: incident_count,
    ambiguousEvents: ambiguous_events.length,
    suppressedTransientEvents: suppressed_events.length,
    dependencyErrorRate:
        total_commands === 0 ? 0 : confirmed_events.length / total_commands,
    failuresByKind:
        count_by(confirmed_events.map((event) => event.dependency_kind)),
    unparseable_command_records,
  };
}

function render_event_line(event) {
  const location = event.step_index != null ?
      `step ${event.step_index}` :
      'unknown step';
  const task_label =
      event.task_target_item != null ?
      `${event.task_action_type}:${event.task_target_item}` :
      event.action_name;
  return `- [${event.dependency_kind}] ${task_label} ${location}: ${event.reason}\n  Command: ${event.command}\n  Message: ${event.message_excerpt}`;
}

function render_dependency_audit(summary, events) {
  const lines = [
    '# Trusted Dependency Audit',
    '',
    `- Available: ${summary.available}`,
  ];

  if (!summary.available) {
    lines.push(`- Reason: ${summary.unavailable_reason ?? 'unknown'}`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`- Total commands: ${summary.totalCommands}`);
  lines.push(`- Confirmed missing events: ${summary.dependencyFailures}`);
  lines.push(`- Confirmed missing incidents: ${summary.dependencyIncidents}`);
  lines.push(`- Suppressed transient events: ${summary.suppressedTransientEvents}`);
  lines.push(`- Ambiguous events: ${summary.ambiguousEvents}`);
  lines.push(`- Trusted dependency error rate: ${summary.dependencyErrorRate}`);
  lines.push('');

  const sections = [
    [EVENT_STATUS.CONFIRMED_MISSING, 'Confirmed Missing'],
    [EVENT_STATUS.SUPPRESSED_TRANSIENT, 'Suppressed Transient'],
    [EVENT_STATUS.AMBIGUOUS, 'Ambiguous'],
  ];

  for (const [status, title] of sections) {
    lines.push(`## ${title}`);
    const section_events = events.filter((event) => event.status === status);
    if (section_events.length === 0) {
      lines.push('- None');
      lines.push('');
      continue;
    }
    for (const event of section_events) {
      lines.push(render_event_line(event));
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function read_task_trace_records(resultDir) {
  const records = [];
  let has_task_traces = false;
  let missing_dependency_context = false;
  let unparseable_command_records = 0;

  const trace_paths = [...walkFiles(resultDir)]
      .filter((filePath) => path.basename(filePath) === 'full_task_trace.jsonl')
      .sort();

  for (const filePath of trace_paths) {
    has_task_traces = true;
    const lines = fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    lines.forEach((line, lineIndex) => {
      const task_trace = JSON.parse(line);
      const task_record_id = `${filePath}#${lineIndex + 1}`;

      for (const step of task_trace.steps ?? []) {
        if (typeof step.action !== 'string' || !step.action.startsWith('!')) {
          continue;
        }

        const actionName = extract_command_name(step.action);
        if (!actionName || !step.result) {
          unparseable_command_records += 1;
          continue;
        }

        if (step.dependency_context == null) {
          missing_dependency_context = true;
        }

        records.push({
          record_id: `${task_record_id}::${String(step.i)}`,
          task_record_id,
          source_file: filePath,
          step_index: step.i,
          command: step.action,
          actionName,
          args: extract_command_args(step.action),
          task: task_trace.task ?? null,
          result: {
            success: step.result.success ?? null,
            message: step.result.message ?? '',
          },
          dependency_context: step.dependency_context ?? null,
        });
      }
    });
  }

  return {
    has_task_traces,
    missing_dependency_context,
    unparseable_command_records,
    records,
  };
}

export function collectTrustedDependencyMetrics(resultDir) {
  const {
    has_task_traces,
    missing_dependency_context,
    unparseable_command_records,
    records,
  } = read_task_trace_records(resultDir);

  let summary;
  let events = [];

  if (!has_task_traces || records.length === 0) {
    summary = build_trusted_summary({
      available: false,
      unavailable_reason: 'task_traces_unavailable',
      unparseable_command_records,
    });
  } else if (missing_dependency_context) {
    summary = build_trusted_summary({
      available: false,
      unavailable_reason: 'dependency_context_unavailable',
      unparseable_command_records,
    });
  } else {
    events = analyzeTrustedDependencyRecords(records);
    summary = build_trusted_summary({
      available: true,
      total_commands: records.length,
      unparseable_command_records,
      events,
    });
  }

  write_jsonl(path.join(resultDir, 'trusted_dependency_events.jsonl'), events);
  write_text(
      path.join(resultDir, 'dependency_audit.md'),
      render_dependency_audit(summary, events));

  return {
    ...summary,
    events_path: path.join(resultDir, 'trusted_dependency_events.jsonl'),
    audit_path: path.join(resultDir, 'dependency_audit.md'),
  };
}
