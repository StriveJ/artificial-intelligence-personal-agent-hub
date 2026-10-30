import { join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';

export const ICP_URL = 'https://beian.miit.gov.cn/';
const fields = ['icpNumber', 'footerText', 'footerLinks'];
const invalid = message => Object.assign(new Error(message), { status: 400 });
function shape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid('Site settings accept only icpNumber, footerText and footerLinks');
}
function text(value, max, name, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/ : /[\u0000-\u001f\u007f<>]/).test(value)) throw invalid(`${name} must be plain text, up to ${max} characters`);
  return value.replace(/\r\n?/g, '\n').trim();
}
function linkUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u0020\u007f\\]/.test(value.trim())) throw invalid('Legal links require HTTPS URLs or paths starting with a single /');
  const target = value.trim();
  let url;
  try { url = new URL(target, 'https://site.invalid'); } catch { throw invalid('Invalid legal link URL'); }
  if (target.startsWith('/') && !target.startsWith('//') && url.origin === 'https://site.invalid') return target;
  if (!/^https:\/\//i.test(target) || url.protocol !== 'https:' || url.username || url.password) throw invalid('Legal links require credential-free HTTPS URLs or same-site paths');
  return url.href;
}
function validate(value) {
  shape(value);
  const links = value.footerLinks === undefined ? [] : value.footerLinks;
  if (!Array.isArray(links) || links.length > 8) throw invalid('Use up to 8 legal links');
  return {
    icpNumber: text(value.icpNumber === undefined ? '' : value.icpNumber, 80, 'ICP filing number'),
    footerText: text(value.footerText === undefined ? '' : value.footerText, 500, 'Footer text', true),
    footerLinks: links.map(link => {
      if (!link || typeof link !== 'object' || Array.isArray(link) || Object.keys(link).some(key => !['label', 'url'].includes(key))) throw invalid('Each legal link requires label and url');
      const label = text(link.label, 80, 'Link label');
      if (!label) throw invalid('Legal link labels cannot be empty');
      return { label, url: linkUrl(link.url) };
    }),
  };
}
export function createSiteSettings(runtimeDir, defaults = {}) {
  const file = join(runtimeDir, 'site-settings.json'), initial = validate(defaults);
  const get = () => ({ ...validate(readJson(file, initial)), icpUrl: ICP_URL });
  const update = value => {
    shape(value);
    if (!Object.keys(value).length) throw invalid('Provide at least one site setting');
    const current = validate(readJson(file, initial)), next = validate({ ...current, ...value });
    writeJson(file, next); return get();
  };
  return { get, update };
}
const escape = value => value.replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
export function renderSiteFooter({ icpNumber = '', footerText = '', footerLinks = [] }) {
  const links = [...(icpNumber ? [{ label: icpNumber, url: ICP_URL }] : []), ...footerLinks];
  if (!footerText && !links.length) return '<footer id="site-footer" class="site-footer" hidden></footer>';
  const paragraph = footerText ? `<p class="site-footer-text">${escape(footerText)}</p>` : '';
  const navigation = links.length ? `<nav class="site-footer-links" aria-label="Site legal information">${links.map(link => `<a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${escape(link.label)}</a>`).join('')}</nav>` : '';
  return `<footer id="site-footer" class="site-footer">${paragraph}${navigation}</footer>`;
}
