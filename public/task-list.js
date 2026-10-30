import { t, setText } from './i18n.js';
const labels = { waiting: "Waiting", running: "Running", success: "Succeeded", partial: "Partial", blocked: "Needs attention", error: "Failed", unknown: "Outcome needs review", deferred: "Waiting for idle", interrupted: "Previous run interrupted" };
const text = setText;

export function createTaskList({ list, formatDate, onRun }) {
  const doc = list.ownerDocument, cards = new Map();
  const el = (tag, className, value) => { const node = doc.createElement(tag); node.className = className || ''; if (value !== undefined) setText(node, value); return node; };
  function create(task) {
    const node = el('article', 'task-card'), heading = el('div', 'task-heading'), title = el('h2'), status = el('span');
    const description = el('p', 'muted'), times = el('dl', 'task-times'), values = [];
    for (const label of ["Frequency", task.id==='memory-receipts'?"Last successful check":"Last success", "Next run", ...(task.id==='memory-receipts'?["Last actual receipt delivery"]:[])]) { const value = el('dd'); times.append(el('dt', '', () => t(label)), value); values.push(value); }
    const result = el('p', 'task-result'), details = el('details', 'task-history'), history = el('ul');
    details.append(el('summary', '', () => (t("Recent run history"))), history); heading.append(title, status);
    node.append(heading, description, times, result);
    let button;
    if (task.id === 'repo-sync') {
      button = el('button', 'primary'); button.type = 'button';
      button.onclick = async () => { button.disabled = true; try { await onRun(task.id); } catch { if (button.isConnected) button.disabled = false; } };
      node.append(button);
    }
    node.append(details); list.append(node);
    const card = { node, title, status, description, values, result, details, history, button, historySignature: '', signature: '' };
    cards.set(task.id, card); return card;
  }
  return tasks => {
    const keep = new Set(tasks.map(task => task.id));
    for (const [id, card] of cards) if (!keep.has(id)) { card.node.remove(); cards.delete(id); }
    for (const task of tasks) {
      const card = cards.get(task.id) || create(task), signature = JSON.stringify(task);
      if (card.signature === signature) continue;
      card.signature = signature;
      text(card.title, () => t(task.label));
      card.status.className = `task-status task-${task.status}`;
      text(card.status, () => ((task.enabled ? (task.status==='success'&&task.result?.code==='no_pending_receipts' ? t("Healthy") : (t(labels[task.status]) || task.status)) : t("Disabled"))));
      text(card.description, () => ((task.id === 'repo-sync' ? t('Pulls repository updates as configured. Bidirectional mode also saves, merges, and pushes web conversations and notes. Stops and reports conflicts.') : t('Runs on the Hub device as scheduled.'))));
      const values = () => [task.dailyAt ? t('Daily at {0} · {1}', task.dailyAt, task.timeZone) : t('Every {0} minutes', task.intervalMinutes), task.lastSuccessAt ? formatDate(task.lastSuccessAt) : t('No successful run yet'), task.enabled && task.nextRunAt ? formatDate(task.nextRunAt) : t('Not scheduled'), ...(task.id==='memory-receipts'?[task.lastDeliveredAt?formatDate(task.lastDeliveredAt):t('No receipt deliveries yet')]:[])];
      values().forEach((value, i) => text(card.values[i], () => values()[i]));
      card.result.hidden = !task.result?.summary; text(card.result, () => ((task.result?.summary || '')));
      if (card.button) { text(card.button, () => ((task.status === 'running' ? t("Synchronizing...") : t("Sync now")))); card.button.disabled = !task.enabled || task.status === 'running'; }
      const items = (task.history || []).slice(-5).reverse(), historySignature = JSON.stringify(items);
      card.details.hidden = !items.length;
      if (card.historySignature !== historySignature) {
        const old = new Map([...card.history.children].map(li => [li.dataset.key, li]));
        const keys = new Set(), occurrences = new Map();
        items.forEach((item, i) => {
          const base = `${item.startedAt}/${item.finishedAt}/${item.reason}`, occurrence = occurrences.get(base) || 0;
          occurrences.set(base, occurrence + 1);
          const key = `${base}/${occurrence}`; keys.add(key);
          const li = old.get(key) || el('li'); li.dataset.key = key;
          text(li, () => ([formatDate(item.finishedAt), labels[item.status] || item.status, item.summary].filter(Boolean).join(' · ')));
          if (card.history.children[i] !== li) card.history.insertBefore(li, card.history.children[i] || null);
        });
        for (const li of [...card.history.children]) if (!keys.has(li.dataset.key)) li.remove();
        card.historySignature = historySignature;
      }
    }
  };
}
