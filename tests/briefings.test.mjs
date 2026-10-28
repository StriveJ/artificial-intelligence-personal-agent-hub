import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rankNews, validateBriefingSettings, createBriefingService, likeTags } from '../lib/briefings.mjs';
import { safeSourceUrl, collectNews, CATEGORIES, NEWS_SOURCES } from '../lib/news-sources.mjs';

const baseSettings = (extra = {}) => ({
  enabled: true, dailyAt: '07:00', categories: ['ai'], sourceIds: ['openai'],
  interests: '', customCategories: [], customSources: [], maxItems: 60, exploreRatio: 0.3, ...extra,
});
const item = (index, extra = {}) => ({ id: `raw${index}`, title: `\u6807\u9898 ${index}`, url: `https://openai.com/news/${index}`, excerpt: '\u6458\u8981', publishedAt: new Date(Date.UTC(2026, 9, 17, index)).toISOString(), sourceId: 'openai', sourceName: "OpenAI official", category: 'ai', tags: ['ai', 'openai'], ...extra });

test("Interest and exploration sampling follows 70/30 within item limits", () => {
  const items = Array.from({ length: 40 }, (_, index) => item(index));
  const ranked = rankNews({ items, likes: {}, maxItems: 10, exploreRatio: 0.3, rng: () => 0 });
  assert.equal(ranked.items.length, 10);
  assert.equal(ranked.exploitCount, 7);
  assert.equal(ranked.exploreCount, 3);
  assert.equal(new Set(ranked.items.map(row => row.id)).size, 10, "Sampling must not duplicate items");
  const capped = rankNews({ items, likes: {}, maxItems: 999, exploreRatio: 0.3 });
  assert.equal(capped.items.length, 40, "Never exceed the actual item count");
  const many = Array.from({ length: 160 }, (_, index) => item(index));
  assert.equal(rankNews({ items: many, likes: {}, maxItems: 999 }).items.length, 100, "Maximum 100 items");
});

test("Like weights affect ranking; high weights fill interest slots and other items remain eligible for exploration", () => {
  const items = [item(0, { category: 'economy', tags: ['economy', 'cns-finance'] }), ...Array.from({ length: 19 }, (_, index) => item(index + 1))];
  const ranked = rankNews({ items, likes: { economy: 9 }, maxItems: 10, exploreRatio: 0.3, rng: () => 0.99 });
  assert.equal(ranked.exploitCount, 7);
  assert.equal(ranked.items[0].category, 'economy', "High-weight items lead interest slots");
  assert.equal(ranked.items.length, 10);
  assert.ok(ranked.items.filter(row => row.category === 'ai').length >= 3, "Unliked categories remain eligible");
  assert.ok(!rankNews({ items, likes: {}, maxItems: 5 }).items.some(row => row.category === 'economy' && false));
  assert.deepEqual(likeTags({ tags: [] , category: 'ai', sourceId: 'openai' }).sort(), ['ai', 'openai']);
});

test("Custom sources require public HTTPS URLs", () => {
  assert.equal(safeSourceUrl('https://example.com/feed.xml').host, 'example.com');
  for (const bad of ['http://example.com/feed.xml', 'https://localhost/feed', 'https://127.0.0.1/feed', 'https://10.0.0.5/feed', 'https://192.168.56.10/feed', 'https://user:pw@example.com/feed', 'https://example.com:8080/feed', 'https://foo.local/feed', 'ftp://example.com/feed']) {
    assert.equal(safeSourceUrl(bad), null, `\u5e94\u62d2\u7edd ${bad}`);
  }
});

test("Settings bound custom categories, sources, item limits, and exploration ratios", () => {
  const ok = validateBriefingSettings(baseSettings({ customCategories: [{ label: '\u82af\u7247', keywords: ['\u82af\u7247', '\u5149\u523b\u673a', '\u82af\u7247'] }], customSources: [{ name: '\u793a\u4f8b', url: 'https://example.com/feed.xml' }], maxItems: 999, exploreRatio: 0.9 }));
  assert.deepEqual(ok.customCategories, [{ label: '\u82af\u7247', keywords: ['\u82af\u7247', '\u5149\u523b\u673a'] }]);
  assert.equal(ok.customSources[0].host, 'example.com');
  assert.equal(ok.maxItems, 100, "Maximum 100");
  assert.equal(ok.exploreRatio, 0.5, "Exploration ratio capped at 50%");
  assert.throws(() => validateBriefingSettings(baseSettings({ customSources: [{ name: '\u5185\u7f51', url: 'https://192.168.56.10/feed' }] })), /custom sources/i);
  assert.throws(() => validateBriefingSettings(baseSettings({ categories: ['nope'] })), /invalid notification settings/i);
});

test("Custom categories tag items by keywords and custom sources participate in collection", async () => {
  const rss = '<?xml version="1.0"?><rss><channel><item><title>\u5149\u523b\u673a\u56fd\u4ea7\u5316\u63d0\u901f</title><link>https://example.com/a1</link><description>\u82af\u7247 \u8bbe\u5907</description><pubDate>Sat, 17 Oct 2026 08:00:00 +0800</pubDate></item></channel></rss>';
  const fetcher = async url => new Response(String(url).includes('example.com') ? rss : rss, { status: 200 });
  const result = await collectNews({ categories: ['ai'], sourceIds: ['openai'], customSources: [{ id: 'ex', name: '\u793a\u4f8b\u6e90', url: 'https://example.com/feed.xml' }], customCategories: [{ label: '\u82af\u7247', keywords: ['\u5149\u523b\u673a'] }], now: Date.parse('2026-10-17T09:00:00+08:00'), fetcher });
  const tagged = result.items.find(row => row.title.includes('\u5149\u523b\u673a'));
  assert.ok(tagged, "Custom-source items are collected");
  assert.ok(tagged.tags.includes('\u82af\u7247'), "Custom category tags are matched");
  assert.ok(result.sourceStatus.some(status => status.name === '\u793a\u4f8b\u6e90'));
});

test("Likes accumulate and can be removed; saving settings preserves accumulated preferences", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'briefing-'));
  const store = { readBriefing: () => null, listBriefings: () => [], saveBriefing: () => {} };
  const service = createBriefingService({ store, runtimeDir, runner: async () => '{}' });
  const settings = { ...service.settings(), enabled: true };
  service.configure(settings);
  assert.deepEqual(service.toggleLike(['ai', 'openai'], 'like').likes, { ai: 1, openai: 1 });
  assert.deepEqual(service.toggleLike(['ai'], 'like').likes, { ai: 2, openai: 1 });
  assert.deepEqual(service.toggleLike(['openai'], 'unlike').likes, { ai: 2 }, "Removing the final like removes its zero weight");
  const metadata = service.configure({ ...settings, maxItems: 100 });
  assert.equal(metadata.settings.maxItems, 100);
  assert.deepEqual(metadata.settings.likes, { ai: 2 }, "Saving settings preserves like weights");
  assert.deepEqual(CATEGORIES.map(c => c.id), ['ai', 'economy', 'policy', 'headlines']);
  assert.ok(NEWS_SOURCES.length >= 5);
});
