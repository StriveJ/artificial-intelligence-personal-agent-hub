import { readWebJson, webProblem } from '../web-transport.mjs';

export async function deepseekSearch({ query, count, apiKey, signal, fetcher }) {
  const data = await request('search', { query, count, need_content: false }, { apiKey, signal, fetcher });
  if (!Array.isArray(data.results)) throw webProblem("Invalid DeepSeek search response format", 502, 'invalid_response');
  return data.results.slice(0, count).map(row => ({
    title: row?.title, url: row?.url, snippet: row?.snippet || row?.summary || '',
    publishedAt: typeof row?.date === 'string' && Number.isFinite(Date.parse(row.date)) ? new Date(row.date).toISOString() : null,
  }));
}

export async function deepseekFetch({ url, apiKey, signal, fetcher }) {
  const data = await request('fetch', { url }, { apiKey, signal, fetcher });
  if (typeof data.title !== 'string' || typeof data.content !== 'string' || !data.content.trim()) {
    throw webProblem("DeepSeek returned no usable page content", 502, 'invalid_response');
  }
  return { title: data.title.slice(0, 240), content: data.content.slice(0, 40_000) };
}

async function request(operation, body, { apiKey, signal, fetcher }) {
  const response = await fetcher(`https://api.deepseek.com/v1/tools/${operation}`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return readWebJson(response, 'DeepSeek');
}
