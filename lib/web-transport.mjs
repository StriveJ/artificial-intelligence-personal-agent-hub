export const webProblem = (message, status = 502, code = 'search_failed') => Object.assign(new Error(message), { status, code });

export async function readWebText(response, label, maxBytes = 2_000_000) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const hint = { 401: "Invalid or expired API key", 402: "Insufficient account balance", 403: "Access denied", 404: "No usable page content", 429: "Too many requests. Retry later." }[response.status];
    throw webProblem(`${label} ${hint || "Request incomplete"} (HTTP ${response.status})`, response.status, `upstream_${response.status}`);
  }
  const chunks = []; let bytes = 0;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {}); throw webProblem("Web material too large; reading stopped", 502, 'response_too_large');
  }
  if (!response.body) throw webProblem("Web service returned no content", 502, 'invalid_response');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw webProblem("Web material too large; reading stopped", 502, 'response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readWebJson(response, label) {
  const raw = await readWebText(response, label);
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw webProblem(`${label} returned an invalid format`, 502, 'invalid_response'); }
}
