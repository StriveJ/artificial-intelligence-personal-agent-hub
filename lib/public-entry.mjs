const ENTRY_PATTERN = /\.hz-1\.aicp\.space$/;

export const tunnelOrigin = raw => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:') return null;
    if (!ENTRY_PATTERN.test(url.hostname)) return null;
    return `https://${url.hostname}`;
  } catch { return null; }
};

export function parseTunnelLog(text) {
  if (typeof text !== 'string') return null;
  const urls = [...text.matchAll(/"publicUrl"\s*:\s*"([^"]+)"/g)];
  const last = urls.length ? urls[urls.length - 1][1] : null;
  if (!last) return null;
  const plain = [...text.matchAll(/session expires at ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+-][0-9]{2}:[0-9]{2})/g)].pop()?.[1];
  const escaped = [...text.matchAll(/expires_at\\?"?\s*:\s*\\?"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+-][0-9]{2}:[0-9]{2})/g)].pop()?.[1];
  const expires = plain || escaped || null;
  const code = [...text.matchAll(/"user_code"\s*:\s*"([A-Z0-9-]+)"/g)].pop()?.[1] || null;
  const claimed = /"claimed"\s*:\s*true/.test(text);
  let verifyCode = null;
  try { verifyCode = new URL(last).searchParams.get('verify_code'); } catch {  }
  return { raw: last, url: tunnelOrigin(last), verifyCode, userCode: code, expiresAt: Number.isFinite(Date.parse(expires || '')) ? new Date(expires).toISOString() : null, claimed };
}

export function mergeTunnelOrigin(origins, url) {
  if (!Array.isArray(origins) || !url) return Array.isArray(origins) ? origins : [];
  const kept = origins.filter(origin => {
    try { return !ENTRY_PATTERN.test(new URL(origin).hostname); } catch { return true; }
  });
  return [...new Set([...kept, url])];
}

export const needsRebuild = (expiresAt, now = Date.now(), leadMs = 15 * 60_000) => {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - now <= leadMs;
};
