import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, cpSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { LANGUAGES, DEFAULT_MESSAGES, DEFAULT_LANGUAGE, matchBrowserLanguage } from '../public/languages.js';
import { validateTranslation, validateLanguageRegistry, validLocaleId, localeAssetEntries } from '../lib/ui-locale-validation.mjs';
import { translationTemplate, checkLocales, unregisteredReferences, unregisteredHtmlReferences } from '../scripts/ui-locales.mjs';

test('Every registered language covers the single default table, and all literal/static UI references are registered', () => {
  assert.deepEqual(validateLanguageRegistry(LANGUAGES, DEFAULT_MESSAGES, DEFAULT_LANGUAGE), []);
  assert.deepEqual(checkLocales(), []);
});

test('Translation validation reports missing, empty, extra keys and changed interpolation slots', () => {
  const defaults = { greeting: 'Hello {0}', count: '{0} / {1}' };
  assert.deepEqual(validateTranslation(defaults, { greeting: 'Bonjour {0}', count: '{1} / {0}' }), []);
  assert.deepEqual(validateTranslation(defaults, { count: '{0}', extra: 'Unexpected' }), [
    { code: 'missing', key: 'greeting' }, { code: 'placeholders', key: 'count' }, { code: 'extra', key: 'extra' },
  ]);
  assert.equal(validateTranslation(defaults, { greeting: '', count: 3 }).every(item => item.code === 'empty-or-invalid'), true);
  assert.deepEqual(validateTranslation(defaults, null), [{ code: 'invalid-table' }]);
});

test('New language matching is generic and prefers specific regional aliases', () => {
  const languages = [...LANGUAGES, { id: 'fr', aliases: ['fr'] }, { id: 'fr-CA', aliases: ['fr-CA'] }];
  assert.equal(matchBrowserLanguage('fr-BE', languages), 'fr');
  assert.equal(matchBrowserLanguage('FR-ca', languages), 'fr-CA');
  assert.equal(matchBrowserLanguage('unknown', languages), undefined);
  for (const id of ['../ja', 'auto', 'fr_CA', 'ja/file', '']) assert.equal(validLocaleId(id), false);
  assert.equal(validLocaleId('pt-BR'), true);
  assert.throws(() => localeAssetEntries([{ id: '../private' }]), /Invalid locale asset id/);
  assert.deepEqual(localeAssetEntries([{ id: 'fr' }]), [['/locales/fr.js', ['locales/fr.js', 'text/javascript; charset=utf-8']]]);
  assert.equal(validateLanguageRegistry([...LANGUAGES, LANGUAGES[0]], DEFAULT_MESSAGES, DEFAULT_LANGUAGE).some(item => item.code === 'invalid-or-duplicate-id'), true);
});

test('Catalog checks flag unregistered UI labels but skip code, public footer values and punctuation', () => {
  assert.deepEqual(unregisteredReferences("t('Registered'); t(\"Missing {0}\", 1)", { Registered: 'Registered' }), ['Missing {0}']);
  assert.deepEqual(unregisteredReferences("t('It\\'s registered')", { "It's registered": 'Registered' }), []);
  assert.deepEqual(unregisteredReferences("t('A \\u{1f64f} B')", { 'A \u{1f64f} B': 'Registered' }), []);
  const html = '<label aria-label="New label">Registered</label><code>Preserve code</code><footer id="site-footer">Private deployment text</footer><p>&amp; &#160;</p>';
  assert.deepEqual(unregisteredHtmlReferences(html, { Registered: 'Registered' }), ['New label']);
  assert.deepEqual(unregisteredHtmlReferences('<button title="Count > zero">Registered</button>', { Registered: 'Registered', 'Count > zero': 'Count > zero' }), []);
});

class Text {
  constructor(value) { this.nodeType = 3; this.textContent = value; this.isConnected = true; }
}
class Element {
  constructor(tag, attrs = {}) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.id = attrs.id; this.childNodes = []; this.attrs = new Map(Object.entries(attrs)); this.isConnected = true; this.events = {}; }
  get firstChild() { return this.childNodes[0]; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { for (const child of this.childNodes) child.isConnected = false; this.childNodes = [new Text(String(value))]; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  replaceChildren(...children) { for (const child of this.childNodes) child.isConnected = false; this.childNodes = children; }
  addEventListener(name, listener) { this.events[name] = listener; }
}

test('Adding a pack and one registry entry enables matching, both menus, text updates and HTTP assets without editing pages or server', async tcase => {
  const parent = resolve('aipa-test-tmp'); mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(join(parent, 'locale-registry-'));
  let hub;
  tcase.after(async () => { await hub?.close(); assert.ok(resolve(base).startsWith(parent + sep)); rmSync(base, { recursive: true, force: true }); });
  for (const dir of ['public', 'lib', 'scripts']) cpSync(resolve(dir), join(base, dir), { recursive: true });
  for (const file of ['package.json', 'server.mjs']) copyFileSync(resolve(file), join(base, file));

  const cli = join(base, 'scripts/ui-locales.mjs');
  execFileSync(process.execPath, [cli, 'template', 'fr'], { stdio: 'pipe', windowsHide: true });
  const pack = join(base, 'public/locales/fr.js'), original = readFileSync(pack, 'utf8');
  assert.equal(original, translationTemplate(DEFAULT_MESSAGES));
  assert.throws(() => execFileSync(process.execPath, [cli, 'template', 'fr'], { stdio: 'pipe', windowsHide: true }));
  assert.equal(readFileSync(pack, 'utf8'), original, 'Generating again must preserve an existing translator draft');
  writeFileSync(pack, translationTemplate({ ...DEFAULT_MESSAGES, Notes: 'Synthetic notes [fr]', 'Browser default': 'Synthetic automatic [fr]' }));
  const registryPath = join(base, 'public/languages.js');
  writeFileSync(registryPath, "import french from './locales/fr.js';\n" + readFileSync(registryPath, 'utf8').replace('export const LANGUAGES = Object.freeze([', "export const LANGUAGES = Object.freeze([\n  Object.freeze({ id: 'fr', label: 'Synthetic French', aliases: ['fr'], direction: 'ltr', messages: french }),"));
  execFileSync(process.execPath, [cli, 'check'], { stdio: 'pipe', windowsHide: true });

  const client = await import(pathToFileURL(join(base, 'public/i18n.js')));
  assert.equal(client.resolveLanguage('auto', ['fr-BE', 'en']), 'fr');
  const root = new Element('html'), heading = new Element('h1'); heading.textContent = 'Notes';
  const selects = [new Element('select'), new Element('select')]; root.childNodes.push(heading, ...selects);
  const doc = { documentElement: root, createElement: name => new Element(name), querySelectorAll: () => selects };
  client.initializeLanguage(doc, { addEventListener() {} });
  assert.deepEqual(selects.map(select => select.childNodes.map(option => option.value)), [['auto', 'fr', 'en', 'zh-CN'], ['auto', 'fr', 'en', 'zh-CN']]);
  selects[0].value = 'fr'; selects[0].events.change();
  assert.equal(heading.textContent, 'Synthetic notes [fr]');
  assert.equal(selects[1].value, 'fr'); assert.equal(root.lang, 'fr'); assert.equal(root.dir, 'ltr');
  assert.equal(selects[0].childNodes[0].textContent, 'Synthetic automatic [fr]');

  const instance = join(base, 'instance'); mkdirSync(instance);
  execFileSync('git', ['init', '--quiet', instance], { stdio: 'pipe', windowsHide: true });
  writeFileSync(join(instance, 'AIPA-MANIFEST.yaml'), 'aipa:\n  owner: Synthetic\n  version: synthetic\n');
  const { createHub } = await import(pathToFileURL(join(base, 'server.mjs')));
  hub = await createHub({ root: instance, runtimeDir: join(base, 'runtime'), port: 0, testMode: true,
    adapter: { owner: 'Synthetic', version: 'synthetic', requiresConsent: () => true, search: async () => [] },
    runner: async () => assert.fail('Language assets cannot call a model') });
  hub.scheduler.start = () => {};
  const url = await hub.listen(), response = await fetch(url + '/locales/fr.js');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /Synthetic notes \[fr\]/);
  assert.equal((await fetch(url + '/locales/unregistered.js')).status, 401, 'Only registered assets bypass the normal authentication gate');
});
