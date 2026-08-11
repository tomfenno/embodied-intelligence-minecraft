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

// Color/precedence key — must match public/index.html's legend and
// public/styles.css's .legend-swatch.* classes:
//   goal      #4CAF50  applied by graph_to_mermaid() itself (graph.sinks)
//   remaining #FF9800  in the current SCSG's remaining set (still relevant)
//   candidate #9C27B0  in the next-task-selector's current candidate list
//   current   #2196F3  the task actively being worked right now
//   done      #2d333b  dropped out of the SCSG's remaining set (satisfied)
//
// Precedence, low to high (later `style` lines win ties in mermaid): goal <
// remaining < candidate < current. Goal is deliberately never overridden by
// remaining/candidate (so the target node stays visually anchored while
// pending) but IS overridden by done/current — once truly finished or while
// it's the active target, that takes priority over "it's the goal".
const NODE_COLOR = {
  remaining: 'fill:#FF9800,color:#fff,stroke:#E65100',
  candidate: 'fill:#9C27B0,color:#fff,stroke:#6A1B9A',
  current: 'fill:#2196F3,color:#fff,stroke:#1565C0',
  done: 'fill:#2d333b,color:#6e7681,stroke:#484f58',
};

// Augments the base PTD diagram with the live-run style layers the static
// catalog preview doesn't have — see NODE_COLOR above for what each means.
function render_live_mermaid(graph, currentNodeId, remainingIds, candidateIds) {
  let mermaid = strip_mermaid_fence(graph_to_mermaid(graph, 'TD'));
  const sinks = new Set(graph.sinks || []);
  const style = (id, rule) => {
    mermaid += `\n    style ${safe_mermaid_id(id)} ${rule}`;
  };

  if (remainingIds) {
    const remaining = new Set(remainingIds);
    for (const vertex of graph.vertices) {
      if (vertex.id === currentNodeId) continue;
      if (!remaining.has(vertex.id)) {
        style(vertex.id, NODE_COLOR.done);
      } else if (!sinks.has(vertex.id)) {
        style(vertex.id, NODE_COLOR.remaining);
      }
    }
  }

  if (candidateIds) {
    for (const id of candidateIds) {
      if (id === currentNodeId || sinks.has(id)) continue;
      style(id, NODE_COLOR.candidate);
    }
  }

  if (currentNodeId) {
    style(currentNodeId, NODE_COLOR.current);
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
    objective: raw.objective,
    status: raw.status,
    elapsed: raw.elapsed,
    mermaid: graph ?
        render_live_mermaid(graph, currentNodeId, remainingIds, candidateIds) :
        null,
    completion: raw.completion,
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
