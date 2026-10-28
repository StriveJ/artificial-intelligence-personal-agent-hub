import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createStore } from '../lib/storage.mjs';
import { createPushService } from '../lib/pushes.mjs';
import { createScheduler, localDay } from '../lib/scheduler.mjs';
import { collectNews, parseSource, fetchSource, NEWS_SOURCES } from '../lib/news-sources.mjs';
import { createBriefingService, parseBriefingAnswer, validateBriefingSettings } from '../lib/briefings.mjs';

const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });
function fixture(t) {
  const base = mkdtempSync(join(TMP, 'hub-pushes-')), root = join(base, 'instance'), runtimeDir = join(base, 'runtime');
  mkdirSync(root); mkdirSync(runtimeDir); writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'aipa:\n  owner: Example\n');
  t.after(() => { assert.ok(resolve(base).startsWith(TMP + sep)); rmSync(base, { recursive: true, force: true }); });
  return { root, runtimeDir, store: createStore(root) };
}
const timers = { setTimer: () => ({ unref() {} }), clearTimer() {} };
const makeFeed = (items, source = NEWS_SOURCES[1]) => `<rss><channel>${items.map(i => `<item><title><![CDATA[${i.title}]]></title><link>${i.url || `https://${source.hosts[0]}/news/${i.id || 'one'}`}</link><description><![CDATA[${i.excerpt || '\u516c\u5f00\u6765\u6e90\u63d0\u4f9b\u7684\u4e8b\u5b9e\u6458\u8981。'}]]></description><pubDate>${i.date || new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
const options = { enabled: true, dailyAt: '07:00', categories: ['economy'], sourceIds: ['cns-finance'], interests: '\u5b8f\u89c2\u7ecf\u6d4e' };

test("Daily tasks use fixed Asia/Shanghai schedules without duration drift or repeated manual catch-up", async t => {
  const f = fixture(t); let clock = Date.parse('2026-10-16T06:59:00+08:00'), calls = 0;
  const s = createScheduler({ path: join(f.runtimeDir, 'tasks.json'), now: () => clock, ...timers });
  s.register({ id: 'daily-test', label: '\u6bcf\u65e5', dailyAt: '07:00', run: async ({ scheduledFor }) => { calls++; assert.equal(localDay(Date.parse(scheduledFor)), '2026-10-16'); clock += 20 * 60_000; return { status: 'success' }; } });
  s.start(); await s.tick(); assert.equal(calls, 0);
  clock = Date.parse('2026-10-16T07:00:00+08:00'); await s.tick(); assert.equal(calls, 1);
  assert.equal(s.list()[0].status, 'success'); assert.equal(s.list()[0].nextRunAt, '2026-10-16T23:00:00.000Z'); await s.tick(); assert.equal(calls, 1); await s.stop();
});

test("Daily restart catches up only the latest run; failures retry every fifteen minutes up to three attempts", async t => {
  const f = fixture(t), path = join(f.runtimeDir, 'tasks.json'); let clock = Date.parse('2026-10-16T09:00:00+08:00');
  writeFileSync(path, JSON.stringify({ tasks: { 'daily-test': { nextRunAt: '2026-10-10T23:00:00Z' } } }));
  const s = createScheduler({ path, now: () => clock, ...timers }); let count = 0;
  s.register({ id: 'daily-test', label: '\u6bcf\u65e5', dailyAt: '07:00', run: async context => { assert.equal(context.scheduledFor, '2026-10-15T23:00:00.000Z'); count++; throw new Error('private error'); } });
  s.start(); await s.tick(); assert.equal(s.list()[0].status, 'error');
  for (let i = 0; i < 2; i++) { clock += 15 * 60_000; await s.tick(); }
  assert.equal(count, 3); assert.equal(s.list()[0].nextRunAt, '2026-10-16T23:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(s.list()), /private error/); await s.stop();
});

test("Notification infrastructure supports independent producers, durable deduplication, and read state without a scheduler", async t => {
  const f = fixture(t); let clock = 1_000, count = 0, release;
  const p = createPushService({ ...f, now: () => clock });
  p.register({ id: 'test-news', label: '\u65b0\u95fb', run: async () => { count++; await new Promise(r => release = r); return { status: 'success', push: { id: 'example-news', title: '\u65b0\u95fb', summary: '\u6982\u89c8', payload: { value: 1 } } }; } });
  p.register({ id: 'test-reminder', label: '\u63d0\u9192', run: async () => ({ push: { id: 'example-reminder', title: '\u63d0\u9192', summary: '\u559d\u6c34', payload: { text: '\u559d\u6c34' } } }) });
  const first = p.run('test-news'); assert.equal(p.run('test-news'), first); await Promise.resolve(); release(); await first;
  assert.equal(count, 1); await p.run('test-reminder'); assert.equal(p.list().length, 2);
  p.markRead('example-news'); assert.equal(p.list().find(i => i.id === 'example-news').unread, false);
  const previous = f.store.readPush('example-news'); clock += 1000;
  p.publish('test-news', { id: previous.id, title: previous.title, summary: previous.summary, payload: previous.payload });
  assert.equal(p.list().find(i => i.id === previous.id).unread, false);
  p.publish('test-news', { id: previous.id, title: previous.title, summary: '\u66f4\u65b0\u540e\u7684\u6982\u89c8', payload: previous.payload });
  assert.equal(p.list().find(i => i.id === previous.id).unread, true);
  assert.equal(createPushService({ ...f }).list().length, 2);
  assert.throws(() => p.run('shell-command'), /not found|missing/i);
  assert.throws(() => p.publish('test-reminder', { id: previous.id, title: '\u51b2\u7a81', summary: '', payload: {} }), /conflict/i);
});

test("Source parsing preserves originals, GUIDs, and dates while rejecting external entities and out-of-scope links", () => {
  const source = NEWS_SOURCES[1];
  const parsed = parseSource(makeFeed([{ title: '\u8d22\u7ecf &amp; \u7ecf\u6d4e', excerpt: '<b>\u6458\u8981</b>', url: 'http://www.chinanews.com.cn/cj/a.shtml?utm_source=test' }]), source);
  assert.equal(parsed[0].url, 'https://www.chinanews.com.cn/cj/a.shtml'); assert.equal(parsed[0].title, '\u8d22\u7ecf & \u7ecf\u6d4e'); assert.equal(parsed[0].excerpt, '\u6458\u8981');
  assert.equal(parseSource(makeFeed([{ title: '\u574f\u94fe\u63a5', url: 'http://127.0.0.1/private' }, { title: '\u672a\u77e5\u65e5\u671f', date: 'invalid' }]), source).length, 0);
  assert.throws(() => parseSource('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss/>', source));
  const atom = `<feed><entry><title>AI release</title><link href="https://openai.com/news/test"/><updated>2026-10-16T01:00:00Z</updated><summary>Public data</summary></entry></feed>`;
  assert.equal(parseSource(atom, NEWS_SOURCES[0])[0].category, 'ai');
});

test("Collector bounds redirects and sizes, limits categories, deduplicates, and filters expired or future news", async () => {
  let redirect;
  await assert.rejects(fetchSource(NEWS_SOURCES[0], async (_url, options) => { redirect = options.redirect; return new Response('x'.repeat(2_000_001)); }));
  assert.equal(redirect, 'error');
  const now = Date.parse('2026-10-16T07:00:00+08:00');
  const result = await collectNews({ categories: ['economy'], sourceIds: ['cns-finance'], now, previousUrls: ['https://www.chinanews.com.cn/news/used'], fetcher: async () => new Response(makeFeed([
    { id: 'new', title: '\u6700\u65b0\u7ecf\u6d4e', date: '2026-10-15T06:00:00Z' }, { id: 'dup', title: '\u6700\u65b0\u7ecf\u6d4e', date: '2026-10-15T06:00:00Z' },
    { id: 'old', title: '\u65e7\u95fb', date: '2026-10-01T01:00:00Z' }, { id: 'future', title: '\u672a\u6765', date: '2026-10-18T01:00:00Z' },
    { id: 'used', title: '\u5df2\u63a8\u9001\u7684\u65b0\u95fb', date: '2026-10-15T06:00:00Z' },
  ])) });
  assert.deepEqual(result.items.map(i => i.title), ['\u6700\u65b0\u7ecf\u6d4e']);
  await assert.rejects(collectNews({ categories: ['economy'], sourceIds: ['cns-finance'], fetcher: async () => { throw new Error('secret'); } }), /All news sources temporarily unavailable/i);
});

test("Daily news sends public materials only and never invents model links or repeats calls across runs or restart", async t => {
  const f = fixture(t); let calls = 0, clock = Date.parse('2026-10-16T08:00:00+08:00');
  const runner = async prompt => { calls++; assert.doesNotMatch(prompt, /private-profile-secret/); return JSON.stringify({ intro: '\u4eca\u65e5\u7ecf\u6d4e\u6982\u89c8', items: [{ id: 'n1', summary: '\u6765\u6e90\u6458\u8981\u663e\u793a\u4e86\u65b0\u7684\u7ecf\u6d4e\u8fdb\u5c55。' }] }); };
  writeFileSync(join(f.root, 'user-space', 'profile.yaml'), 'private-profile-secret');
  const make = () => createBriefingService({ ...f, runner, defaults: options, now: () => clock, fetcher: async () => new Response(makeFeed([{ title: '\u5b8f\u89c2\u7ecf\u6d4e\u6570\u636e', date: '2026-10-15T09:00:00Z' }])) });
  const service = make(); await service.generate(); await service.generate(); await make().generate(); assert.equal(calls, 1);
  const report = f.store.readBriefing('2026-10-16'); assert.equal(report.sections[0].items[0].url, 'https://www.chinanews.com.cn/news/one');
  assert.match(readFileSync(join(f.store.base, 'briefings', '2026-10-16.md'), 'utf8'), /https:\/\/www.chinanews.com.cn/);
  assert.throws(() => f.store.readBriefing('../../secret'));
  assert.throws(() => parseBriefingAnswer('{"intro":"x","items":[{"id":"made-up","summary":"x"}]}', [{ id: 'n1' }]));
  assert.throws(() => validateBriefingSettings({ ...options, sourceIds: ['http://127.0.0.1'] }));
  clock += 86400_000; await make().generate(); assert.equal(calls, 1, "Previously delivered links must not be summarized again");
});

test("Model failure preserves source excerpts and original links; retry replaces them with summaries", async t => {
  const f = fixture(t); let failed = true;
  const service = createBriefingService({ ...f, defaults: options, fetcher: async () => new Response(makeFeed([{ title: '\u7ecf\u6d4e\u65b0\u95fb' }])), runner: async () => {
    if (failed) throw new Error('API key must not leak');
    return JSON.stringify({ intro: '\u603b\u7ed3\u5b8c\u6210', items: [{ id: 'n1', summary: '\u516c\u5f00\u6765\u6e90\u6458\u8981。' }] });
  } });
  await assert.rejects(service.generate(), /model summary failed/i);
  assert.equal(f.store.readBriefing(localDay()).status, 'sources-only');
  assert.doesNotMatch(JSON.stringify(f.store.listBriefings()), /API key/);
  failed = false; await service.generate(); assert.equal(f.store.readBriefing(localDay()).status, 'complete');
});
