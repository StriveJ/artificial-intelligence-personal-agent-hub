// Perception timeline: one day of derived events from the Hub, grouped by hour.
// Read-only. Raw audio/video never reaches this page; only events do.
const CHANNEL = { audio: "Audio", camera: "Camera", wearable: "Wearable", task: "Task" };

function localDay(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function initTimeline({ api, t, toast, formatDate }) {
  const root = document.getElementById('timeline-events');
  const dateInput = document.getElementById('timeline-date');
  const summary = document.getElementById('timeline-summary');
  const empty = document.getElementById('timeline-empty');
  const refresh = document.getElementById('timeline-refresh');
  const prev = document.getElementById('timeline-prev');
  const next = document.getElementById('timeline-next');
  const search = document.getElementById('timeline-search');
  if (!root || !dateInput) return { load: async () => {} };

  dateInput.value = localDay(0);
  let items = [];

  function render() {
    const query = (search?.value || '').trim().toLowerCase();
    root.replaceChildren();
    const visible = query ? items.filter(item => String(item.text || '').toLowerCase().includes(query)) : items;
    if (!visible.length) {
      empty.hidden = false;
      empty.textContent = items.length ? t("No events match the search.") : t("No events recorded for this day.");
      if (summary) summary.textContent = '';
      return;
    }
    empty.hidden = true;
    const byHour = new Map();
    for (const item of visible) {
      const at = String(item.at || '');
      const hour = at.slice(11, 13) || '--';
      if (!byHour.has(hour)) byHour.set(hour, []);
      byHour.get(hour).push({ at, item });
    }
    for (const hour of [...byHour.keys()].sort()) {
      const section = document.createElement('section');
      section.className = 'timeline-hour';
      const label = document.createElement('div');
      label.className = 'timeline-hour-label';
      label.textContent = `${hour}:00`;
      const list = document.createElement('div');
      for (const { at, item } of byHour.get(hour)) {
        const card = document.createElement('article');
        card.className = 'timeline-event';
        const meta = document.createElement('p');
        meta.className = 'muted timeline-meta';
        const parts = [at.slice(11, 19)];
        if (item.channel) parts.push(t(CHANNEL[item.channel] || "Event"));
        if (item.duration_s) parts.push(`${Number(item.duration_s).toFixed(1)}s`);
        if (item.nodeId) parts.push(item.nodeId);
        meta.textContent = parts.filter(Boolean).join(' · ');
        const text = document.createElement('p');
        text.className = 'timeline-text';
        text.textContent = String(item.text || '');
        card.append(meta, text);
        list.append(card);
      }
      section.append(label, list);
      root.append(section);
    }
    const speech = items.filter(item => item.channel === 'audio').reduce((sum, item) => sum + Number(item.duration_s || 0), 0);
    if (summary) summary.textContent = t("{0} events · {1} min of audio", [items.length, (speech / 60).toFixed(1)]);
  }

  async function load() {
    const day = dateInput.value || localDay(0);
    try {
      const data = await api(`/api/perception/timeline?date=${encodeURIComponent(day)}`);
      items = Array.isArray(data.events) ? data.events : [];
      render();
    } catch (error) {
      toast(error.message);
    }
  }

  dateInput.addEventListener('change', () => void load());
  refresh?.addEventListener('click', () => void load());
  prev?.addEventListener('click', () => { dateInput.value = localDay(-1); void load(); });
  next?.addEventListener('click', () => { dateInput.value = localDay(1); void load(); });
  search?.addEventListener('input', render);

  return { load };
}
