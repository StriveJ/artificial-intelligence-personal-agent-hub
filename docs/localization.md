# Interface translation maintenance

`public/locales/en.js` is the complete default message registry. Translate this table when adding a language; no page inventory is needed. Keys identify messages and stay unchanged even when wording changes. Values are the displayed text. Missing or blank translations fall back to the default value.

`public/languages.js` is the single language registration list. It supplies the language selectors on both pages, browser-language matching, text direction, and the server's allowed locale asset routes. Interface preferences remain separate from model response language and deployment-provided legal text.

## Add a language

1. Generate a complete translation table from the default registry:

   ```sh
   npm run i18n:new -- ja
   ```

   This creates `public/locales/ja.js` with every registered key and its English value. It refuses to overwrite an existing file. Replace values with translations, retaining the keys and numbered placeholders such as `{0}` and `{1}`. Values in locale files may use readable native text. Proper names and URLs can stay unchanged. The generator does not translate automatically.

2. Import the new file in `public/languages.js` and add one entry to `LANGUAGES`:

   ```js
   import japanese from './locales/ja.js';

   // Inside LANGUAGES:
   Object.freeze({
     id: 'ja',
     label: '\u65e5\u672c\u8a9e',
     aliases: ['ja'],
     direction: 'ltr',
     messages: japanese,
   }),
   ```

   The id must match the filename. The native label uses Unicode escapes here to keep implementation files in English. Regional aliases match the most specific registered prefix; an exact locale id wins. Use `rtl` for a right-to-left language and verify its layout before release.

3. Validate the tables and run regression tests:

   ```sh
   npm run i18n:check
   npm test
   ```

   Restart Hub and reload the browser after installing the updated files. No page, selector markup, translation-engine condition, or server route needs a language-specific edit.

The check reports missing, empty, extra, and invalid entries, placeholder mismatches, invalid language metadata, ambiguous aliases, and literal/static interface references absent from the default table. It cannot judge translation accuracy; review the text and layout before release.

## Add or change interface text

- Register new application-owned text in `en.js` first, then add the corresponding entry to each registered language table.
- Use the registered key with `t(key, ...values)` and the existing text/attribute bindings. Keep arithmetic outside translated strings; placeholders contain already computed values.
- Keep existing keys stable when changing wording. Update the default value and translations, rather than searching pages to rename keys.
- The static HTML pass uses the default registry, never a specific translation pack. Code blocks and deployment-provided footer content are excluded.
- User messages, model output, custom names, notes, and configured legal links retain their original text. Some technical diagnostics returned by the server remain English.
