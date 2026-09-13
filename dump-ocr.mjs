// dump-ocr.mjs
import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const imgs = parse(
    fs.readFileSync(path.join(__dirname, 'dataset', 'images.csv'), 'utf8'),
    { columns: true, skip_empty_lines: true }
);

const w = await createWorker('eng');
for (const im of imgs) {
    const p = path.join(__dirname, 'dataset', 'media', 'images', im.image_id + '.png');
    if (!fs.existsSync(p)) { console.log(`===== ${im.image_id} MISSING =====`); continue; }
    const { data } = await w.recognize(p);
    console.log(`===== ${im.image_id} (event ${im.related_event_id}) =====`);
    console.log(data.text);
    console.log('');
}
await w.terminate();