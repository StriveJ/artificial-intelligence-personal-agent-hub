const slots = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
const table = value => value && typeof value === 'object' && !Array.isArray(value);
export const validLocaleId = value => typeof value === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) && value !== 'auto';
export function localeAssetEntries(languages) {
  return languages.map(({ id }) => {
    if (!validLocaleId(id)) throw Error('Invalid locale asset id');
    return [`/locales/${id}.js`, [`locales/${id}.js`, 'text/javascript; charset=utf-8']];
  });
}

export function validateTranslation(defaults, messages) {
  const errors = [];
  if (!table(messages)) return [{ code: 'invalid-table' }];
  for (const [key, source] of Object.entries(defaults)) {
    if (!Object.hasOwn(messages, key)) { errors.push({ code: 'missing', key }); continue; }
    const value = messages[key];
    if (typeof value !== 'string' || !value.trim()) { errors.push({ code: 'empty-or-invalid', key }); continue; }
    if (JSON.stringify(slots(source)) !== JSON.stringify(slots(value))) errors.push({ code: 'placeholders', key });
  }
  for (const key of Object.keys(messages)) if (!Object.hasOwn(defaults, key)) errors.push({ code: 'extra', key });
  return errors;
}

export function validateLanguageRegistry(languages, defaults, defaultId) {
  const errors = [], ids = new Set(), aliases = new Map();
  for (const language of languages) {
    const { id, label, direction } = language;
    if (!validLocaleId(id) || ids.has(id.toLowerCase())) errors.push({ code: 'invalid-or-duplicate-id', id });
    ids.add(String(id).toLowerCase());
    if (typeof label !== 'string' || !label.trim() || !['ltr', 'rtl'].includes(direction)) errors.push({ code: 'invalid-metadata', id });
    if (!Array.isArray(language.aliases) || !language.aliases.length) errors.push({ code: 'invalid-aliases', id });
    for (const alias of Array.isArray(language.aliases) ? language.aliases : []) {
      if (!validLocaleId(alias) || aliases.has(alias.toLowerCase()) && aliases.get(alias.toLowerCase()) !== id) errors.push({ code: 'invalid-or-duplicate-alias', id, alias });
      aliases.set(String(alias).toLowerCase(), id);
    }
    for (const error of validateTranslation(defaults, language.messages)) errors.push({ id, ...error });
  }
  if (!languages.some(language => language.id === defaultId)) errors.push({ code: 'missing-default-language', id: defaultId });
  return errors;
}
