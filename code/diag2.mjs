// code/diag2.mjs — inspect one request with forecast detail
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { loadDataset } from './dataset/loader.js';
import { forecast } from './engine/forecaster.js';
import { detectRecurring, projectRecurring } from './engine/recurrence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const data = loadDataset(REPO_ROOT);

const REQ_ID = process.argv[2] || 'request_01';
let req = data.requestsById.get(REQ_ID);
if (!req) {
    const samples = parse(
        readFileSync(resolve(REPO_ROOT, 'dataset', 'sample_requests.csv'), 'utf8'),
        { columns: true, skip_empty_lines: true }
    );
    req = samples.find(s => s.request_id === REQ_ID);
}
const profile = data.profilesMap.get(req.user_id);

console.log('REQUEST:', req.request_id, req.user_id, req.request_date, req.requested_amount, profile.home_currency);
console.log('PROFILE balance:', profile.current_available_balance, 'floor:', profile.minimum_balance_to_keep);
console.log('free:', Number(profile.current_available_balance) - Number(profile.minimum_balance_to_keep));
console.log('');

const ctx = {
    profile,
    eventsByUser: data.eventsByUser,
    rates: data.rates,
    currentUserId: req.user_id,
};

// Forecast without the payment
const f0 = forecast(ctx, { request: req });
console.log('Forecast without payment:');
console.log('  lowestBalance:', f0.lowestBalance, 'on', f0.lowestDate);
console.log('  breaches:', f0.breaches.length);
console.log('  unresolved:', f0.unresolved);
console.log('');

// Forecast with full payment
const f1 = forecast(ctx, {
    request: req,
    extraDebits: [{ date: req.request_date, amount: Number(req.requested_amount), currency: profile.home_currency }],
});
console.log('Forecast with full payment today:');
console.log('  lowestBalance:', f1.lowestBalance, 'on', f1.lowestDate);
console.log('  breaches:', f1.breaches.length);
console.log('');

// Recurrence detail
const events = data.eventsByUser.get(req.user_id) || [];
const recurring = detectRecurring(events, req.request_date);
console.log('Detected recurring patterns:');
for (const r of recurring) {
    console.log(' ', r.key, 'amount', r.amount, 'every', r.cadenceDays, 'days, last', r.lastDate);
}
console.log('');

const projected = projectRecurring(recurring, req.request_date, 90, events);
console.log('Projected events in next 90 days:', projected.length);
let projDebits = 0, projCredits = 0;
for (const p of projected) {
    if (p.direction === 'debit') projDebits += p.amount;
    else projCredits += p.amount;
}
console.log('  projected debits total:', projDebits);
console.log('  projected credits total:', projCredits);
console.log('  net:', projCredits - projDebits);