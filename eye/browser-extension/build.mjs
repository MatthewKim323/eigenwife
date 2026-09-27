import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
const base = new URL('./', import.meta.url);
const output = new URL('./dist/', base);
await mkdir(output, {recursive: true});
for (const file of ['manifest.json', 'background.js', 'popup.html', 'popup.js'])
  await copyFile(new URL(file, base), new URL(file, output));
const client = await readFile(new URL('../src/eye/web/eye-client.js', base), 'utf8');
const targets = await readFile(new URL('../src/eye/web/dom-targets.js', base), 'utf8');
const entry = await readFile(new URL('content-entry.js', base), 'utf8');
const stripExports = code => code.replace(/^export\s+(?=(?:class|function|const|let)\b)/gm, '');
await writeFile(new URL('content.js', output), `(() => {\n${stripExports(client)}\n${stripExports(targets)}\n${entry}\n})();\n`);
console.log(`Load unpacked extension: ${output.pathname}`);
