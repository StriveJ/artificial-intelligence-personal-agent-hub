import { createCoreRuntime } from './core-runtime.mjs';

const dateOf = value => new Date(`${value}T00:00:00Z`);
const iso = date => date.toISOString().slice(0, 10);
const addDays = (day, n) => { const date = dateOf(day); date.setUTCDate(date.getUTCDate() + n); return iso(date); };
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dateOf(value).getTime()) && iso(dateOf(value)) === value;

export function resolveRecallRange(query, today) {
  if (!validDay(today)) throw new Error("Invalid recall reference date");
  const text = String(query).toLowerCase(), weekday = dateOf(today).getUTCDay() || 7;
  const monday = addDays(today, 1 - weekday);
  let from, to, report;
  const dates = [...text.matchAll(/(20\d{2})[-/\u5e74](\d{1,2})[-/\u6708](\d{1,2})\u65e5?/g)]
    .map(m => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  if (dates.some(day => !validDay(day))) throw new Error("Use a valid date, such as 2026-10-08");
  if (dates.length) [from, to] = [dates[0], dates[1] || dates[0]];
  else if (/\b(?:the )?week before last\b|\u4e0a\u4e0a\u5468|\u4e0a\u4e0a\u661f\u671f/.test(text)) [from, to] = [addDays(monday, -14), addDays(monday, -8)];
  else if (/\blast week\b|\u4e0a\u5468|\u4e0a\u661f\u671f/.test(text)) [from, to] = [addDays(monday, -7), addDays(monday, -1)];
  else if (/\bthis week\b|\u672c\u5468|\u8fd9\u5468|\u8fd9\u661f\u671f|\u672c\u661f\u671f/.test(text)) [from, to] = [monday, today];
  else if (/\bday before yesterday\b|\u524d\u5929/.test(text)) from = to = addDays(today, -2);
  else if (/\byesterday\b|\u6628\u5929|\u6628\u65e5|\u6628\u665a/.test(text)) from = to = addDays(today, -1);
  else if (/\btoday\b|\u4eca\u5929|\u4eca\u65e5/.test(text)) from = to = today;
  else if (/\b(?:last|this) month\b|\u4e0a\u4e2a?\u6708|\u672c\u6708|\u8fd9\u4e2a\u6708/.test(text)) {
    const first = `${today.slice(0, 7)}-01`;
    const month = /\blast month\b|\u4e0a\u4e2a?\u6708/.test(text) ? addDays(first, -1).slice(0, 7) : today.slice(0, 7);
    from = `${month}-01`; to = month === today.slice(0, 7) ? today : addDays(first, -1);
    report = { range: 'month', value: month, location: `user-space/logs/monthly/MONTHLY-REVIEW_${month}.md` };
  } else if (/\blast year\b|\u53bb\u5e74|\u4e0a\u5e74/.test(text)) {
    const year = String(Number(today.slice(0, 4)) - 1);
    from = `${year}-01-01`; to = `${year}-12-31`;
    report = { range: 'year', value: year, location: `user-space/logs/yearly/YEARLY-REVIEW_${year}.md` };
  } else {
    const recent = text.match(/(?:last|past|recent)\s+(\d{1,3})\s+days?\b/) || text.match(/(?:\u6700\u8fd1|\u8fd1|\u8fc7\u53bb)(\d{1,3})\u5929/);
    if (recent) { const n = Math.max(1, Number(recent[1])); from = addDays(today, 1 - n); to = today; }
    else if (/\b(?:recently|recent|previously|before)\b|\u6700\u8fd1|\u8fd1\u671f|\u4e4b\u524d|\u4ee5\u524d/.test(text) && /\b(?:review|summarize|summary|completed|work|progress|records?|busy|discussed)\b|\u56de\u987e|\u590d\u76d8|\u603b\u7ed3|\u5e72[\u4e86\u8fc7]|\u505a[\u4e86\u8fc7]|\u5b8c\u6210|\u5de5\u4f5c|\u8fdb\u5c55|\u8bb0\u5f55|\u5fd9|\u804a[\u4e86\u8fc7]/.test(text)) {
      from = addDays(today, -13); to = today;
    } else return null;
  }
  if (from > to) throw new Error("Start date cannot be after end date");
  const requestedFrom = from;
  if ((dateOf(to) - dateOf(from)) / 86400000 >= 31) from = addDays(to, -30);
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return { from, to, requestedFrom, limited: from !== requestedFrom, days, report };
}

export async function createRecallReader(root, { command, allowed, now = () => new Date(), timeZone, runtime = createCoreRuntime(root) }) {
  const lib = runtime.lib;
  const [daily, events, clock, boundary] = await Promise.all([lib('daily-note.mjs'), lib('event-store.mjs'), lib('day-clock.mjs'), lib('time-boundary.mjs')]);
  const localTimestamp = date => {
    if(clock.BUSINESS_CLOCK_SCHEMA===1)return clock.createBusinessClock(root,{timeZone}).timestamp(date);
    timeZone||='Asia/Shanghai';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };
  function currentTime() {
    if(clock.BUSINESS_CLOCK_SCHEMA===1){const shared=clock.createBusinessClock(root,{timeZone}),date=now();return {timestamp:shared.timestamp(date),timeZone:shared.settings.timeZone,businessDate:shared.dayKey(date),dayStartHour:shared.settings.dayStartHour};}
    const timestamp = localTimestamp(now());
    return { timestamp, timeZone:clock.BUSINESS_CLOCK_SCHEMA===1?clock.clockSettings(root).timeZone:timeZone, businessDate: clock.todayKey(root, { ts: timestamp }), dayStartHour: clock.dayStartHour(root) };
  }
  async function read(query, notes = []) {
    const time = currentTime(), range = resolveRecallRange(query, time.businessDate);
    if (!range) return { time, hits: [], coverage: null };
    const coverage = { version: 2, from: range.from, to: range.to, requestedFrom: range.requestedFrom, limited: range.limited, timeZone:time.timeZone, dayStartHour: time.dayStartHour, days: [], omitted: 0, truncated: false };
    const hits = [], pending = new Map();
    const report = range.report && await command('recall', ['query', '--range', range.report.range, '--value', range.report.value]);
    if (report && report !== 'missing') {
      coverage.report = range.report.location;
      coverage.from = range.requestedFrom; coverage.limited = false;
      if (allowed(report)) hits.push({ id: `recall-${range.report.value}`, kind: range.report.range, title: `${range.report.value} ${range.report.range === 'month' ? "Monthly report" : "Yearly report"}`, location: range.report.location, body: report });
      else { coverage.omitted++; coverage.blockedReport = true; }
    } else {
      for (const date of range.days) {
        const raw = await command('recall', ['query', '--range', 'day', '--value', date]);
        const entry = { date, status: 'missing' }; coverage.days.push(entry);
        if (raw === 'missing') { pending.set(date, { entry }); continue; }
        const header = raw.split(/^##[ \t]/m)[0];
        const summary = daily.summarySection(raw);
        if (!summary?.trim() || daily.isSummaryPending(raw)) { pending.set(date, { entry, raw, header }); continue; }
        if (!allowed(`${header}\n${summary}`)) { entry.status = 'blocked'; coverage.omitted++; continue; }
        const sections = [
          ["Highlights", daily.lastSectionText(raw, /^##[ \t]*(?:Highlights|\u8981\u70b9)[^\n]*$/m)],
          ["Daily summary", summary],
          ["Related projects", daily.lastSectionText(raw, /^##[ \t]*(?:Related projects|\u76f8\u5173\u9879\u76ee)[^\n]*$/m)],
        ];
        const safe = []; entry.readSections = []; entry.omittedSections = [];
        for (const [name, content] of sections) {
          if (!content?.trim()) continue;
          if (!allowed(`${header}\n${content}`)) { entry.omittedSections.push(name); coverage.omitted++; continue; }
          safe.push(`## ${name}\n${content.trim()}`); entry.readSections.push(name);
        }
        const body = safe.join('\n\n');
        if (!allowed(`${header}\n${body}`)) { entry.status = 'blocked'; coverage.omitted++; entry.readSections = []; continue; }
        entry.status = 'summary';
        hits.push({ id: `daily-${date}`, kind: 'daily', date, title: `${date} Daily summary`, location: `user-space/logs/daily/DAILY-NOTE_${date}.md`, body });
      }
      if (pending.size) {
        const byDay = new Map([...pending.keys()].map(date => [date, []]));
        for (const { host, row } of events.readEventsByHost(root)) {
          if (row.tool === 'aipa-hub' || !['user_message', 'assistant_message', 'checkpoint', 'session_end'].includes(row.type)) continue;
          const date = boundary.dayKey(row.ts_local || '', time.dayStartHour);
          if (!byDay.has(date)) continue;
          const body = `[${row.ts_local}] ${host} · ${row.project || '?'} · ${row.type}: ${row.data || ''}`;
          if (!allowed(row)) { coverage.omitted++; pending.get(date).entry.filtered = true; continue; }
          byDay.get(date).push({ body, location: row.ts_local, date });
        }
        for (const [date, { entry, raw, header }] of pending) {
          const records = byDay.get(date).sort((a, b) => a.location.localeCompare(b.location));
          if (header && !allowed(header)) { entry.status = 'blocked'; coverage.omitted++; continue; }
          if (records.length) {
            entry.status = 'events'; entry.records = records.length;
            const selected = records.length > 60 ? Array.from({ length: 60 }, (_, i) => records[Math.floor(i * (records.length - 1) / 59)]) : records;
            entry.sampled = records.length > selected.length;
            hits.push({ id: `events-${date}`, kind: 'events', date, title: `${date} Session events`, location: `state/events + state/hosts/*/events (business day ${date})`, body: selected.map(r => r.body).join('\n') });
          } else if (raw) {
            const lines = (daily.timelineSection(raw) || '').split(/\r?\n/).filter(line => /^- \[\d{2}:\d{2}\].*· (user_message|assistant_message|checkpoint|session_end):/.test(line));
            const safe = lines.filter(line => allowed(line));
            coverage.omitted += lines.length - safe.length;
            if (safe.length) {
              entry.status = 'timeline'; entry.records = safe.length; entry.sampled = safe.length > 60;
              hits.push({ id: `timeline-${date}`, kind: 'daily', date, title: `${date} Daily timeline (not summarized)`, location: `user-space/logs/daily/DAILY-NOTE_${date}.md`, body: safe.slice(0, 60).join('\n') });
            } else if (entry.filtered || lines.length) entry.status = 'blocked';
          } else if (entry.filtered) entry.status = 'blocked';
        }
      }
      for (const note of notes) {
        if (!note.created || !Number.isFinite(new Date(note.created).getTime())) continue;
        const date = boundary.dayKey(localTimestamp(new Date(note.created)), time.dayStartHour);
        if (date < range.from || date > range.to) continue;
        if (!allowed(note)) { coverage.omitted++; continue; }
        hits.push({ id: note.id, kind: 'note', date, title: `${date} Note: ${note.title}`, location: `user-space/logs/hub/notes/${note.id}.md`, body: note.text });
      }
    }
    const budget = Math.min(12000, Math.floor(48000 / Math.max(hits.length, 1)));
    for (const hit of hits) {
      if (hit.body.length > budget) {
        hit.body = hit.body.slice(0, budget) + "\n(This record is excerpted)"; coverage.truncated = true;
        const entry = coverage.days.find(day => day.date === hit.date); if (entry) entry.truncated = true;
      }
    }
    coverage.truncated ||= coverage.days.some(day => day.sampled);
    return { time, hits, coverage };
  }
  return runtime.guard({ read, currentTime });
}
