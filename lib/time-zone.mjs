// IANA wall-clock conversion is independent of the operating-system timezone.
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const formatters = new Map(), instants = new Map(), validated = new Set();
export function timeZone(value = DEFAULT_TIME_ZONE) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]{0,79}$/.test(value)) throw Error('Use a supported IANA time zone');
  if(validated.has(value))return value;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); } catch { throw Error('Use a supported IANA time zone'); }
  if(validated.size>=128)validated.delete(validated.values().next().value);
  validated.add(value);return value;
}
export function wallParts(value = Date.now(), zone = DEFAULT_TIME_ZONE) {
  zone = timeZone(zone);
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return { day: parts.year + '-' + parts.month + '-' + parts.day, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
export const localDay = (value = Date.now(), zone = DEFAULT_TIME_ZONE) => wallParts(value, zone).day;
export const addDays = (day, count) => new Date(Date.parse(day + 'T00:00:00Z') + count * 86400_000).toISOString().slice(0, 10);
const wallEpoch = parts => Date.parse(parts.day + 'T00:00:00Z') + parts.hour * 3600_000 + parts.minute * 60_000 + parts.second * 1000;
export function dailyTime(day, at, zone = DEFAULT_TIME_ZONE) {
  zone = timeZone(zone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw Error('Invalid local schedule date or time');
  const key = zone + '/' + day + '/' + at;
  if (instants.has(key)) return instants.get(key);
  const wanted = Date.parse(day + 'T' + at + ':00Z'), offsets = new Set();
  // Sampling both sides captures DST, half-hour transitions, and skipped dates.
  for (let delta = -48; delta <= 48; delta += 6) { const stamp = wanted + delta * 3600_000; offsets.add(wallEpoch(wallParts(stamp, zone)) - stamp); }
  const candidates = [...offsets].map(offset => ({ stamp: wanted - offset, wall: wallEpoch(wallParts(wanted - offset, zone)) }));
  const exact = candidates.filter(c => c.wall === wanted).sort((a, b) => a.stamp - b.stamp);
  // Repeat an overlapping wall time once, at its earlier occurrence. A gap shifts
  // forward by the transition size (02:30 becomes 03:30 for a one-hour gap).
  const forward = candidates.filter(c => c.wall > wanted).sort((a, b) => a.wall - b.wall || a.stamp - b.stamp);
  const selected = exact[0] || forward[0];
  if (!selected) throw Error('Cannot resolve the local schedule in this time zone');
  if (instants.size >= 4096) instants.delete(instants.keys().next().value);
  instants.set(key, selected.stamp); return selected.stamp;
}
export function dailyDue(now, at, next = false, zone = DEFAULT_TIME_ZONE) {
  const day = localDay(now, zone), candidates = [...new Set([-3,-2,-1,0,1,2,3].map(n => dailyTime(addDays(day, n), at, zone)))].sort((a,b) => a-b);
  const result = next ? candidates.find(value => value > now) : candidates.findLast(value => value <= now);
  if (!Number.isFinite(result)) throw Error('Cannot resolve the next local schedule');
  return result;
}
