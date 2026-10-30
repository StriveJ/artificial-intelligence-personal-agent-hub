import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, readPreference, LANGUAGE_KEY, setLanguage, getLanguage, t, setText, setUiAttribute, initializeLanguage } from '../public/i18n.js';
import chinese from '../public/locales/zh-CN.js';

class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = text; this.isConnected = true; }
}
class Element {
  constructor(tag = 'DIV', attrs = {}) { this.nodeType = 1; this.tagName = tag; this.attrs = new Map(Object.entries(attrs)); this.childNodes = []; this.isConnected = true; this.id = attrs.id || ''; }
  get firstChild() { return this.childNodes[0]; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { for (const node of this.childNodes) node.isConnected = false; this.childNodes = value ? [new TextNode(String(value))] : []; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
}

test('UI language follows browser preferences, accepts supported saved choices, and falls back to English', () => {
  assert.equal(resolveLanguage('auto', ['zh-HK', 'en-US']), 'zh-CN');
  assert.equal(resolveLanguage('auto', ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLanguage('auto', ['fr-FR']), 'en');
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en');
  assert.equal(resolveLanguage('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(readPreference({ getItem: () => 'unsupported' }), 'auto');
  assert.equal(readPreference({ getItem() { throw Error('Blocked storage'); } }), 'auto');
});

test('Catalog preserves interpolation slots; dynamic values and unknown labels remain original text', () => {
  const slots = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, translated] of Object.entries(chinese)) assert.deepEqual(slots(translated), slots(source), source);
  setLanguage('zh-CN', { persist: false });
  assert.equal(t('Notes'), '\u968f\u624b\u8bb0');
  assert.equal(t('Sources · {0}', '<script>Notes</script>'), '\u6765\u6e90 · <script>Notes</script>');
  assert.equal(t('Synthetic unsupported label'), 'Synthetic unsupported label');
  setLanguage('en', { persist: false });
  assert.equal(t('Notes'), 'Notes');
});

test('Immediate switching preserves appended controls, raw user content, and deployment legal text', () => {
  setLanguage('en', { persist: false });
  const label = new Element(), input = new Element('INPUT'), raw = new Element();
  input.value = 'Draft: Notes / \u7b14\u8bb0'; input.checked = true;
  setText(label, () => t('Link label')); label.childNodes.push(input);
  setText(raw, 'Notes');
  setUiAttribute(input, 'placeholder', () => t('Privacy Policy'));
  setLanguage('zh-CN', { persist: false });
  assert.equal(label.childNodes[0].textContent, '\u94fe\u63a5\u540d\u79f0');
  assert.equal(label.childNodes[1], input);
  assert.equal(input.value, 'Draft: Notes / \u7b14\u8bb0'); assert.equal(input.checked, true);
  assert.equal(raw.textContent, 'Notes');
  assert.equal(input.getAttribute('placeholder'), '\u9690\u79c1\u653f\u7b56');
  setLanguage('en', { persist: false });
  assert.equal(label.childNodes[0].textContent, 'Link label');
  assert.equal(input.getAttribute('placeholder'), 'Privacy Policy');
});

test('Static bindings skip the public footer, synchronize other tabs, and do not translate later user content', tcase => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  tcase.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; setLanguage('en', { persist: false }); });
  const root = new Element('HTML'), heading = new Element('H1'), footer = new Element('FOOTER', { id: 'site-footer' }), code = new Element('CODE'), events = {};
  heading.textContent = 'Notes'; footer.textContent = 'Privacy Policy'; code.textContent = 'Notes'; root.childNodes.push(heading, footer, code);
  initializeLanguage({ documentElement: root, querySelectorAll: () => [] }, { addEventListener: (name, listener) => { events[name] = listener; } });
  const later = new Element(); later.textContent = 'Notes'; root.childNodes.push(later);
  setLanguage('zh-CN');
  assert.equal(values.get(LANGUAGE_KEY), 'zh-CN'); assert.equal(root.lang, 'zh-CN');
  assert.equal(heading.textContent, '\u968f\u624b\u8bb0');
  assert.equal(footer.textContent, 'Privacy Policy'); assert.equal(later.textContent, 'Notes');
  assert.equal(code.textContent, 'Notes', 'A code example matching a registered label must retain its original bytes');
  values.set(LANGUAGE_KEY, 'en'); events.storage({ key: LANGUAGE_KEY });
  assert.equal(getLanguage(), 'en'); assert.equal(heading.textContent, 'Notes');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Blocked'); } });
  assert.doesNotThrow(() => setLanguage('zh-CN'));
  assert.equal(heading.textContent, '\u968f\u624b\u8bb0');
});
