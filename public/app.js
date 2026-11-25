
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let state = {
  projects: [],
  missions: [],
  machines: [],
  logs: []
};

const projectInfo = new Map();

function pad(n) {
  return String(n).padStart(2, '0');
}

function timeAgo(iso) {
  if (!iso) return 'Unknown';

  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;

  if (!Number.isFinite(seconds)) return 'Unknown';
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

  return new Date(iso).toLocaleDateString();
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');

  setTimeout(() => element.classList.remove('show'), 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const raw = await response.text();
  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw || 'Invalid server response' };
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

async function refresh() {
  const data = await api('/api/state');

  state = {
    projects: Array.isArray(data.projects) ? data.projects : [],
    missions: Array.isArray(data.missions) ? data.missions : [],
    machines: Array.isArray(data.machines) ? data.machines : [],
    logs: Array.isArray(data.logs) ? data.logs : []
  };

  // Remove cached information for deleted projects.
  const activeIds = new Set(state.projects.map(project => project.id));

  for (const id of projectInfo.keys()) {
    if (!activeIds.has(id)) projectInfo.delete(id);
  }

  render();
}

function getProjectMeta(project) {
  return {
    ...project,
    ...(projectInfo.get(project.id) || {})
  };
}

function getStackLabel(project) {
  const stack = project.stack || project.detectedStack || 'Not scanned';

  if (Array.isArray(stack)) return stack.join(' / ');
  if (typeof stack === 'object') {
    return stack.name || stack.type || 'Detected';
  }

  return String(stack);
}

function getGitStatus(project) {
  const value = project.git ?? project.hasGit ?? project.isGit;

  if (value === true) return 'GIT READY';
  if (value === false) return 'NO GIT';

  return 'GIT UNKNOWN';
}

function render() {
  const { projects, missions, machines, logs } = state;

  $('#statMissions').textContent = pad(missions.length);
  $('#statQueued').textContent = pad(
    missions.filter(mission => mission.status === 'queued').length
  );
  $('#statProjects').textContent = pad(projects.length);
  $('#statMachines').textContent = pad(machines.length);
  $('#missionNavCount').textContent = missions.length;

  // Mission board
  const missionList = $('#missionList');

  if (!missions.length) {
    missionList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">◈</div>
        No missions yet.<br>
        Queue your first task to get started.
      </div>`;
  } else {
    missionList.innerHTML = missions.slice(0, 20).map(mission => {
      const projectName =
        projects.find(project => project.id === mission.projectId)?.name ||
        'Unassigned project';

      return `
        <div class="mission-row">
          <span class="mission-marker ${esc(mission.status)}"></span>

          <div class="mission-main">
            <div class="mission-title">${esc(mission.title)}</div>
            <div class="mission-meta">
              ${esc(timeAgo(mission.createdAt))} · ${esc(projectName)}
            </div>
          </div>

          <span class="mission-status">${esc(mission.status)}</span>

          <div class="mission-actions">
            <button
              class="ghost small"
              data-run="${esc(mission.id)}"
              ${mission.status === 'running' ? 'disabled' : ''}
            >
              ${mission.status === 'running' ? 'Running…' : '▶ Run'}
            </button>

            ${mission.status === 'running' ? `
              <button class="ghost small" data-stop="${esc(mission.id)}">
                Stop
              </button>` : ''}

            <select
              data-mission="${esc(mission.id)}"
              aria-label="Change mission status"
            >
              <option value="">Move…</option>
              <option value="queued">Queued</option>
              <option value="review">Review</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>

        ${mission.output ? `
          <pre class="mission-output">${esc(mission.output.slice(-5000))}</pre>
        ` : ''}
      `;
    }).join('');
  }

  // Machines
  $('#machineList').innerHTML = machines.map(machine => `
    <div class="machine-card">
      <div class="machine-icon">⌘</div>
      <div>
        <div class="machine-title">${esc(machine.name)}</div>
        <div class="machine-meta">
          ${esc((machine.type || 'machine').toUpperCase())}
          · ${esc((machine.status || 'unknown').toUpperCase())}
        </div>
      </div>
    </div>
  `).join('');

  // Activity log
  $('#activityList').innerHTML = logs.slice(0, 8).map(log => `
    <div class="activity-item">
      <span class="activity-time">${esc(timeAgo(log.time))}</span>
      <span class="activity-level">${esc(log.level)}</span>
      <span class="activity-message">${esc(log.message)}</span>
    </div>
  `).join('') || '<div class="empty-state">No events yet.</div>';

  // Projects
  $('#projectList').innerHTML = projects.map(project => {
    const meta = getProjectMeta(project);
    const stack = getStackLabel(meta);
    const git = getGitStatus(meta);

    return `
      <div class="project-card">
        <strong>${esc(project.name)}</strong>

        <p>${esc(project.description || 'No description provided.')}</p>

        <div class="project-tags">
          <span class="project-tag">${esc(stack)}</span>
          <span class="project-tag">${esc(git)}</span>
        </div>

        <small>
          CREATED ${esc(
            project.createdAt
              ? new Date(project.createdAt).toLocaleDateString()
              : 'UNKNOWN'
          )}
        </small>

        <div class="project-actions">

          <button
            class="ghost small"
            data-browse="${esc(project.id)}"
          >
            Browse
          </button>

          <button
            class="ghost small"
            data-scan="${esc(project.id)}"
          >
            Scan
          </button>

          <button
            class="ghost small"
            data-git-status="${esc(project.id)}"
          >
            Git status
          </button>

          ${git === 'NO GIT' || git === 'GIT UNKNOWN' ? `
            <button
              class="ghost small"
              data-init-git="${esc(project.id)}"
            >
              Init Git
            </button>
          ` : ''}

          <button
            class="ghost small"
            data-diff="${esc(project.id)}"
          >
            View diff
          </button>

        </div>
      </div>
    `;
  }).join('') || `
    <div class="empty-state">
      No projects yet. Add your first workspace.
    </div>`;

  // Mission project selector
  const projectSelect = $('#projectSelect');
  const selectedProject = projectSelect.value;

  projectSelect.innerHTML =
    '<option value="">No project</option>' +
    projects.map(project => `
      <option value="${esc(project.id)}">${esc(project.name)}</option>
    `).join('');

  if (projects.some(project => project.id === selectedProject)) {
    projectSelect.value = selectedProject;
  }
}

// Modal controls
function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModals() {
  $$('.modal-backdrop').forEach(modal => {
    modal.classList.add('hidden');
  });
}

// Main buttons
$('#newMissionBtn').onclick = () => openModal('#missionModal');
$('#newProjectBtn').onclick = () => openModal('#projectModal');
$('#importGithubBtn').onclick = () => openModal('#githubImportModal');

$('#refreshBtn').onclick = async () => {
  try {
    await refresh();
    toast('State refreshed');
  } catch (error) {
    toast(error.message);
  }
};

$$('[data-close]').forEach(button => {
  button.onclick = closeModals;
});

$$('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeModals();
  });
});

// Create mission
$('#missionForm').onsubmit = async event => {
  event.preventDefault();

  const form = event.target;
  const values = Object.fromEntries(new FormData(form));

  try {
    await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify(values)
    });

    form.reset();
    closeModals();
    await refresh();
    toast('Mission queued');
  } catch (error) {
    toast(error.message);
  }
};

// Create local project
$('#projectForm').onsubmit = async event => {
  event.preventDefault();

  const form = event.target;
  const values = Object.fromEntries(new FormData(form));

  try {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify(values)
    });

    form.reset();
    closeModals();
    await refresh();
    toast('Project created');
  } catch (error) {
    toast(error.message);
  }
};

// GitHub repository name suggestion
$('#githubRepoUrl').addEventListener('input', event => {
  const nameInput = $('#githubProjectName');

  if (nameInput.value.trim()) return;

  try {
    const url = new URL(event.target.value);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.hostname === 'github.com' && parts.length >= 2) {
      nameInput.value = parts[1].replace(/\.git$/i, '');
    }
  } catch {
    // Ignore incomplete URLs while the user is typing.
  }
});

// Import public GitHub repository
$('#githubImportForm').onsubmit = async event => {
  event.preventDefault();

  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  const submitButton = $('#githubImportSubmit');

  try {
    const repoUrl = new URL(values.url);

    if (
      repoUrl.protocol !== 'https:' ||
      repoUrl.hostname !== 'github.com' ||
      repoUrl.pathname.split('/').filter(Boolean).length < 2
    ) {
      throw new Error('Enter a valid public GitHub repository URL.');
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Importing…';

    await api('/api/projects/import', {
      method: 'POST',
      body: JSON.stringify({
        url: values.url.trim(),
        name: values.name.trim()
      })
    });

    form.reset();
    closeModals();
    await refresh();

    toast('Repository imported');
  } catch (error) {
    toast(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Import repository →';
  }
};

// Mission execution and stop controls
$('#missionList').addEventListener('click', async event => {
  const runButton = event.target.closest('[data-run]');
  const stopButton = event.target.closest('[data-stop]');

  if (runButton) {
    runButton.disabled = true;

    try {
      await api(`/api/missions/${encodeURIComponent(runButton.dataset.run)}/run`, {
        method: 'POST'
      });

      await refresh();
      toast('Mission started');
    } catch (error) {
      runButton.disabled = false;
      toast(error.message);
    }
  }

  if (stopButton) {
    stopButton.disabled = true;

    try {
      await api(`/api/missions/${encodeURIComponent(stopButton.dataset.stop)}/stop`, {
        method: 'POST'
      });

      await refresh();
      toast('Stop requested');
    } catch (error) {
      stopButton.disabled = false;
      toast(error.message);
    }
  }
});

// Mission status changes
$('#missionList').addEventListener('change', async event => {
  const select = event.target.closest('[data-mission]');

  if (!select || !select.value) return;

  try {
    await api(`/api/missions/${encodeURIComponent(select.dataset.mission)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: select.value })
    });

    await refresh();
    toast('Mission updated');
  } catch (error) {
    toast(error.message);
  }
});

// Project scanning
async function scanProject(projectId) {
  try {
    const info = await api(
      `/api/projects/${encodeURIComponent(projectId)}/info`
    );

    const normalized = info.project || info.info || info;
    projectInfo.set(projectId, normalized);

    await refresh();
    toast('Project scan completed');
  } catch (error) {
    toast(error.message);
  }
}

// Initialize Git in a project
async function initializeGit(projectId) {
  try {
    await api(
      `/api/projects/${encodeURIComponent(projectId)}/init-git`,
      { method: 'POST' }
    );

    await scanProject(projectId);
    toast('Git initialized');
  } catch (error) {
    toast(error.message);
  }
}

// Queue a Git status mission
async function queueGitStatus(projectId) {
  const project = state.projects.find(item => item.id === projectId);

  if (!project) {
    toast('Project not found');
    return;
  }

  try {
    await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: `Git status — ${project.name}`,
        details: 'Check the current Git working tree status.',
        projectId,
        executionType: 'git_status'
      })
    });

    await refresh();
    toast('Git status mission queued');
  } catch (error) {
    toast(error.message);
  }
}

// View Git diff in the existing workspace preview
async function showGitDiff(projectId) {
  const project = state.projects.find(item => item.id === projectId);

  if (!project) {
    toast('Project not found');
    return;
  }

  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(projectId)}/git-diff`
    );

    $('#workspaceTitle').textContent = `${project.name} — Git diff`;
    $('#workspacePath').textContent = 'GIT / DIFF';
    $('#previewLabel').textContent = 'WORKING TREE DIFF';

    $('#workspaceItems').innerHTML = `
      <div class="empty-state">Git diff preview</div>
    `;

    $('#workspacePreview').textContent =
      result.diff || 'Working tree clean. No unstaged changes.';

    openModal('#workspaceModal');
  } catch (error) {
    toast(error.message);
  }
}

// Project card controls
$('#projectList').addEventListener('click', async event => {
  const browseButton = event.target.closest('[data-browse]');
  const scanButton = event.target.closest('[data-scan]');
  const initButton = event.target.closest('[data-init-git]');
  const gitStatusButton = event.target.closest('[data-git-status]');
  const diffButton = event.target.closest('[data-diff]');

  if (browseButton) {
    browseWorkspace(browseButton.dataset.browse);
    return;
  }

  if (scanButton) {
    scanButton.disabled = true;
    await scanProject(scanButton.dataset.scan);
    return;
  }

  if (initButton) {
    initButton.disabled = true;
    await initializeGit(initButton.dataset.initGit);
    return;
  }

  if (gitStatusButton) {
    gitStatusButton.disabled = true;
    await queueGitStatus(gitStatusButton.dataset.gitStatus);
    gitStatusButton.disabled = false;
    return;
  }

  if (diffButton) {
    diffButton.disabled = true;
    await showGitDiff(diffButton.dataset.diff);
    diffButton.disabled = false;
  }
});

// Workspace browser
let browserProjectId = null;
let browserPath = '';

async function browseWorkspace(projectId, relativePath = '') {
  browserProjectId = projectId;
  browserPath = relativePath;

  const project = state.projects.find(item => item.id === projectId);

  $('#workspaceTitle').textContent = project?.name || 'Workspace';
  $('#workspacePath').textContent = relativePath || '/';
  $('#workspacePreview').textContent = 'Select a file to preview.';
  $('#previewLabel').textContent = 'FILE PREVIEW';
  $('#workspaceItems').innerHTML = '<div class="empty-state">Loading…</div>';

  openModal('#workspaceModal');

  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(relativePath)}`
    );

    const parentButton = relativePath
      ? '<button class="ghost small" data-up>↑ Parent folder</button>'
      : '';

    const items = (data.items || []).map(item => `
      <button
        class="workspace-item"
        data-entry="${esc(item.name)}"
        data-type="${esc(item.type)}"
      >
        <span>${item.type === 'directory' ? '▣' : '▤'}</span>
        <span>${esc(item.name)}</span>
        <small>
          ${item.type === 'file' ? `${esc(item.size)} bytes` : ''}
        </small>
      </button>
    `).join('');

    $('#workspaceItems').innerHTML =
      parentButton +
      (items || '<div class="empty-state">Empty folder</div>');

  } catch (error) {
    $('#workspaceItems').innerHTML = `
      <div class="empty-state">${esc(error.message)}</div>
    `;
  }
}

$('#workspaceItems').addEventListener('click', async event => {
  if (event.target.closest('[data-up]')) {
    const parent = browserPath.split('/').slice(0, -1).join('/');
    browseWorkspace(browserProjectId, parent);
    return;
  }

  const entry = event.target.closest('[data-entry]');
  if (!entry) return;

  const nextPath = browserPath
    ? `${browserPath}/${entry.dataset.entry}`
    : entry.dataset.entry;

  if (entry.dataset.type === 'directory') {
    browseWorkspace(browserProjectId, nextPath);
    return;
  }

  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(browserProjectId)}/preview?path=${encodeURIComponent(nextPath)}`
    );

    $('#workspacePreview').textContent = data.content;
    $('#previewLabel').textContent = nextPath;
  } catch (error) {
    $('#workspacePreview').textContent = error.message;
  }
});

// Live server events
const events = new EventSource('/api/events');

events.addEventListener('state', () => {
  refresh().catch(() => {});
});

events.addEventListener('connected', () => {
  refresh().catch(() => {});
});

events.onerror = () => {
  // EventSource will automatically attempt to reconnect.
};

// Initial load and fallback refresh
refresh().catch(error => toast(error.message));

setInterval(() => {
  refresh().catch(() => {});
}, 12000);
