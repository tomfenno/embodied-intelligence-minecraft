import fs from 'fs';
import path from 'path';

import {
  classifyCommandResult,
  KIND,
  summarizeDependencyErrors,
  TEMPLATES_BY_ID,
} from '../../src/pipeline/dependency_error_classifier.js';
import {collectTrustedDependencyMetrics} from './trusted_dependency_classifier.js';
import {readJson, walkFiles, writeJson} from './utils.js';

export function collectDependencyMetrics(
    resultDir, {preferTaskTraces = false} = {}) {
  const taskTraceResult = collectTaskTraceCommandRecords(resultDir);
  const historyResult = collectHistoryCommandRecords(resultDir);

  let source = 'history';
  let records = historyResult.records;
  let unparseableCommandRecords = historyResult.unparseableCommandRecords;

  if (preferTaskTraces && taskTraceResult.records.length > 0) {
    source = 'task_traces';
    records = taskTraceResult.records;
    unparseableCommandRecords = taskTraceResult.unparseableCommandRecords;
  } else if (historyResult.records.length === 0 && taskTraceResult.records.length > 0) {
    source = 'task_traces';
    records = taskTraceResult.records;
    unparseableCommandRecords = taskTraceResult.unparseableCommandRecords;
  }

  const classifierSummary = summarizeDependencyErrors(records);
  const legacySummary = {
    source,
    parseable_command_records: records.length,
    unparseable_command_records: unparseableCommandRecords,
    ...classifierSummary,
  };
  const trustedSummary = collectTrustedDependencyMetrics(resultDir);
  const summary = {
    ...legacySummary,
    trusted_dependency_available: trustedSummary.available,
    trusted_dependency_failures:
        trustedSummary.available ? trustedSummary.dependencyFailures : null,
    trusted_dependency_total_commands:
        trustedSummary.available ? trustedSummary.totalCommands : null,
    trusted_dependency_error_rate:
        trustedSummary.available ? trustedSummary.dependencyErrorRate : null,
    trusted_dependency_incidents:
        trustedSummary.available ? trustedSummary.dependencyIncidents : null,
    trusted_dependency_ambiguous_events:
        trustedSummary.available ? trustedSummary.ambiguousEvents : null,
    legacy: legacySummary,
    trusted: trustedSummary,
  };

  writeJson(path.join(resultDir, 'dependency_summary.json'), summary);
  return summary;
}

function collectTaskTraceCommandRecords(resultDir) {
  const records = [];
  let unparseableCommandRecords = 0;

  for (const filePath of walkFiles(resultDir)) {
    if (path.basename(filePath) !== 'full_task_trace.jsonl') continue;

    const lines = fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    for (const line of lines) {
      const taskTrace = JSON.parse(line);
      for (const step of taskTrace.steps ?? []) {
        if (typeof step.action !== 'string' || !step.action.startsWith('!')) {
          continue;
        }

        const actionName = extractActionName(step.action);
        if (!actionName || !step.result) {
          unparseableCommandRecords += 1;
          continue;
        }

        records.push(classifyCommandResult({
          actionName,
          command: step.action,
          result: {
            success: step.result.success,
            message: step.result.message ?? '',
          },
        }));
      }
    }
  }

  return {records, unparseableCommandRecords};
}

function collectHistoryCommandRecords(resultDir) {
  const records = [];
  let unparseableCommandRecords = 0;
  const turns = collectOrderedHistoryTurns(resultDir);

  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (turn?.role !== 'assistant' || typeof turn.content !== 'string') {
      continue;
    }

    const actionName = extractActionName(turn.content);
    if (!actionName) continue;

    let matchedResult = null;
    for (let lookahead = index + 1; lookahead < turns.length; lookahead++) {
      const candidate = turns[lookahead];
      if (!candidate || candidate.role === 'assistant' || candidate.role === 'user') {
        break;
      }
      if (candidate.role !== 'system' || typeof candidate.content !== 'string') {
        continue;
      }
      if (!isCommandResultCandidate(actionName, candidate.content)) {
        continue;
      }
      matchedResult = candidate.content;
      break;
    }

    if (matchedResult == null) {
      unparseableCommandRecords += 1;
      continue;
    }

    const success = inferOfflineSuccess(actionName, matchedResult);
    records.push(classifyCommandResult({
      actionName,
      command: turn.content,
      result: {
        success,
        message: matchedResult,
      },
    }));
  }

  return {records, unparseableCommandRecords};
}

function collectOrderedHistoryTurns(resultDir) {
  const historyPaths = [];
  const memoryPaths = [];

  for (const filePath of walkFiles(resultDir)) {
    if (path.extname(filePath) !== '.json') continue;
    if (filePath.includes(`${path.sep}histories${path.sep}`)) {
      historyPaths.push(filePath);
      continue;
    }
    if (path.basename(filePath) === 'memory.json' &&
        filePath.includes(`${path.sep}agent_artifacts${path.sep}`)) {
      memoryPaths.push(filePath);
    }
  }

  historyPaths.sort();
  memoryPaths.sort();

  const turns = [];
  for (const filePath of historyPaths) {
    turns.push(...readTurnsFromArtifact(filePath));
  }
  for (const filePath of memoryPaths) {
    turns.push(...readTurnsFromArtifact(filePath));
  }

  return turns;
}

function readTurnsFromArtifact(filePath) {
  try {
    const data = readJson(filePath);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && Array.isArray(data.turns)) {
      return data.turns;
    }
  } catch {
    return [];
  }
  return [];
}

function extractActionName(commandText) {
  const match = String(commandText).match(/!\w+/);
  return match ? match[0] : null;
}

function isCommandResultCandidate(actionName, content) {
  const classification = classifyCommandResult({
    actionName,
    command: actionName,
    result: {success: null, message: content},
  });
  return classification.matchedTemplateIds.length > 0 ||
      content.startsWith('Action output') ||
      content.startsWith('\n');
}

function inferOfflineSuccess(actionName, message) {
  const classification = classifyCommandResult({
    actionName,
    command: actionName,
    result: {success: null, message},
  });
  const kinds = new Set(
      classification.matchedTemplateIds
          .map((templateId) => TEMPLATES_BY_ID[templateId]?.kind)
          .filter(Boolean));

  if (message === '') return false;

  if ([...kinds].some((kind) => {
    return kind === KIND.PARSE_ERROR || kind === KIND.AGENT_EXCEPTION ||
        kind === KIND.AGENT_LOOP || kind.startsWith('dependency_');
  })) {
    return false;
  }

  if (kinds.has(KIND.SUCCESS) || kinds.has(KIND.PARTIAL_SUCCESS)) {
    return true;
  }

  if (kinds.size > 0 && [...kinds].every((kind) => {
    return kind === KIND.INFO || kind === KIND.QUERY_RESULT ||
        kind === KIND.META || kind === KIND.AGENT_STATE;
  })) {
    return true;
  }

  return null;
}
