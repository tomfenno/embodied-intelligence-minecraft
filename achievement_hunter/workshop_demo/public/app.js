mermaid.initialize({startOnLoad: false, theme: 'dark'});

const selectionView = document.getElementById('selection-view');
const statusView = document.getElementById('status-view');
const ptdGrid = document.getElementById('ptd-grid');
const statusObjective = document.getElementById('status-objective');
const statusLabel = document.getElementById('status-label');
const statusDetail = document.getElementById('status-detail');
const spectatorDetail = document.getElementById('spectator-detail');
const backButton = document.getElementById('back-button');

const SPECTATOR_TEXT = {
  idle: '',
  launching: 'Launching Prism Launcher for the spectator view…',
  joined: 'Spectator connected — watching AH_Bot.',
  timeout: 'Spectator client didn’t join in time — join manually if needed.',
  skipped: 'Spectator auto-join skipped (Prism not configured on this machine).',
  error: 'Spectator auto-join failed.',
};

function spectatorDetailText(spectator) {
  const status = spectator?.status || 'idle';
  if (status === 'joined' && !spectator.spectating) {
    return spectator.spectate_error ?
        'Spectator connected, but couldn’t auto-follow AH_Bot — free-fly in spectator mode instead.' :
        'Spectator connected — waiting for AH_Bot to spawn…';
  }
  return SPECTATOR_TEXT[status] || '';
}

const liveDashboard = document.getElementById('live-dashboard');
const liveGraph = document.getElementById('live-graph');
const liveElapsed = document.getElementById('live-elapsed');
const liveStatusBadge = document.getElementById('live-status-badge');
const liveTask = document.getElementById('live-task');
const liveAction = document.getElementById('live-action');

const STATUS_TEXT = {
  idle: 'Idle',
  launching_world: 'Launching world…',
  starting_agent: 'Starting agent…',
  injecting_objective: 'Sending objective…',
  running: 'Running',
  error: 'Error',
};

let pollTimer = null;
let mermaidCounter = 0;
let lastLiveMermaidSource = null;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

async function loadPtds() {
  const res = await fetch('/api/ptds');
  const ptds = await res.json();

  ptdGrid.innerHTML = '';
  for (const ptd of ptds) {
    const card = document.createElement('div');
    card.className = 'ptd-card';
    card.innerHTML =
        `<h3>${ptd.objective}</h3><div class="mermaid"></div>`;
    card.addEventListener('click', () => startRun(ptd.filename));
    ptdGrid.appendChild(card);
    renderMermaid(ptd.filename, ptd.mermaid, card.querySelector('.mermaid'));
  }
}

async function renderMermaid(key, source, container) {
  try {
    const {svg} = await mermaid.render(`mermaid-${mermaidCounter++}`, source);
    container.innerHTML = svg;
  } catch (err) {
    container.textContent = 'Preview unavailable';
    console.error('mermaid render failed for', key, err);
  }
}

async function startRun(filename) {
  selectionView.classList.add('hidden');
  statusView.classList.remove('hidden');
  statusLabel.classList.remove('error');
  statusObjective.textContent = '';
  statusLabel.textContent = 'Starting…';
  statusDetail.textContent = '';
  liveDashboard.classList.add('hidden');
  lastLiveMermaidSource = null;

  const res = await fetch('/api/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({filename}),
  });
  const status = await res.json();

  if (!res.ok) {
    statusLabel.textContent = 'Error';
    statusLabel.classList.add('error');
    statusDetail.textContent = status.error || 'Unknown error';
    return;
  }

  renderStatus(status);
  pollTimer = setInterval(tick, 1000);
}

async function tick() {
  await pollStatus();
  await pollLive();
}

async function pollStatus() {
  const res = await fetch('/api/status');
  renderStatus(await res.json());
}

async function pollLive() {
  const res = await fetch('/api/live');
  const live = await res.json();
  if (live) renderLive(live);
}

function renderStatus(status) {
  statusObjective.textContent = status.objective || '';
  statusLabel.textContent = STATUS_TEXT[status.status] || status.status;
  statusLabel.classList.toggle('error', status.status === 'error');

  if (status.status === 'error') {
    statusDetail.textContent = status.error || '';
    stopPolling();
  } else if (status.status === 'running') {
    const world =
        status.world ? `${status.world.host}:${status.world.port}` : '';
    statusDetail.textContent = world ? `World live at ${world}` : '';
  } else {
    statusDetail.textContent = '';
  }

  spectatorDetail.textContent = spectatorDetailText(status.spectator);
}

function renderLive(live) {
  liveDashboard.classList.remove('hidden');

  liveElapsed.textContent = live.elapsed || '';
  const completed = live.status === 'completed';
  liveStatusBadge.textContent = completed ? 'Completed' : 'Running';
  liveStatusBadge.classList.toggle('completed', completed);

  if (live.mermaid && live.mermaid !== lastLiveMermaidSource) {
    lastLiveMermaidSource = live.mermaid;
    mermaid.render(`live-mermaid-${mermaidCounter++}`, live.mermaid)
        .then(({svg}) => {
          liveGraph.innerHTML = svg;
        })
        .catch((err) => console.error('live mermaid render failed', err));
  }

  if (live.task) {
    const t = live.task;
    liveTask.innerHTML = `<div class="task-line"><strong>${
        escapeHtml(t.action_type)}</strong> ${escapeHtml(t.target_item)} ×${
        escapeHtml(t.qty)}</div>`;
  } else {
    liveTask.innerHTML = '<div class="muted">No task selected yet.</div>';
  }

  if (live.action) {
    liveAction.innerHTML = `<div class="action-line"><code>${
        escapeHtml(live.action.raw)}</code> <span class="muted">(attempt ${
        escapeHtml(live.action.attempt)})</span></div>`;
  } else {
    liveAction.innerHTML = '<div class="muted">No action executed yet.</div>';
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

backButton.addEventListener('click', () => {
  stopPolling();
  // Switch views immediately rather than waiting on teardown to finish —
  // stopping the world/agent can take a few seconds, and startRun() already
  // awaits its own stopRun() before launching the next world, so there's no
  // correctness reason to block the UI on this too.
  statusView.classList.add('hidden');
  liveDashboard.classList.add('hidden');
  selectionView.classList.remove('hidden');
  fetch('/api/stop', {method: 'POST'})
      .catch((err) => console.error('stop request failed', err));
});

loadPtds();
