import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSourceFiles } from './helpers/public-source-files.mjs';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.md','.txt','.yaml','.yml','.json','.mjs','.cjs','.js','.html','.css','.svg','.sh','.ps1','.webmanifest','.gitattributes','.gitignore']);
const nativeScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Hebrew}]/u;
const isReadme = file => /^README(?:[_-][A-Za-z-]+)?(?:\.md|\.txt)?$/i.test(basename(file));

test('Repository text is English outside README translations; native fixtures use explicit Unicode escapes', () => {
  const files = publicSourceFiles(root);
  const findings = [];
  for (const file of new Set(files)) {
    const absolute = join(root,file);
    if (!existsSync(absolute)) continue;
    assert.equal(lstatSync(absolute).isSymbolicLink(),false,`Unexpected public source link: ${file}`);
    if (nativeScript.test(file)) findings.push(`${file}: filename`);
    if (isReadme(file)) continue;
    if (extname(file) && !textExtensions.has(extname(file))) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let index=0; index<lines.length; index++) if (nativeScript.test(lines[index])) findings.push(`${file}:${index+1}`);
  }
  assert.deepEqual(findings,[],'Public source, comments, protocols, and templates must use English; README translations are the only text exception');
});
