import { t, setText, setUiAttribute, localizedText } from './i18n.js';
export const NAV_ITEMS = Object.freeze([
  { id: 'chat', label: "Chat", short: "Chat", icon: '◌' },
  { id: 'notes', label: "Notes", short: "Notes", icon: '✎' },
  { id: 'memory', label: "Memory", short: "Memory", icon: '⌕' },
  { id: 'tasks', label: "Scheduled tasks", short: "Schedule", icon: '◷' },
  { id: 'dispatch', label: "Task dispatch", short: "Dispatch", icon: '➤' },
  { id: 'status', label: "Runtime status", short: "Status", icon: '◎' },
  { id: 'pushes', label: "Notifications", short: "Push", icon: '✧' },
  { id: 'connect', label: "Connection and devices", short: "Connect", icon: '↗' },
]);
export const DEFAULT_PINS = Object.freeze(['chat', 'notes', 'memory']);
export function normalisePins(value) {
  if (!Array.isArray(value)) return [...DEFAULT_PINS];
  return [...new Set(value.filter(id => NAV_ITEMS.some(item => item.id === id)))];
}
export function createNavigation({ onNavigate, onConnect, notify }) {
  const $ = id => document.getElementById(id), drawer = $('sidebar-dialog');
  let pins;
  try { const saved = localStorage.getItem('aipa-bottom-nav-v1'); pins = saved === null ? [...DEFAULT_PINS] : normalisePins(JSON.parse(saved)); }
  catch { pins = [...DEFAULT_PINS]; }
  let active = 'chat', unread = 0;
  const el = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) setText(node, value); return node; };
  function activate(id) { drawer.close(); if (id === 'connect') onConnect(); else onNavigate(id); }
  function itemButton(item, compact = false) {
    const button = el('button', compact ? 'bottom-shortcut' : 'nav-button'); button.type = 'button';
    button.dataset.nav = item.id; button.classList.toggle('active', active === item.id);
    if (active === item.id) button.setAttribute('aria-current', 'page');
    const icon = el('span', 'nav-icon', () => (item.icon)); icon.setAttribute('aria-hidden', 'true');
    button.append(icon, localizedText(() => ((compact ? t(item.short) : t(item.label)))));
    if (item.id === 'pushes') { const badge = el('small', 'push-badge'); badge.hidden = !unread; setText(badge, () => ((unread > 9 ? '9+' : String(unread)))); button.append(badge); }
    button.onclick = () => activate(item.id); return button;
  }
  function pinButton(item) {
    const pinned = pins.includes(item.id), button = el('button', 'pin-button', () => ((pinned ? t("✓ Pinned") : t("＋ Pin"))));
    button.type = 'button'; button.setAttribute('aria-pressed', String(pinned));
    setUiAttribute(button, 'aria-label', () => (t("{0}{1}", (pinned ? t("Remove from bottom") : t("Add to bottom")), ' ' + t(item.label))));
    setUiAttribute(button, 'title', () => ((pinned ? t('Remove from bottom navigation') : t('Add to bottom navigation'))));
    button.onclick = () => {
      const originNav = button.closest('nav')?.id;
      pins = pinned ? pins.filter(id => id !== item.id) : [...pins, item.id];
      let saved = true; try { localStorage.setItem('aipa-bottom-nav-v1', JSON.stringify(pins)); } catch { saved = false; }
      render(); notify((saved ? t('Bottom navigation saved in this browser') : t('Layout updated; this browser does not allow saving preferences')));
      const replacement = [...document.querySelectorAll('.pin-button')].find(b => b.closest('nav')?.id === originNav && b.dataset.pin === item.id);
      replacement?.focus();
    };
    button.dataset.pin = item.id; return button;
  }
  function render() {
    for (const target of [$('desktop-navigation'), $('drawer-navigation')]) {
      target.replaceChildren();
      for (const item of NAV_ITEMS) {
        const row = el('div', 'navigation-row'); row.append(itemButton(item), pinButton(item)); target.append(row);
      }
    }
    const bottom = $('bottom-navigation'); bottom.replaceChildren(); bottom.hidden = !pins.length;
    bottom.style.setProperty('--nav-count', String(Math.max(1, pins.length)));
    for (const id of pins) bottom.append(itemButton(NAV_ITEMS.find(i => i.id === id), true));
    document.body.classList.toggle('without-bottom-nav', !pins.length);
  }
  $('open-sidebar').onclick = () => { if (!drawer.open) drawer.showModal(); };
  drawer.addEventListener('click', event => { if (event.target === drawer && event.clientX >= drawer.getBoundingClientRect().right) drawer.close(); });
  render();
  return {
    close: () => drawer.close(),
    setActive(id) {
      active = id;
      for (const button of document.querySelectorAll('[data-nav]')) {
        const selected = button.dataset.nav === id; button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      }
    },
    setUnread(count) {
      unread = count;
      for (const badge of document.querySelectorAll('.push-badge')) { badge.hidden = !count; setText(badge, () => ((count > 9 ? '9+' : String(count)))); }
    },
  };
}
