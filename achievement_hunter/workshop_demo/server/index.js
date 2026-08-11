// Workshop demo dashboard server: PTD selection + run orchestration + live
// rollout view.

import {existsSync, readFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import express from 'express';

import {graph_to_mermaid} from '../../src/pipeline/graph_utils.js';
import {DASHBOARD_PORT} from './config.js';
import * as orchestrator from './orchestrator.js';
import {listPtdFiles, objectiveFromPtdFilename, ptdFilePath} from './ptd_catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Written by rollout_logger.js's render_live() when AH_ENABLE_LIVE_VIEWER is
// set — see achievement_hunter/workshop_demo/PLAN.md, Phase 3.
const LIVE_JSON_PATH =
    path.join(__dirname, '../../rollout_live/current_rollout.json');

// graph_to_mermaid() wraps its output in a ```mermaid fenced code block for
// markdown rendering elsewhere (rollout_logger.js); the browser mermaid.js
// runtime wants just the raw diagram source.
function strip_mermaid_fence(fenced) {
  return fenced.replace(/^```mermaid\n/, '').replace(/\n```$/, '');
}

// Matches graph_utils.js's private _safe_id() — mermaid node ids can't
// contain arbitrary characters, so vertex ids get sanitized the same way
// there and here.
function safe_mermaid_id(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

// Fill color key — must match public/index.html's legend and
// public/styles.css's .legend-swatch.* classes. Mutually exclusive per
// node (a node is in exactly one of these states), precedence low to high:
// goal < remaining < done < current. (done and remaining can't both apply
// to the same node by construction — a node is either in the SCSG's
// remaining set or it isn't — so their relative order doesn't matter.)
const STATE_COLOR = {
  goal: {fill: '#4CAF50', color: '#fff', stroke: '#388E3C'},
  remaining: {fill: '#FF9800', color: '#fff', stroke: '#E65100'},
  current: {fill: '#2196F3', color: '#fff', stroke: '#1565C0'},
  done: {fill: '#2d333b', color: '#6e7681', stroke: '#484f58'},
};

// "Candidate" (in the next-task-selector's current shortlist) is
// deliberately NOT its own fill color — a fifth exclusive color would hide
// whether a candidate is also the goal, or already the active task, which
// was the actual complaint: it wasn't obvious when the current action or a
// goal node was also a candidate, because candidate's own fill silently
// replaced whichever fill was already there. Instead it's a thick border
// overlay independent of fill, so e.g. "goal AND candidate" renders as
// green fill + white ring, not a fifth unrelated color.
const CANDIDATE_STROKE = {color: '#FFFFFF', width: '4px'};

// Augments the base PTD diagram with the live-run style layers the static
// catalog preview doesn't have. Computes one merged style per node (fill
// from STATE_COLOR, optionally overlaid with CANDIDATE_STROKE) rather than
// appending independent per-category style lines — mermaid's `style`
// directive fully replaces on repeat for the same node id, it doesn't
// merge, so appending separate lines per category would make later
// categories silently erase earlier ones instead of combining.
function render_live_mermaid(graph, currentNodeId, remainingIds, candidateIds) {
  let mermaid = strip_mermaid_fence(graph_to_mermaid(graph, 'TD'));
  const sinks = new Set(graph.sinks || []);
  const remaining = remainingIds ? new Set(remainingIds) : null;
  const candidates = new Set(candidateIds || []);

  for (const vertex of graph.vertices) {
    const isCurrent = vertex.id === currentNodeId;
    const isDone = remaining ? !remaining.has(vertex.id) && !isCurrent : false;

    let state;
    if (isCurrent) {
      state = STATE_COLOR.current;
    } else if (isDone) {
      state = STATE_COLOR.done;
    } else if (sinks.has(vertex.id)) {
      state = STATE_COLOR.goal;
    } else if (remaining?.has(vertex.id)) {
      state = STATE_COLOR.remaining;
    } else {
      continue; // no live state yet for this vertex — leave mermaid default
    }

    const isCandidate = candidates.has(vertex.id) && !isDone;
    const stroke = isCandidate ? CANDIDATE_STROKE.color : state.stroke;
    const strokeWidth = isCandidate ? CANDIDATE_STROKE.width : '1px';

    mermaid += `\n    style ${safe_mermaid_id(vertex.id)} fill:${
        state.fill},color:${state.color},stroke:${stroke},stroke-width:${
        strokeWidth}`;
  }

  return mermaid;
}

const app = express();
app.use(express.json());
// no-store: this UI is actively iterated on, and a stale cached copy of
// index.html/app.js/styles.css after an edit is confusing to debug (looks
// like the change didn't take effect). The mermaid vendor bundle below is
// static and large, so it's left with normal caching.
app.use(express.static(
    path.join(__dirname, '../public'),
    {setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')}));
app.use(
    '/vendor/mermaid',
    express.static(
        path.join(__dirname, '../../../node_modules/mermaid/dist')));

app.get('/api/ptds', (req, res) => {
  const ptds = listPtdFiles().map((filename) => {
    const graph = JSON.parse(readFileSync(ptdFilePath(filename), 'utf8'));
    return {
      filename,
      objective: objectiveFromPtdFilename(filename),
      mermaid: strip_mermaid_fence(graph_to_mermaid(graph, 'TD')),
    };
  });
  res.json(ptds);
});

app.post('/api/start', async (req, res) => {
  const filename = req.body?.filename;
  if (!filename) {
    res.status(400).json({error: 'filename is required'});
    return;
  }
  try {
    res.json(await orchestrator.startRun(filename));
  } catch (err) {
    res.status(400).json({error: err.message});
  }
});

app.post('/api/stop', async (req, res) => {
  await orchestrator.stopRun();
  res.json(orchestrator.getStatus());
});

app.get('/api/status', (req, res) => {
  res.json(orchestrator.getStatus());
});

app.get('/api/live', (req, res) => {
  if (!existsSync(LIVE_JSON_PATH)) {
    res.json(null);
    return;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(LIVE_JSON_PATH, 'utf8'));
  } catch {
    // Rare mid-write race (file read between rollout_logger's write calls);
    // the next poll a second later will see a consistent file.
    res.json(null);
    return;
  }

  const currentNodeId = raw.task_state?.task?.target_item ?? null;
  const remainingIds = raw.scsg_result?.final?.vertices?.map((v) => v.id) ?? null;
  const candidateIds = raw.candidates?.map((c) => c.id) ?? null;
  const graph = raw.ptd?.parsed ?? null;

  res.json({
    mermaid: graph ?
        render_live_mermaid(graph, currentNodeId, remainingIds, candidateIds) :
        null,
  });
});

app.listen(DASHBOARD_PORT, () => {
  console.log(`Workshop demo dashboard: http://localhost:${DASHBOARD_PORT}`);
});

// The world/agent child processes orchestrator.js spawns are launched
// detached (their own process group, so stopRun() can kill each one's
// whole tree independently) — which also means Ctrl+C's SIGINT never
// reaches them, only this process. Without this handler, Ctrl+C kills the
// dashboard while Minecraft and the agent keep running orphaned in the
// background (the same failure mode orphan_guard.js cleans up on the
// *next* startup, but nothing previously prevented it from happening in
// the first place).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, tearing down the current run...`);
  await orchestrator.stopRun();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
