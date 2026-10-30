import english from './locales/en.js';
import chinese from './locales/zh-CN.js';

export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_MESSAGES = english;

// Register a translated en.js table here. Menus, matching, and asset routes use this list.
// Each id must match its public/locales/<id>.js filename. Labels use the native language.
export const LANGUAGES = Object.freeze([
  Object.freeze({ id: 'en', label: 'English', aliases: ['en'], direction: 'ltr', messages: english }),
  Object.freeze({ id: 'zh-CN', label: '\u4e2d\u6587', aliases: ['zh-Hans', 'zh'], direction: 'ltr', messages: chinese }),
]);

export function matchBrowserLanguage(tag, languages = LANGUAGES) {
  if (typeof tag !== 'string') return undefined;
  const value = tag.toLowerCase();
  const exact = languages.find(language => language.id.toLowerCase() === value);
  if (exact) return exact.id;
  const matches = languages.flatMap(language => (language.aliases || []).map(alias => ({ alias: alias.toLowerCase(), id: language.id })));
  return matches.sort((a, b) => b.alias.length - a.alias.length).find(({ alias }) => value === alias || value.startsWith(alias + '-'))?.id;
}
