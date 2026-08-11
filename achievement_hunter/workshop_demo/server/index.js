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

// Augments the base PTD diagram with two extra style layers the static
// catalog preview doesn't have: the in-progress node (blue) and nodes the
// SCSG no longer lists as remaining, i.e. already satisfied (dimmed).
function render_live_mermaid(graph, currentNodeId, remainingIds) {
  let mermaid = strip_mermaid_fence(graph_to_mermaid(graph));

  if (remainingIds) {
    const remaining = new Set(remainingIds);
    for (const vertex of graph.vertices) {
      if (vertex.id === currentNodeId || remaining.has(vertex.id)) continue;
      mermaid += `\n    style ${safe_mermaid_id(vertex.id)} fill:#2d333b,color:#6e7681,stroke:#484f58`;
    }
  }

  if (currentNodeId) {
    mermaid += `\n    style ${safe_mermaid_id(currentNodeId)} fill:#2196F3,color:#fff,stroke:#1565C0`;
  }

  return mermaid;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
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
      mermaid: strip_mermaid_fence(graph_to_mermaid(graph)),
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
  const graph = raw.ptd?.parsed ?? null;
  const lastAction = raw.am_history?.length ?
      raw.am_history[raw.am_history.length - 1] :
      null;

  res.json({
    objective: raw.objective,
    status: raw.status,
    elapsed: raw.elapsed,
    mermaid: graph ? render_live_mermaid(graph, currentNodeId, remainingIds) : null,
    task: raw.task_state?.task ?? null,
    action: lastAction,
    completion: raw.completion,
  });
});

app.listen(DASHBOARD_PORT, () => {
  console.log(`Workshop demo dashboard: http://localhost:${DASHBOARD_PORT}`);
});
