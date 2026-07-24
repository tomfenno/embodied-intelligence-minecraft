import path from 'path';
import { writeFileSync } from 'fs';

import { LlmClient } from '../../../achievement_hunter/src/pipeline/llm_client.js';
import { extract_json } from '../../../achievement_hunter/src/pipeline/json_utils.js';
import { getCommandDocs } from '../../../src/agent/commands/index.js';
import { fill_ptd_prompt } from './prompt_utils.js';

const FALLBACK_MODEL = 'gpt-4o-mini'; // used only if the coordinator's own profile omits "model"

// One-shot for now: generate, validate, log, persist. No retry-on-invalid
// yet — that's deliberately deferred until the prototype is working
// end-to-end (see colab_agent/docs/08-phase-1-world-state-document.md-style
// doc for Phase 2, once written).
export async function generatePTD(agent, worldStateDoc, runDir) {
  const llm = new LlmClient(agent.prompter.profile.model || FALLBACK_MODEL);
  const commandDocs = getCommandDocs({ blocked_actions: [] });

  console.log(`[PTD] generating task graph for ${agent.name}`);
  let graph = null;
  let status;
  let summary;
  try {
    const raw = await llm.send_prompt(fill_ptd_prompt(worldStateDoc, commandDocs));
    const parsed = parsePTD(raw);
    if (!parsed.summary) throw new Error('Response missing "summary" field');

    // summary is narrative-only, kept out of the persisted graph the same
    // way world_state.json never carries Phase 1's summary field either —
    // ptd.json's schema stays exactly what's documented.
    summary = parsed.summary;
    delete parsed.summary;
    graph = parsed;

    const validation = validatePTD(graph);
    if (validation.valid) {
      console.log('[PTD] structural validation passed');
      status = 'complete';
    } else {
      console.warn(`[PTD] structural validation failed: ${validation.errors.join('; ')}`);
      status = 'invalid';
    }
  } catch (err) {
    console.error('[PTD] generation failed:', err.message);
    status = 'error';
    summary = `Phase 2 ended in error: ${err.message}`;
  }

  if (graph) {
    const ptdPath = path.join(runDir, 'ptd.json');
    writeFileSync(ptdPath, JSON.stringify(graph, null, 2));
    console.log(`[PTD] task graph written to ${ptdPath}`);
  }

  // Same memoryLog/memory.json Phase 1 writes to — this is what closes the
  // gap where Phase 2 previously left agent.memoryLog with only Phase 1's
  // entry regardless of how the rest of the episode went.
  agent.memoryLog = agent.memoryLog || [];
  const memoryEntry = { phase: 'phase_2', status, summary };
  agent.memoryLog.push(memoryEntry);
  writeFileSync(path.join(runDir, 'memory.json'), JSON.stringify(agent.memoryLog, null, 2));
  console.log(`[PTD] memory recorded: ${summary}`);

  // summary is returned alongside graph (not just logged) because Phase 3
  // reuses it verbatim as the opening line of andy's execution goal text —
  // see colab_agent/src/pipeline/execution.js. status lets the caller
  // distinguish "invalid" (graph exists, still written to disk for
  // debugging, but failed validatePTD) from "complete" without relying on
  // truthiness of graph.
  return { graph, summary, status };
}

function parsePTD(raw) {
  if (!raw) throw new Error('LLM returned no response');
  const parsed = extract_json(raw);
  if (!parsed) throw new Error('Could not extract a JSON object from the LLM response');
  return parsed;
}

// Same checks run manually against the first test graph, now real code:
// unique ids, no dangling/duplicate edges, sinks have no outgoing edges,
// acyclic. Reports what's wrong rather than throwing — validation failures
// are logged, not retried, for this prototype.
function validatePTD(graph) {
  const errors = [];
  if (!graph || !Array.isArray(graph.vertices) || !Array.isArray(graph.edges) || !Array.isArray(graph.sinks)) {
    return { valid: false, errors: ['missing vertices/edges/sinks arrays'] };
  }

  const ids = new Set(graph.vertices.map(v => v.id));
  if (ids.size !== graph.vertices.length) errors.push('duplicate vertex ids');

  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push(`edge references missing vertex: ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge references missing vertex: ${e.to}`);
  }

  const edgeKeys = graph.edges.map(e => `${e.from}->${e.to}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) errors.push('duplicate edges');

  for (const sink of graph.sinks) {
    if (graph.edges.some(e => e.from === sink)) errors.push(`sink has outgoing edge: ${sink}`);
  }

  const adjacency = {};
  for (const v of graph.vertices) adjacency[v.id] = [];
  for (const e of graph.edges) {
    if (adjacency[e.from]) adjacency[e.from].push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const v of graph.vertices) color[v.id] = WHITE;
  let hasCycle = false;
  function visit(u) {
    color[u] = GRAY;
    for (const v of adjacency[u] || []) {
      if (color[v] === GRAY) hasCycle = true;
      else if (color[v] === WHITE) visit(v);
    }
    color[u] = BLACK;
  }
  for (const v of graph.vertices) if (color[v.id] === WHITE) visit(v.id);
  if (hasCycle) errors.push('graph contains a cycle');

  return { valid: errors.length === 0, errors };
}
