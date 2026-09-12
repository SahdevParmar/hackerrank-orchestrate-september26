// Reads all participant CSVs from the repo-level dataset/ directory.
// Resolves relative to this file's location, not process.cwd(), so it works
// from any working directory (spec §6.4: runnable from the terminal).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// code/dataset/loader.js → ../../dataset
const DATASET_DIR = path.resolve(__dirname, '..', '..', 'dataset');

function readCsv(filename) {
    const p = path.join(DATASET_DIR, filename);
    if (!fs.existsSync(p)) {
        console.warn(`[loader] missing ${filename}`);
        return [];
    }
    const text = fs.readFileSync(p, 'utf-8');
    if (!text.trim()) return [];
    return parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        cast: (value, ctx) => {
            const col = String(ctx.column);
            if (value === '') return null;
            // Keep IDs and dates as strings; parse money-like columns as numbers.
            if (col.endsWith('_id') || col.includes('date') || col === 'status' ||
                col === 'direction' || col === 'flexibility' || col === 'currency' ||
                col === 'home_currency' || col === 'payment_method' ||
                col === 'request_type' || col === 'allows_partial_payment' ||
                col === 'event_type' || col === 'category' || col === 'description') {
                return String(value);
            }
            const n = Number(value);
            return Number.isFinite(n) ? n : String(value);
        },
    });
}

export function loadAllData() {
    const requests = readCsv('requests.csv');
    const sampleRequests = readCsv('sample_requests.csv');
    const profiles = readCsv('financial_profiles.csv');
    const events = readCsv('financial_events.csv');
    const paymentOptions = readCsv('request_payment_options.csv');
    const exchangeRates = readCsv('exchange_rates.csv');
    const messages = readCsv('messages.csv');
    const images = readCsv('images.csv');

    const profilesMap = new Map(profiles.map(p => [String(p.user_id), p]));

    const eventsByUser = new Map();
    for (const e of events) {
        const uid = String(e.user_id || '');
        if (!eventsByUser.has(uid)) eventsByUser.set(uid, []);
        eventsByUser.get(uid).push(e);
    }
    // sort each user's events by event_date
    for (const list of eventsByUser.values()) {
        list.sort((a, b) => String(a.event_date || '').localeCompare(String(b.event_date || '')));
    }

    const optionsByRequest = new Map();
    for (const o of paymentOptions) {
        const rid = String(o.request_id || '');
        if (!optionsByRequest.has(rid)) optionsByRequest.set(rid, []);
        optionsByRequest.get(rid).push(o);
    }

    const messagesByUser = new Map();
    for (const m of messages) {
        const uid = String(m.user_id || '');
        if (!messagesByUser.has(uid)) messagesByUser.set(uid, []);
        messagesByUser.get(uid).push(m);
    }

    const imagesByEvent = new Map();
    for (const img of images) {
        if (img.related_event_id) imagesByEvent.set(String(img.related_event_id), img);
    }
    const imagesByRequest = new Map();
    for (const img of images) {
        if (img.request_id) {
            const rid = String(img.request_id);
            if (!imagesByRequest.has(rid)) imagesByRequest.set(rid, []);
            imagesByRequest.get(rid).push(img);
        }
    }

    return {
        requests, sampleRequests, profilesMap, events, eventsByUser,
        paymentOptions, optionsByRequest, exchangeRates,
        messages, messagesByUser, images, imagesByEvent, imagesByRequest,
    };
}

export { DATASET_DIR };