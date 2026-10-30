import { LANGUAGES, DEFAULT_LANGUAGE, DEFAULT_MESSAGES, matchBrowserLanguage } from './languages.js';

export const LANGUAGE_KEY = 'aipa-ui-language-v1';
const supported = new Map(LANGUAGES.map(language => [language.id, language]));
export function resolveLanguage(preference, languages = [], registry = LANGUAGES) {
  if (registry.some(language => language.id === preference)) return preference;
  for (const language of languages) {
    const matched = matchBrowserLanguage(language, registry);
    if (matched) return matched;
  }
  return DEFAULT_LANGUAGE;
}
export function readPreference(storage) {
  try { const value = storage?.getItem(LANGUAGE_KEY); return supported.has(value) ? value : 'auto'; }
  catch { return 'auto'; }
}
const storage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
let preference = readPreference(storage());
const browserLanguages = () => typeof document === 'undefined' ? ['en'] : globalThis.navigator?.languages || [globalThis.navigator?.language || 'en'];
export const getLanguage = () => resolveLanguage(preference, browserLanguages());
export function t(source, ...values) {
  if (source === undefined || source === null) return source;
  const messages = supported.get(getLanguage())?.messages;
  const translated = messages && Object.hasOwn(messages, source) ? messages[source] : undefined;
  const template = typeof translated === 'string' && translated.trim() ? translated : Object.hasOwn(DEFAULT_MESSAGES, source) ? DEFAULT_MESSAGES[source] : source;
  return String(template).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}

// Bind only application-owned labels. User content is never passed through the catalog.
// Each text binding owns a text node, so switching cannot remove appended form controls.
const bindings = new Set(), nodeBindings = new WeakMap(), listeners = new Set();
const finalizer = new FinalizationRegistry(reference => bindings.delete(reference));
function bind(node, read, write, render, slot = 'text') {
  const slots = nodeBindings.get(node) || new Map();
  if (slots.has(slot)) bindings.delete(slots.get(slot).tracker);
  const binding = { ref: new WeakRef(node), read, write, render, last: undefined };
  binding.tracker = new WeakRef(binding);
  binding.last = String(render()); write(node, binding.last); bindings.add(binding.tracker);
  slots.set(slot, binding); nodeBindings.set(node, slots);
  finalizer.register(node, binding.tracker);
  return binding;
}
export function setText(node, value) {
  if (typeof value !== 'function') { node.textContent = value; return; }
  node.textContent = String(value());
  const target = node.firstChild?.nodeType === 3 ? node.firstChild : node;
  bind(target, n => n.textContent, (n, text) => { n.textContent = text; }, value);
}
export function localizedText(value, doc = document) {
  const node = doc.createTextNode(''); setText(node, value); return node;
}
export function setUiAttribute(node, name, value) {
  const render = typeof value === 'function' ? value : () => value;
  bind(node, n => n.getAttribute(name), (n, text) => n.setAttribute(name, text), render, 'attribute:' + name);
}
export function onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function refresh() {
  for (const reference of bindings) {
    const binding = reference.deref(), node = binding?.ref.deref();
    if (!node || node.isConnected === false || binding.read(node) !== binding.last) { bindings.delete(reference); continue; }
    binding.last = String(binding.render()); binding.write(node, binding.last);
  }
  for (const listener of listeners) listener(getLanguage(), preference);
}
export function setLanguage(value, { persist = true } = {}) {
  preference = supported.has(value) ? value : 'auto';
  if (persist) try { storage()?.setItem(LANGUAGE_KEY, preference); } catch { /* Session-only switching still works. */ }
  refresh();
}
export function initializeLanguage(doc = document, win = window) {
  // Capture the original HTML once, before any conversations or private settings are rendered.
  const visit = node => {
    if (node.nodeType === 3) {
      const source = node.textContent.trim();
      if (Object.hasOwn(DEFAULT_MESSAGES, source)) {
        const original = node.textContent, leading = original.match(/^\s*/)[0], trailing = original.match(/\s*$/)[0];
        setText(node, () => leading + t(source) + trailing);
      }
      return;
    }
    if (node.nodeType === 1) {
      if (['SCRIPT', 'STYLE', 'SVG', 'CODE'].includes(node.tagName) || node.id === 'site-footer') return;
      for (const name of ['aria-label', 'title', 'placeholder', 'alt', 'data-prompt']) {
        const source = node.getAttribute(name);
        if (source && Object.hasOwn(DEFAULT_MESSAGES, source)) setUiAttribute(node, name, () => t(source));
      }
    }
    for (const child of [...node.childNodes]) visit(child);
  };
  visit(doc.documentElement);
  const selects = [...doc.querySelectorAll('[data-language-select]')];
  for (const select of selects) {
    const automatic = doc.createElement('option'); automatic.value = 'auto';
    setText(automatic, () => t('Browser default'));
    select.replaceChildren(automatic, ...LANGUAGES.map(language => {
      const option = doc.createElement('option'); option.value = language.id; option.textContent = language.label; return option;
    }));
  }
  onLanguageChange((language, selected) => {
    doc.documentElement.lang = language;
    doc.documentElement.dir = supported.get(language)?.direction || 'ltr';
    for (const select of selects) select.value = selected;
  });
  for (const select of selects) select.addEventListener('change', () => setLanguage(select.value));
  win.addEventListener('storage', event => {
    if (event.key === LANGUAGE_KEY || event.key === null) setLanguage(readPreference(storage()), { persist: false });
  });
  win.addEventListener('languagechange', () => { if (preference === 'auto') refresh(); });
  refresh();
}
