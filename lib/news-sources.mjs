export const CATEGORIES = Object.freeze([
  { id: 'ai', label: 'AI' }, { id: 'economy', label: "Economy" },
  { id: 'policy', label: "Public policy" }, { id: 'headlines', label: "Headlines" },
]);
export const NEWS_SOURCES = Object.freeze([
  { id: 'openai', name: "OpenAI official", category: 'ai', kind: 'rss', url: 'https://openai.com/news/rss.xml', hosts: ['openai.com'] },
  { id: 'cns-finance', name: "China News Service: Finance", category: 'economy', kind: 'rss', url: 'https://www.chinanews.com.cn/rss/finance.xml', hosts: ['www.chinanews.com.cn', 'www.chinanews.com'] },
  { id: 'cns-china', name: "China News Service: Politics", category: 'policy', kind: 'rss', url: 'https://www.chinanews.com.cn/rss/china.xml', hosts: ['www.chinanews.com.cn', 'www.chinanews.com'], policyOnly: true },
  { id: 'gov', name: "State Council of China", category: 'policy', kind: 'government', url: 'https://www.gov.cn/pushinfo/v150203/pushinfo.json', hosts: ['www.gov.cn'], policyOnly: true },
  { id: 'cns-news', name: "China News Service: Latest news", category: 'headlines', kind: 'rss', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', hosts: ['www.chinanews.com.cn', 'www.chinanews.com'] },
]);
const AI = /\u4eba\u5de5\u667a\u80fd|\u5927\u6a21\u578b|\u667a\u80fd\u4f53|\u7b97\u529b|\u673a\u5668\u5b66\u4e60|\bAI\b|LLM|DeepSeek|OpenAI|Claude|Codex|Agent|Gemini|Qwen|\u7aef\u4fa7/i;
const POLICY = /\u653f\u7b56|\u56fd\u52a1\u9662|\u610f\u89c1|\u529e\u6cd5|\u6761\u4f8b|\u901a\u77e5|\u89c4\u5212|\u6279\u590d|\u5b9e\u65bd\u65b9\u6848|\u6539\u9769|\u90e8\u59d4|\u8d22\u653f\u90e8|\u53d1\u6539\u59d4|\u53d1\u5c55\u6539\u9769\u59d4|\u5546\u52a1\u90e8|\u4eba\u6c11\u94f6\u884c/;
const decode = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
  const num = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n]);
export const plain = value => decode(decode(String(value)).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function field(xml, tag) { return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || ''; }
export function sourceLink(raw, source) {
  try {
    const url = new URL(decode(raw).trim());
    if (!['https:', 'http:'].includes(url.protocol) || !source.hosts.includes(url.hostname) || url.username || url.password || url.port) return null;
    url.protocol = 'https:'; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^spm$/.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
export function parseSource(text, source) {
  if (typeof text !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Unsupported source format");
  let raw;
  if (source.kind === 'government') {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error("Unsupported source format");
    raw = value.slice(0, 100).map(item => ({ title: item.title, link: item.link, excerpt: item.description, published: /^\d{4}-\d{2}-\d{2}$/.test(item.pubDate) ? `${item.pubDate}T00:00:00+08:00` : item.pubDate }));
  } else {
    if (!/<rss\b|<feed\b/i.test(text)) throw new Error("Unsupported source format");
    raw = [...text.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0, 100).map(([, , xml]) => ({
      title: field(xml, 'title'),
      link: field(xml, 'link') || xml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || field(xml, 'guid'),
      excerpt: field(xml, 'description') || field(xml, 'summary') || field(xml, 'content:encoded') || field(xml, 'content'),
      published: field(xml, 'pubDate') || field(xml, 'published') || field(xml, 'updated'),
    }));
  }
  return raw.flatMap(item => {
    const title = plain(item.title || '').slice(0, 240), url = sourceLink(item.link, source), published = Date.parse(decode(item.published));
    if (!title || !url || !Number.isFinite(published) || (source.policyOnly && !POLICY.test(title))) return [];
    return [{ title, url, excerpt: plain(item.excerpt || '').slice(0, 1600), publishedAt: new Date(published).toISOString(),
      sourceId: source.id, sourceName: source.name, category: AI.test(title) && source.category !== 'policy' ? 'ai' : source.category }];
  });
}
export async function fetchSource(source, fetcher = fetch) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetcher(source.url, { signal: controller.signal, redirect: 'error', headers: { 'User-Agent': 'AIPA-Hub/1.0 (+daily-briefing)', Accept: 'application/rss+xml, application/json, text/xml' } });
    if (!response.ok) throw new Error("Source temporarily unavailable");
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2_000_000) { controller.abort(); throw new Error("Source content too large"); }
      chunks.push(chunk);
    }
    return parseSource(Buffer.concat(chunks).toString('utf8'), source);
  } finally { clearTimeout(timer); }
}
export const MAX_ITEMS = 100;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?|fe80:|fc00:|fd00:)/i;
export function safeSourceUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.port && url.port !== '443') return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || PRIVATE.test(host) || /\.local$|\.internal$|\.lan$/.test(host)) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    url.hash = '';
    return { url: url.href, host };
  } catch { return null; }
}
export function hostOf(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; }
}
export async function collectNews({ categories, sourceIds, customSources = [], customCategories = [], now = Date.now(), previousUrls = [], maxItems = MAX_ITEMS, fetcher = fetch }) {
  const sources = NEWS_SOURCES.filter(s => sourceIds.includes(s.id) && (categories.includes(s.category) || categories.includes('ai') && s.id.startsWith('cns-')));
  for (const source of customSources) {
    const safe = safeSourceUrl(source?.url);
    if (!safe || typeof source.name !== 'string' || !source.name.trim()) continue;
    sources.push({ id: `custom-${source.id || safe.host}`, name: source.name.trim().slice(0, 30), category: 'headlines', kind: 'rss', url: safe.url, hosts: [safe.host], custom: true });
  }
  const outcomes = await Promise.allSettled(sources.map(s => fetchSource(s, fetcher)));
  const sourceStatus = sources.map((s, i) => ({ id: s.id, name: s.name, ok: outcomes[i].status === 'fulfilled', count: outcomes[i].status === 'fulfilled' ? outcomes[i].value.length : 0 }));
  if (!sourceStatus.some(s => s.ok)) throw Object.assign(new Error("All news sources temporarily unavailable; automatic retry scheduled"), { publicMessage: "All news sources temporarily unavailable; automatic retry scheduled" });
  const seen = new Set(previousUrls), titles = new Set();
  const fetched = outcomes.flatMap((r, i) => r.status === 'fulfilled' ? r.value.map(item => ({ ...item, customSource: Boolean(sources[i].custom) })) : []);
  const items = fetched.filter(item => {
    const age = now - Date.parse(item.publishedAt);
    const base = item.customSource || categories.includes(item.category);
    return (base || categories.length === 0) && age >= -300_000 && age <= (item.category === 'policy' ? 14 : 2) * 86400_000;
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).filter(item => {
    const title = item.title.toLowerCase().replace(/[\s\p{P}]/gu, '');
    if (seen.has(item.url) || titles.has(title)) return false;
    seen.add(item.url); titles.add(title); return true;
  }).map(item => {
    const matched = customCategories.filter(category => (category.keywords || []).some(keyword => item.title.includes(keyword) || (item.excerpt || '').includes(keyword))).map(category => category.label);
    return { ...item, tags: [...new Set([item.category, item.sourceId, ...matched])] };
  });
  return { items: items.slice(0, Math.max(1, Math.min(MAX_ITEMS, maxItems))), sourceStatus };
}
