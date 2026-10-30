import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHub } from '../server.mjs';

const TMP = resolve('aipa-test-tmp');
mkdirSync(TMP, { recursive: true });
const initial = 'Synthetic filing \u6d4b\u8bd5-1';
async function fixture(t, site = { icpNumber: initial }) {
  const base = mkdtempSync(join(TMP, 'site-')), root = join(base, 'instance'), runtimeDir = join(base, 'runtime');
  mkdirSync(root);
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'aipa:\n  version: 1.0.0\n  owner: Synthetic\n');
  let hub, url, cookie = '', calls = 0;
  const start = async () => {
    hub = await createHub({ root, runtimeDir, port: 0, publicPort: 0, publicOrigins: ['https://filing.example'], site,
      adapter: { owner: 'Synthetic', version: '1.0.0', requiresConsent: () => true, search: async () => [] },
      runner: async () => { calls++; throw Error('No model should run'); } });
    url = await hub.listen();
  };
  t.after(async () => { await hub?.close(); assert.ok(base.startsWith(TMP + sep)); rmSync(base, { recursive: true, force: true }); });
  await start();
  const request = (path, body, { publicEntry = false, headers = {}, anonymous = false } = {}) => new Promise((yes, no) => {
    const target = publicEntry ? `http://127.0.0.1:${hub.publicServer.address().port}` : url;
    const call = httpRequest(target + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(publicEntry ? { Host: 'filing.example' } : {}),
      ...(body === undefined ? {} : { Origin: publicEntry ? 'https://filing.example' : url, 'Content-Type': 'application/json' }),
      ...(cookie && !anonymous ? { Cookie: cookie } : {}), ...headers,
    } }, result => {
      const chunks = []; result.on('data', chunk => chunks.push(chunk));
      result.on('end', () => {
        const response = new Response(Buffer.concat(chunks), { status: result.statusCode, headers: result.headers });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        yes(response);
      });
    });
    call.on('error', no); call.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, runtimeDir, restart: async () => { await hub.close(); await start(); }, calls: () => calls };
}

test('Filing is present in anonymous public HTML, without JavaScript or private settings access', async t => {
  const blank = await fixture(t, {});
  assert.match(await (await blank.request('/', undefined, { publicEntry: true })).text(), /<footer id="site-footer" class="site-footer" hidden><\/footer>/);
  const f = await fixture(t);
  const response = await f.request('/', undefined, { publicEntry: true });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes(`<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${initial}</a>`));
  assert.doesNotMatch(html, /pairingCode|site-settings\.json/);
  assert.equal((await f.request('/api/site-settings', undefined, { publicEntry: true })).status, 401);
  assert.equal((await f.request('/api/site-settings', { icpNumber: 'untrusted' }, { publicEntry: true })).status, 401);
  assert.equal(f.calls(), 0);
});

test('Signed-in edits update public HTML, survive restart, and can explicitly clear the footer', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/local-login', {})).status, 200);
  const number = 'Synthetic filing \u6d4b\u8bd5-2';
  assert.equal((await f.request('/api/site-settings', { icpNumber: number }, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const saved = await f.request('/api/site-settings', { icpNumber: ` ${number} ` });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { icpNumber: number, footerText: '', footerLinks: [], icpUrl: 'https://beian.miit.gov.cn/' });
  assert.ok((await (await f.request('/', undefined, { publicEntry: true, anonymous: true })).text()).includes(number));
  await f.restart();
  assert.equal((await (await f.request('/api/site-settings')).json()).icpNumber, number);
  assert.equal((await f.request('/api/site-settings', { icpNumber: '' })).status, 200);
  await f.restart();
  const html = await (await f.request('/', undefined, { publicEntry: true, anonymous: true })).text();
  assert.match(html, /<footer id="site-footer" class="site-footer" hidden><\/footer>/);
  assert.ok(!html.includes(number));
  assert.equal(JSON.parse(readFileSync(join(f.runtimeDir, 'site-settings.json'))).icpNumber, '');
  assert.equal(f.calls(), 0);
});

test('Filing input rejects markup, control characters, destination overrides and invalid shapes without changing the saved value', async t => {
  const f = await fixture(t);
  await f.request('/api/local-login', {});
  for (const input of [{}, null, [], { icpNumber: null }, { icpNumber: 12 }, { icpNumber: '<img src=x onerror=alert(1)>' },
    { icpNumber: 'line\nbreak' }, { icpNumber: 'x'.repeat(81) }, { icpNumber: 'Example', icpUrl: 'javascript:alert(1)' }]) {
    assert.equal((await f.request('/api/site-settings', input)).status, 400);
  }
  assert.equal((await (await f.request('/api/site-settings')).json()).icpNumber, initial);
  const escaped = 'Synthetic filing & "quoted" $&';
  await f.request('/api/site-settings', { icpNumber: escaped });
  const html = await (await f.request('/', undefined, { publicEntry: true, anonymous: true })).text();
  assert.ok(html.includes('Synthetic filing &amp; &quot;quoted&quot; $&'));
  assert.equal((html.match(/<footer id="site-footer"/g) || []).length, 1);
});

test('International and mixed deployments preserve legal text and links across partial edits and restarts', async t => {
  const f = await fixture(t, {});
  await f.request('/api/local-login', {});
  const footerText = 'Synthetic operator notice\nSynthetic legal information';
  const footerLinks = [{ label: 'Privacy Policy', url: '/privacy' }, { label: 'Terms & Conditions', url: 'https://policies.example/terms?a=1&b=2' }, { label: 'Impressum', url: '/legal-notice#operator' }];
  const response = await f.request('/api/site-settings', { footerText, footerLinks });
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.icpNumber, '');
  assert.deepEqual(settings.footerLinks, footerLinks);
  let html = await (await f.request('/', undefined, { publicEntry: true, anonymous: true })).text();
  const footer = html.match(/<footer id="site-footer"[\s\S]*?<\/footer>/)[0];
  assert.ok(footer.includes(footerText));
  assert.ok(footer.includes('href="/privacy"'));
  assert.ok(footer.includes('https://policies.example/terms?a=1&amp;b=2'));
  assert.ok(footer.includes('Terms &amp; Conditions'));
  assert.ok(!footer.includes('beian.miit.gov.cn'));
  await f.request('/api/site-settings', { icpNumber: initial });
  await f.restart();
  const mixed = await (await f.request('/api/site-settings')).json();
  assert.equal(mixed.icpNumber, initial); assert.equal(mixed.footerText, footerText); assert.deepEqual(mixed.footerLinks, footerLinks);
  await f.request('/api/site-settings', { icpNumber: '' });
  html = await (await f.request('/', undefined, { publicEntry: true, anonymous: true })).text();
  assert.ok(html.includes('href="/privacy"'));
  assert.equal(f.calls(), 0);
});

test('Legal links reject executable URLs, external protocol-relative paths and oversized or malformed content atomically', async t => {
  const f = await fixture(t, {});
  await f.request('/api/local-login', {});
  await f.request('/api/site-settings', { footerText: 'Retain this notice' });
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'http://policies.example/legal', '//policies.example/legal', '/\\policies.example/legal', 'https://user:secret@policies.example/legal', 'https://policies.example/pri\tvacy', '../privacy', '']) {
    assert.equal((await f.request('/api/site-settings', { footerText: 'Do not save', footerLinks: [{ label: 'Policy', url }] })).status, 400);
  }
  for (const value of [{ footerText: '<script>alert(1)</script>' }, { footerText: 'x'.repeat(501) }, { footerLinks: null },
    { footerLinks: Array.from({ length: 9 }, () => ({ label: 'Policy', url: '/privacy' })) }, { footerLinks: [{ label: '', url: '/privacy' }] },
    { footerLinks: [{ label: 'Policy', url: '/privacy', html: 'untrusted' }] }]) {
    assert.equal((await f.request('/api/site-settings', value)).status, 400);
  }
  const settings = await (await f.request('/api/site-settings')).json();
  assert.equal(settings.footerText, 'Retain this notice'); assert.deepEqual(settings.footerLinks, []);
});

test('Existing ICP-only runtime settings retain their number and gain empty optional international fields', async t => {
  const f = await fixture(t, {});
  writeFileSync(join(f.runtimeDir, 'site-settings.json'), JSON.stringify({ icpNumber: initial }));
  await f.restart(); await f.request('/api/local-login', {});
  assert.deepEqual(await (await f.request('/api/site-settings')).json(), { icpNumber: initial, footerText: '', footerLinks: [], icpUrl: 'https://beian.miit.gov.cn/' });
});
