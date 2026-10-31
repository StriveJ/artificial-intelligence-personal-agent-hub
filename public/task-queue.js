import { t, setText } from './i18n.js';

// Task dispatch panel: queues work for a Sub Hub that has an executor, then shows the
// lease lifecycle (queued → running → succeeded / failed / timeout). The panel keeps
// itself up to date only while the page is visible; the queue lives on the Hub.

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

export function mountTaskQueuePanel(doc = document, win = window) {
  const form = doc.getElementById('dispatch-form');
  const list = doc.getElementById('dispatch-list');
  if (!form || !list) return null;
  const prompt = doc.getElementById('dispatch-prompt');
  const cwd = doc.getElementById('dispatch-cwd');
  const status = doc.getElementById('dispatch-status');
  const refresh = doc.getElementById('dispatch-refresh');
  let stopped = false;

  function row(task) {
    const card = element(doc, 'article', 'task-card');
    const heading = element(doc, 'div', 'task-heading');
    const title = element(doc, 'h2');
    setText(title, short(task.prompt));
    const badge = element(doc, 'span', `task-status task-${task.state === 'leased' ? 'running' : task.state === 'done' ? 'success' : task.state === 'failed' || task.state === 'timeout' ? 'error' : 'waiting'}`);
    setText(badge, () => t(STATES[task.state] || task.state));
    heading.append(title, badge);
    const meta = element(doc, 'p', 'muted', `${new Date(task.createdAt).toLocaleString()} · ${t("Attempt")} ${task.attempts}`);
    card.append(heading, meta);
    if (task.result?.summary) card.append(element(doc, 'p', 'task-result', task.result.summary));
    if (task.result?.artifacts?.length) card.append(element(doc, 'p', 'muted', task.result.artifacts.join(' · ')));
    return card;
  }

  async function load() {
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

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = prompt?.value.trim() || '';
    if (!text) return;
    if (status) { status.dataset.busy = '1'; setText(status, t("Queueing…")); }
    try {
      const response = await fetch('/api/task-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, cwd: cwd?.value.trim() || '' }),
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
