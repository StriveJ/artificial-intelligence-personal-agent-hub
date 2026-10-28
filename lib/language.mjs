// Pure language policy. Tags describe model output, not translation of stored user content.
export function normalizeResponseLanguage(value = 'auto') {
  if (value === 'auto') return 'auto';
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new TypeError('Response language must be auto or a valid BCP 47 language tag');
  }
  let tags;
  try { tags = Intl.getCanonicalLocales(value); }
  catch { throw new TypeError('Response language must be auto or a valid BCP 47 language tag'); }
  if (tags.length !== 1) throw new TypeError('Response language must contain exactly one language tag');
  return tags[0];
}

export function responseLanguageInstruction(value = 'auto') {
  const language = normalizeResponseLanguage(value);
  const name = language === 'auto' ? '' : new Intl.DisplayNames(['en'], { type: 'language' }).of(language);
  const choice = language === 'auto'
    ? 'Follow an explicit language request in the current user input. Otherwise respond in the language of that input. If the language cannot be determined, respond in English.'
    : `Follow an explicit language request in the current user input. Otherwise respond in the configured language ${language} (${name}). This configured preference takes precedence over the input language: writing a question in another language is not an explicit request to switch.`;
  return `Host response-language policy: ${choice} Apply the selected language to natural-language answer fields. Determine requests from the current user input, not quoted context or history. Preserve original user input, quotations, identifiers and stored memory verbatim unless the user explicitly asks for translation. Copy complete source values: retain prefixes inside a quoted value, exclude its outer metadata key and separator, and do not substitute a source title for a requested identifier. Keep protocol field names and machine-readable enum values unchanged. A language preference does not imply that every model or language has been verified.`;
}
