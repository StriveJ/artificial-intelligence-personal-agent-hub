import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { DEFAULT_MESSAGES, DEFAULT_LANGUAGE, LANGUAGES } from '../public/languages.js';
import { validLocaleId, validateLanguageRegistry } from '../lib/ui-locale-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function translationTemplate(defaults) {
  return '// Translate the values from en.js; retain keys and {n} placeholders.\n// Import this file and register its language in public/languages.js when ready.\nexport default Object.freeze(' + JSON.stringify(defaults, null, 2) + ');\n';
}

// Check literal t() references without executing page code or adding a parser dependency.
function stringValue(literal) {
  if (literal[0] === '"') return JSON.parse(literal);
  return literal.slice(1, -1).replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r?\n|[^])/g, (_, value) => {
    if (value[0] === '\n' || value[0] === '\r') return '';
    if (value.startsWith('u{')) return String.fromCodePoint(parseInt(value.slice(2, -1), 16));
    if (value[0] === 'u' || value[0] === 'x') return String.fromCharCode(parseInt(value.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[value] ?? value;
  });
}
export function unregisteredReferences(source, defaults) {
  return [...source.matchAll(/\bt\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)]
    .map(match => stringValue(match[1])).filter(key => !Object.hasOwn(defaults, key));
}
const decodeHtml = text => text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, code) => code[0] === '#' ? String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase() === 'x' ? 2 : 1), code[1].toLowerCase() === 'x' ? 16 : 10)) : ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[code.toLowerCase()]);
export function unregisteredHtmlReferences(source, defaults) {
  const missing = new Set(), stack = [], ignored = new Set(['script', 'style', 'svg', 'code']);
  const voidTags = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'source', 'wbr', 'area', 'base', 'embed', 'param', 'track', 'col']);
  const check = text => { const key = decodeHtml(text).trim(); if (/[\p{L}]/u.test(key) && !Object.hasOwn(defaults, key)) missing.add(key); };
  for (const [token] of source.matchAll(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g)) {
    if (token.startsWith('<!--') || /^<!/i.test(token)) continue;
    const closing = token.match(/^<\/([\w-]+)/);
    if (closing) { const index = stack.findLastIndex(item => item.tag === closing[1].toLowerCase()); if (index >= 0) stack.length = index; continue; }
    const opening = token.match(/^<([\w-]+)/);
    if (opening) {
      const tag = opening[1].toLowerCase(), skip = stack.some(item => item.skip) || ignored.has(tag) || /\bid=["']site-footer["']/.test(token);
      if (!skip) for (const match of token.matchAll(/\b(?:aria-label|title|placeholder|alt|data-prompt)\s*=\s*(["'])(.*?)\1/g)) check(match[2]);
      if (!voidTags.has(tag) && !/\/>$/.test(token)) stack.push({ tag, skip });
    } else if (!stack.some(item => item.skip)) check(token);
  }
  return [...missing];
}
export function checkLocales() {
  const errors = validateLanguageRegistry(LANGUAGES, DEFAULT_MESSAGES, DEFAULT_LANGUAGE);
  for (const name of readdirSync(join(root, 'public')).filter(name => name.endsWith('.js'))) {
    for (const key of unregisteredReferences(readFileSync(join(root, 'public', name), 'utf8'), DEFAULT_MESSAGES)) errors.push({ code: 'unregistered-message', file: name, key });
  }
  for (const key of unregisteredHtmlReferences(readFileSync(join(root, 'public/index.html'), 'utf8'), DEFAULT_MESSAGES)) errors.push({ code: 'unregistered-message', file: 'index.html', key });
  return errors;
}
function main(args) {
  if (args[0] === 'template' && args.length === 2) {
    const id = args[1];
    if (!validLocaleId(id)) throw Error('Use a locale id such as ja, fr, or pt-BR');
    const target = join(root, 'public', 'locales', id + '.js');
    writeFileSync(target, translationTemplate(DEFAULT_MESSAGES), { flag: 'wx' });
    console.log(`Created public/locales/${id}.js with ${Object.keys(DEFAULT_MESSAGES).length} registered messages. Translate its values, then register it in public/languages.js.`);
    return;
  }
  if (args.length !== 1 || args[0] !== 'check') throw Error('Usage: node scripts/ui-locales.mjs check | template <locale-id>');
  const errors = checkLocales();
  if (errors.length) { for (const error of errors) console.error(JSON.stringify(error)); process.exitCode = 1; return; }
  console.log(`Validated ${Object.keys(DEFAULT_MESSAGES).length} registered messages across ${LANGUAGES.length} languages; keys, placeholders, and literal UI references match.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.code === 'EEXIST' ? 'Locale file already exists; nothing was overwritten.' : error.message); process.exitCode = 1; }
}
