import { createHash } from 'node:crypto';

const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120) : '';

export function deepseekModelCredential({ engine, env = process.env }) {
  const base = engine === 'harness' ? env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic' : engine === 'claude' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  try {
    const url = new URL(base);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash || !['/','/anthropic','/anthropic/','/v1','/v1/'].includes(url.pathname)) return null;
    const apiKey = engine === 'harness' ? env.DEEPSEEK_API_KEY || '' : engine === 'claude' ? env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY : engine === 'codex' ? env.OPENAI_API_KEY : '';
    return typeof apiKey === 'string' && apiKey.trim() ? { apiKey:apiKey.trim() } : null;
  } catch { return null; }
}

export function modelProfile({ engine, runner, env = process.env }) {
  const base = engine === 'harness' ? env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic' : engine === 'claude' ? env.ANTHROPIC_BASE_URL || '' : env.OPENAI_BASE_URL || '';
  let host = ''; try { host = new URL(base).hostname; } catch {  }
  const provider = host === 'api.deepseek.com' ? 'DeepSeek' : host === 'api.anthropic.com' ? 'Anthropic' : host === 'api.openai.com' ? 'OpenAI' : host ? "Custom service" : "Managed by CLI configuration (unverified)";
  const requestedModel = clean(engine === 'harness' ? env.AIPA_HARNESS_MODEL || 'deepseek-flash' : engine === 'claude' ? env.ANTHROPIC_MODEL : env.AIPA_CODEX_MODEL) || null;
  const identity = { engine, base, requestedModel, credential: engine === 'harness' ? env.DEEPSEEK_API_KEY || '' : engine === 'claude' ? env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '' : env.OPENAI_API_KEY || '', runner: runner.identity || null };
  return { version: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), executor: engine === 'harness' ? 'DeepSeek Harness CLI' : engine === 'claude' ? 'Claude Code' : 'Codex CLI',
    provider, requestedModel, resolvedModel: null, evidence: requestedModel ? 'observable-config' : 'config-incomplete', available: runner.available !== false };
}
