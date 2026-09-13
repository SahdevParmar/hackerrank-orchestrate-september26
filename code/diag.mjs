// code/diag.mjs — inspect one request end-to-end
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { loadDataset } from './dataset/loader.js';
import { forecast } from './engine/forecaster.js';
import { safeAmountToday } from './engine/safeAmount.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const data = loadDataset(REPO_ROOT);

const REQ_ID = process.argv[2] || 'request_04';

// Look in requests.csv first, then sample_requests.csv
let req = data.requestsById.get(REQ_ID);
if (!req) {
    const samples = parse(
        readFileSync(resolve(REPO_ROOT, 'dataset', 'sample_requests.csv'), 'utf8'),
        { columns: true, skip_empty_lines: true }
    );
    req = samples.find(s => s.request_id === REQ_ID);
}
if (!req) {
    console.error(`request ${REQ_ID} not found in requests.csv or sample_requests.csv`);
    process.exit(1);
}

const profile = data.profilesMap.get(req.user_id);
if (!profile) {
    console.error(`no profile for ${req.user_id}`);
    process.exit(1);
}

console.log('REQUEST:', JSON.stringify(req, null, 2));
console.log('PROFILE:', JSON.stringify(profile, null, 2));

const ctx = {
    profile,
    profilesMap: data.profilesMap,
    eventsByUser: data.eventsByUser,
    eventById: data.eventById,
    optionsByRequest: data.optionsByRequest,
    imagesByEvent: data.imagesByEvent,
    rates: data.rates,
    engine: { forecast, safeAmountToday },
    currentUserId: req.user_id,
};

// ... rest unchanged from the previous diag.mjs