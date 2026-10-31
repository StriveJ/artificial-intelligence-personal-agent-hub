import { t, setText } from './i18n.js';

// Task dispatch panel: queues work for a Sub Hub that has an executor, then shows the
// lease lifecycle (queued → running → succeeded / failed / timeout). Only devices that
// advertise task execution can be chosen. The queue lives on the Hub; this panel keeps
// itself up to date while the page is visible.

const STATES = { queued: "Queued", leased: "Running", done: "Succeeded", failed: "Failed", timeout: "Timeout" };
const POLL_MS = 8000;

function element(doc, tag, className, value) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) setText(node, value);
  return node;
}

function short(text, limit = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

const badgeClass = state => (state === 'leased' ? 'running' : state === 'done' ? 'success' : state === 'failed' || state === 'timeout' ? 'error' : 'waiting');

export function mountTaskQueuePanel(doc = document, win = window) {
  const form = doc.getElementById('dispatch-form');
  const list = doc.getElementById('dispatch-list');
  if (!form || !list) return null;
  const prompt = doc.getElementById('dispatch-prompt');
  const cwd = doc.getElementById('dispatch-cwd');
  const nodeSelect = doc.getElementById('dispatch-node');
  const nodeHelp = doc.getElementById('dispatch-node-help');
  const status = doc.getElementById('dispatch-status');
  const refresh = doc.getElementById('dispatch-refresh');
  const submit = form.querySelector('button[type="submit"]');
  let stopped = false;
  let eligible = [];

  function option(docNode, value, label) {
    const node = doc.createElement('option');
    node.value = value;
    setText(node, label);
    return node;
  }

  async function loadDevices() {
    if (!nodeSelect) return;
    try {
      const response = await fetch('/api/nodes', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      eligible = (data.nodes || []).filter(node => node.capabilities && node.capabilities.tasks === true);
      const previous = nodeSelect.value;
      nodeSelect.replaceChildren(
        option(doc, '', t("Any device that can run tasks")),
        ...eligible.map(node => option(doc, node.id, `${node.name || node.id}${node.name ? ` (${node.id})` : ''} · ${node.status === 'online' ? t("Online") : t("Offline")}`)),
      );
      nodeSelect.value = eligible.some(node => node.id === previous) ? previous : '';
      nodeSelect.disabled = eligible.length === 0;
      if (submit) submit.disabled = eligible.length === 0 && nodeSelect.value === '';
      if (nodeHelp) setText(nodeHelp, eligible.length ? t("Only devices that advertise task execution can be selected.") : t("No device can run tasks yet. Start a Sub Hub with task execution enabled."));
    } catch (error) {
      eligible = [];
      if (nodeHelp) setText(nodeHelp, `${t("Task queue unavailable")}: ${error.message}`);
    }
  }

  function row(task) {
    const card = element(doc, 'article', 'task-card');
    const heading = element(doc, 'div', 'task-heading');
    const title = element(doc, 'h2');
    setText(title, short(task.prompt));
    const badge = element(doc, 'span', `task-status task-${badgeClass(task.state)}`);
    setText(badge, () => t(STATES[task.state] || task.state));
    heading.append(title, badge);
    const target = task.targetNode ? ` · ${task.targetNode}` : '';
    const meta = element(doc, 'p', 'muted', `${new Date(task.createdAt).toLocaleString()}${target} · ${t("Attempt")} ${task.attempts}`);
    card.append(heading, meta);
    if (task.result?.summary) card.append(element(doc, 'p', 'task-result', task.result.summary));
    if (task.result?.artifacts?.length) card.append(element(doc, 'p', 'muted', task.result.artifacts.join(' · ')));
    return card;
  }

  async function loadTasks() {
    try {
      const response = await fetch('/api/task-queue', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const tasks = data.tasks || [];
      list.replaceChildren(...(tasks.length ? tasks.map(row) : [element(doc, 'p', 'muted', t("No dispatched tasks yet."))]));
      if (status && status.dataset.busy !== '1') setText(status, '');
    } catch (error) {
      if (status) setText(status, `${t("Task queue unavailable")}: ${error.message}`);
    }
  }

  const load = () => Promise.all([loadDevices(), loadTasks()]);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = prompt?.value.trim() || '';
    if (!text) return;
    if (status) { status.dataset.busy = '1'; setText(status, t("Queueing…")); }
    try {
      const response = await fetch('/api/task-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, cwd: cwd?.value.trim() || '', nodeId: nodeSelect?.value || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      prompt.value = '';
      if (status) setText(status, t("Task queued."));
      await load();
    } catch (error) {
      if (status) setText(status, `${t("Could not queue the task")}: ${error.message}`);
    } finally {
      if (status) status.dataset.busy = '';
    }
  });

  refresh?.addEventListener('click', () => { void load(); });
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') void load(); });
  const timer = setInterval(() => { if (!stopped && doc.visibilityState === 'visible') void load(); }, POLL_MS);
  win.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); }, { once: true });
  void load();
  return { load };
}

mountTaskQueuePanel();
