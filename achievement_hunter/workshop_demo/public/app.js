mermaid.initialize({startOnLoad: false, theme: 'dark'});

const pageHeader = document.getElementById('page-header');
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
  joined: '',
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
const graphPanel = document.getElementById('graph-panel');
const recoveryPanel = document.getElementById('recovery-panel');
const recoveryTitle = document.getElementById('recovery-title');
const recoveryAttempt = document.getElementById('recovery-attempt');
const recoveryContext = document.getElementById('recovery-context');
const recoveryNote = document.getElementById('recovery-note');
const recoveryActions = document.getElementById('recovery-actions');

const RECOVERY_STATUS_ICON = {pending: '⏳', success: '✅', fail: '❌'};

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
  pageHeader.classList.add('hidden');
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
  } else {
    statusDetail.textContent = '';
  }

  spectatorDetail.textContent = spectatorDetailText(status.spectator);
}

function renderLive(live) {
  liveDashboard.classList.remove('hidden');

  // The graph keeps rendering even while the recovery panel is the one
  // showing, so switching back the instant recovery ends is instant too —
  // no stale/blank flash while mermaid re-renders.
  if (live.mermaid && live.mermaid !== lastLiveMermaidSource) {
    lastLiveMermaidSource = live.mermaid;
    mermaid.render(`live-mermaid-${mermaidCounter++}`, live.mermaid)
        .then(({svg}) => {
          liveGraph.innerHTML = svg;
        })
        .catch((err) => console.error('live mermaid render failed', err));
  }

  if (live.recovery) {
    graphPanel.classList.add('hidden');
    renderRecovery(live.recovery);
  } else {
    recoveryPanel.classList.add('hidden');
    graphPanel.classList.remove('hidden');
  }
}

// Failure recovery and search recovery are mutually exclusive in
// achievement_hunter's own pipeline (confirmed against the actual call
// graph, not just the naming — see PLAN.md), and server/index.js already
// normalizes whichever is active into one shape here, tagged by `kind` for
// the color accent (see .recovery-panel--failure/--search in styles.css).
// Built via DOM APIs rather than innerHTML string interpolation since
// `note`/`command`/`message` are LLM-generated text, not something to
// trust as markup.
function renderRecovery(recovery) {
  recoveryPanel.classList.remove(
      'hidden', 'recovery-panel--failure', 'recovery-panel--search');
  recoveryPanel.classList.add(`recovery-panel--${recovery.kind}`);

  recoveryTitle.textContent = recovery.label;
  recoveryAttempt.textContent = recovery.priorAttempts > 0 ?
      `Attempt ${recovery.attemptNumber} · ${recovery.priorAttempts} earlier attempt${
          recovery.priorAttempts === 1 ? '' : 's'}` :
      `Attempt ${recovery.attemptNumber}`;
  recoveryContext.textContent = recovery.context || '';
  recoveryNote.textContent = recovery.note || '';

  recoveryActions.innerHTML = '';
  for (const action of recovery.actions) {
    const row = document.createElement('div');
    row.className = `recovery-action recovery-action--${action.status}`;

    const icon = document.createElement('span');
    icon.className = 'recovery-action-icon';
    icon.textContent = RECOVERY_STATUS_ICON[action.status] || '';
    row.appendChild(icon);

    const code = document.createElement('code');
    code.textContent = action.command;
    row.appendChild(code);

    if (action.message) {
      const message = document.createElement('span');
      message.className = 'recovery-action-message';
      message.textContent = ` — ${action.message}`;
      row.appendChild(message);
    }

    recoveryActions.appendChild(row);
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
  pageHeader.classList.remove('hidden');
  fetch('/api/stop', {method: 'POST'})
      .catch((err) => console.error('stop request failed', err));
});

loadPtds();
