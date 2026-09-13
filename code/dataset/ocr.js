// code/dataset/ocr.js  — run once: `node code/dataset/ocr.js`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { parse } from 'csv-parse/sync';

// ---------------------------------------------------------------------------
// Constants — MUST be declared before any top-level call that uses them.
// ---------------------------------------------------------------------------

const NUM_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const SCALES = { hundred: 100, thousand: 1000, lakh: 100000, million: 1000000 };

// Manual overrides for images OCR can't read. Verified by inspecting the PNG.
const MANUAL = {
    image_03: 41272,
    image_06: 1995,
    image_14: 4543,
    image_15: 5968,
    image_16: 393.22,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DS = resolve(REPO_ROOT, 'dataset');
const OUT = resolve(__dirname, 'image_amounts.json');

const images = parse(
    readFileSync(resolve(DS, 'images.csv'), 'utf8'),
    { columns: true, skip_empty_lines: true }
);

const amounts = {};

const worker = await createWorker('eng');
for (const img of images) {
    if (MANUAL[img.image_id] != null) {
        amounts[img.image_id] = MANUAL[img.image_id];
        console.log(`${img.image_id}: ${MANUAL[img.image_id]}  (manual)`);
        continue;
    }

    const png = resolve(DS, 'media', 'images', `${img.image_id}.png`);
    if (!existsSync(png)) {
        console.warn(`missing ${png}`);
        continue;
    }

    const { data } = await worker.recognize(png);
    const text = data.text || '';
    const amt = extractAmount(text);
    if (amt != null) {
        amounts[img.image_id] = amt;
        console.log(`${img.image_id}: ${amt}  (conf ${data.confidence?.toFixed(1)})`);
    } else {
        console.warn(`${img.image_id}: no amount found — inspect the PNG and add to MANUAL.`);
        console.warn(`  OCR text: ${JSON.stringify(text.slice(0, 200))}`);
    }
}
await worker.terminate();

writeFileSync(OUT, JSON.stringify(amounts, null, 2), 'utf8');
console.log(`wrote ${OUT} (${Object.keys(amounts).length}/${images.length} resolved)`);

// ---------------------------------------------------------------------------
// Extraction (declarations below are only reached at runtime, after
// NUM_WORDS / SCALES are initialized above)
// ---------------------------------------------------------------------------

function extractAmount(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        if (/amount\s+in\s+words|in\s+words/i.test(line)) {
            const n = parseWordsToNumber(line);
            if (n != null && n > 0) return n;
        }
    }

    const labelPriority = [
        /net\s*pay\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /net\s*amount\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /grand\s*total\s*(?:\(RS\))?\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /total\s*amount\s*(?:received|to\s*be\s*rec\w*)\s*[:\-X%]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /amount\s*payable\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /balance\s*due\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /total\s*paid\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /\btotal\s*[:\-]?\s*(?:IDR|ZAR|EUR|INR|USD|Rp|€|\$|₹)?\s*([\d.,]+)/i,
        /item\s*bill\s*[%]?\s*([\d.,]+)/i,
    ];
    for (const re of labelPriority) {
        const m = text.match(re);
        if (m) {
            const n = normalizeNumber(m[1]);
            if (n != null && n > 0) return n;
        }
    }

    const currencyRe = /(?:ZAR|IDR|EUR|INR|USD|Rp|€|\$|₹)\s*(\d[\d.,]*)/gi;
    const currencyHits = [];
    let cm;
    while ((cm = currencyRe.exec(text)) !== null) {
        const n = normalizeNumber(cm[1]);
        if (n != null && n > 0 && n < 1e10) currencyHits.push(n);
    }
    if (currencyHits.length > 0) return Math.max(...currencyHits);

    const bareRe = /\b(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{1,2})\b/g;
    const bareHits = [];
    let bm;
    while ((bm = bareRe.exec(text)) !== null) {
        const n = normalizeNumber(bm[1]);
        if (n != null && n > 0 && n < 1e10) bareHits.push(n);
    }
    if (bareHits.length > 0) return Math.max(...bareHits);

    return null;
}

function normalizeNumber(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (!s) return null;

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    let cleaned;

    if (hasDot && hasComma) {
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        if (lastDot > lastComma) {
            cleaned = s.replace(/,/g, '');
        } else {
            cleaned = s.replace(/\./g, '').replace(',', '.');
        }
    } else if (hasComma) {
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length <= 2) {
            cleaned = parts[0] + '.' + parts[1];
        } else {
            cleaned = s.replace(/,/g, '');
        }
    } else if (hasDot) {
        const parts = s.split('.');
        if (parts.length === 2 && parts[1].length <= 2) {
            cleaned = s;
        } else if (parts.length > 2 || parts[1].length === 3) {
            cleaned = s.replace(/\./g, '');
        } else {
            cleaned = s;
        }
    } else {
        cleaned = s;
    }

    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function parseWordsToNumber(text) {
    const tokens = text.toLowerCase()
        .replace(/[^a-z\s-]/g, ' ')
        .replace(/-/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

    let total = 0;        // integer part accumulated so far (rupees)
    let current = 0;      // number being built right now
    let fractional = 0;   // paise/cents part
    let found = false;
    let inFraction = false;

    for (const t of tokens) {
        // --- paise / cents: capture the fractional part, then switch mode ---
        if (t === 'paise' || t === 'cents') {
            fractional = current;   // <-- CAPTURE, don't discard
            current = 0;
            inFraction = true;
            continue;
        }

        // --- currency words: close out the integer part ---
        if (t === 'rupees' || t === 'rupiahs' || t === 'dollars' || t === 'euros') {
            total += current;
            current = 0;
            continue;
        }

        // --- filler ---
        if (t === 'only' || t === 'and') continue;

        // --- number words ---
        if (NUM_WORDS[t] != null) {
            current += NUM_WORDS[t];
            found = true;
        } else if (t === 'hundred') {
            current = (current || 1) * 100;
        } else if (SCALES[t]) {
            current = (current || 1) * SCALES[t];
            if (t === 'thousand' || t === 'lakh' || t === 'million') {
                total += current;
                current = 0;
            }
        } else if (found) {
            // Non-number word after we've started — stop parsing.
            break;
        }
    }

    // --- final assembly ---
    if (!inFraction) {
        total += current;   // only add the running value if we never hit paise
    }
    // if inFraction, `fractional` already holds the paise value; don't touch it

    const result = total + fractional / 100;
    return found && result > 0 ? round2(result) : null;
}

function round2(x) {
    return Math.round(x * 100) / 100;
}