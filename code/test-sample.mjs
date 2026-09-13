// code/test-sample.mjs — run engine against sample_requests.csv and diff
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { loadDataset } from './dataset/loader.js';
import { forecast } from './engine/forecaster.js';
import { safeAmountToday, earliestFullPaymentDate, earliestCompletionDate } from './engine/safeAmount.js';
import { expandInstallmentOption } from './engine/plans.js';
import { pickBest } from './engine/rank.js';
import { explain } from './engine/explain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Load the real dataset (for profiles, events, FX) but override the requests
const data = loadDataset(REPO_ROOT);

const samples = parse(
    readFileSync(resolve(REPO_ROOT, 'dataset', 'sample_requests.csv'), 'utf8'),
    { columns: true, skip_empty_lines: true }
);

const ctx = {
    profile: null,
    profilesMap: data.profilesMap,
    eventsByUser: data.eventsByUser,
    eventById: data.eventById,
    requestsById: data.requestsById,
    optionsByRequest: data.optionsByRequest,
    messagesByUser: data.messagesByUser,
    imagesByEvent: data.imagesByEvent,
    imagesByRequest: data.imagesByRequest,
    rates: data.rates,
    engine: { forecast, safeAmountToday, earliestFullPaymentDate, earliestCompletionDate, expandInstallmentOption },
};

let pass = 0, fail = 0;

for (const s of samples) {
    const profile = data.profilesMap.get(s.user_id);
    if (!profile) { console.log(`${s.request_id}: NO PROFILE`); fail++; continue; }
    ctx.profile = profile;
    ctx.currentUserId = s.user_id;

    let cand;
    try {
        cand = pickBest(ctx, s);
    } catch (e) {
        console.log(`${s.request_id}: THREW ${e.message}`);
        fail++;
        continue;
    }

    const expected = {
        amount_safe_to_pay: Number(s.amount_safe_to_pay),
        affordability_status: s.affordability_status,
        recommended_payment_method: s.recommended_payment_method,
        payment_plan: s.payment_plan,
        earliest_date_for_full_payment: s.earliest_date_for_full_payment,
    };
    const actual = {
        amount_safe_to_pay: cand.amountSafeToPay,
        affordability_status: cand.status,
        recommended_payment_method: cand.method,
        payment_plan: cand.schedule.length === 0
            ? 'none'
            : cand.schedule.map(p => `${p.date}:${p.amount}`).join('|'),
        earliest_date_for_full_payment: cand.earliestFullPayment || '',
    };

    const diffs = [];
    for (const k of Object.keys(expected)) {
        if (String(expected[k]) !== String(actual[k])) {
            diffs.push(`  ${k}: expected ${JSON.stringify(expected[k])} got ${JSON.stringify(actual[k])}`);
        }
    }

    if (diffs.length === 0) {
        pass++;
        console.log(`✓ ${s.request_id}`);
    } else {
        fail++;
        console.log(`✗ ${s.request_id}`);
        console.log(diffs.join('\n'));
    }
}

console.log(`\n${pass}/${pass + fail} passed`);