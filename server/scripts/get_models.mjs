// Downloads the pinned name-finding models into server/models/ (gitignored) and checks every file's sha256.
// node scripts/get_models.mjs            the model in use
// node scripts/get_models.mjs --all      every listed model (for the comparison)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const {use, models} = JSON.parse(fs.readFileSync(path.join(root, 'ner_models.json'), 'utf8'));
const names = process.argv.includes('--all') ? Object.keys(models) : [use];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const name of names) {
  const {revision, files} = models[name];
  for (const [file, want] of Object.entries(files)) {
    const out = path.join(root, 'models', name, file);
    if (fs.existsSync(out) && sha256(out) === want) continue;
    fs.mkdirSync(path.dirname(out), {recursive: true});
    const response = await fetch(`https://huggingface.co/${name}/resolve/${revision}/${file}`);
    if (!response.ok) throw new Error(`${name}/${file}: HTTP ${response.status}`);
    fs.writeFileSync(out, Buffer.from(await response.arrayBuffer()));
    const got = sha256(out);
    if (got !== want) {
      fs.rmSync(out);
      throw new Error(`${name}/${file}: checksum ${got}, expected ${want}`);
    }
    console.log(`${name}/${file} ok`);
  }
}
console.log(`models ready: ${names.join(', ')}`);
