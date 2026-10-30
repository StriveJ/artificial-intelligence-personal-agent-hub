import { t, setText, setUiAttribute } from './i18n.js';
import { Marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

const parser = new Marked({ gfm: true, breaks: true, async: false });
const tags = ['p', 'br', 'strong', 'em', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'];

// Only parsed and sanitized fragments enter the DOM; raw HTML cannot use scripts, media, forms, or inline styles.
export function renderMarkdown(text) {
  const root = document.createElement('div');
  root.className = 'markdown-body';
  const fragment = DOMPurify.sanitize(parser.parse(String(text || '')), {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  root.append(fragment);
  for (const element of root.querySelectorAll('[class]')) {
    const language = element.tagName === 'CODE' && [...element.classList].find(name => /^language-[\w+-]{1,40}$/.test(name));
    if (language) element.className = language;
    else element.removeAttribute('class');
  }
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (!/^(?:https?:\/\/|mailto:)/i.test(href)) { link.removeAttribute('href'); continue; }
    link.target = '_blank'; link.rel = 'noopener noreferrer';
  }
  for (const input of root.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove();
    else { input.disabled = true; input.tabIndex = -1; setUiAttribute(input, 'aria-label', () => ((input.checked ? t("Completed") : t("Incomplete")))); }
  }
  for (const table of root.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'markdown-table'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); setUiAttribute(wrap, 'aria-label', () => (t('Table, scroll horizontally')));
    table.replaceWith(wrap); wrap.append(table);
  }
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const wrap = document.createElement('div'); wrap.className = 'code-block';
    const bar = document.createElement('div'); bar.className = 'code-toolbar';
    const language = document.createElement('span');
    setText(language, () => (([...code.classList].find(name => name.startsWith('language-'))?.slice(9) || t("Code"))));
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'copy-code'; setText(button, () => (t("Copy code")));
    setUiAttribute(button, 'aria-label', () => (t('Copy this code block')));
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        setText(button, () => (t("Copied")));
      } catch { setText(button, () => (t('Press and hold the code to copy it'))); }
      setTimeout(() => { setText(button, () => (t("Copy code"))); }, 2000);
    };
    bar.append(language, button); pre.replaceWith(wrap); wrap.append(bar, pre);
  }
  return root;
}
