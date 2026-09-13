// code/main.js
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { loadDataset } from './dataset/loader.js';
import { forecast } from './engine/forecaster.js';
import { safeAmountToday, earliestFullPaymentDate, earliestCompletionDate } from './engine/safeAmount.js';
import { expandInstallmentOption } from './engine/plans.js';
import { pickBest } from './engine/rank.js';
import { explain } from './engine/explain.js';
import { validateAll } from './verify/contract.js';
import { writeOutput } from './output/writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LOG_PATH = resolve(REPO_ROOT, 'log.txt');

function log(line) {
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${line}\n`;
    appendFileSync(LOG_PATH, entry, 'utf8');
}

function sessionStart() {
    log('SESSION START');
    log('tool=node');
    log(`pid=${process.pid} node=${process.version} cwd=${process.cwd()}`);
}

function sessionEnd(status, detail) {
    log(`SESSION END status=${status} ${detail}`);
    log('tool=node');
}

async function main() {
    sessionStart();
    const t0 = performance.now();

    try {
        // ---- 1. Load dataset ------------------------------------------------
        log('phase=load start');
        const data = loadDataset(REPO_ROOT);
        log(`phase=load done requests=${data.requests.length} events=${data.eventById.size} profiles=${data.profilesMap.size}`);

        // ---- 2. Build context ----------------------------------------------
        const ctx = {
            profile: null,               // set per-request
            currentUserId: null,         // set per-request (forecast fallback)
            profilesMap: data.profilesMap,
            eventsByUser: data.eventsByUser,
            eventById: data.eventById,
            requestsById: data.requestsById,
            optionsByRequest: data.optionsByRequest,
            messagesByUser: data.messagesByUser,
            imagesByEvent: data.imagesByEvent,
            imagesByRequest: data.imagesByRequest,
            rates: data.rates,
            engine: {
                forecast,
                safeAmountToday,
                earliestFullPaymentDate,
                earliestCompletionDate,
                expandInstallmentOption,
            },
        };

        // ---- 3. Decide per request -----------------------------------------
        log('phase=decide start');
        const rows = [];
        const warnings = [];

        for (const request of data.requests) {
            const profile = data.profilesMap.get(request.user_id);
            if (!profile) {
                warnings.push(`${request.request_id}: no profile for ${request.user_id}`);
                rows.push(emptyRow(request.request_id));
                continue;
            }

            // Per-request context: profile + userId fallback for forecast.
            ctx.profile = profile;
            ctx.currentUserId = request.user_id;

            let candidate;
            try {
                candidate = pickBest(ctx, request);
            } catch (err) {
                warnings.push(`${request.request_id}: pickBest threw: ${err.message}`);
                rows.push(emptyRow(request.request_id));
                // Only log the full stack for the first few failures to keep
                // log.txt readable; then just the message.
                if (warnings.length <= 5) log(`error request=${request.request_id} ${err.stack}`);
                else log(`error request=${request.request_id} ${err.message}`);
                continue;
            }

            let explanation;
            try {
                explanation = explain(ctx, request, candidate);
            } catch (err) {
                warnings.push(`${request.request_id}: explain threw: ${err.message}`);
                explanation = fallbackExplanation(ctx, request, candidate);
                if (warnings.length <= 5) log(`error request=${request.request_id} explain: ${err.stack}`);
                else log(`error request=${request.request_id} explain: ${err.message}`);
            }

            rows.push({
                request_id: request.request_id,
                amount_safe_to_pay: candidate.amountSafeToPay,
                affordability_status: candidate.status,
                recommended_payment_method: candidate.method,
                payment_plan: planToString(candidate.schedule),
                earliest_date_for_full_payment: candidate.earliestFullPayment || '',
                spending_changes_needed: changesToString(candidate.spendingChanges),
                decision_explanation: explanation,
            });
        }
        log(`phase=decide done rows=${rows.length} warnings=${warnings.length}`);

        // ---- 4. Verify ------------------------------------------------------
        log('phase=verify start');
        const { ok, errors } = validateAll(rows, data.requestsById, ctx);
        if (!ok) {
            log(`phase=verify FAILED errors=${errors.length}`);
            for (const e of errors.slice(0, 50)) log(`verify: ${e}`);
            console.error(`Contract validation failed with ${errors.length} errors (first 50 logged).`);
        } else {
            log('phase=verify OK');
        }

        // ---- 5. Write -------------------------------------------------------
        log('phase=write start');
        const outPath = writeOutput(rows.map(r => ({
            requestId: r.request_id,
            candidate: {
                amountSafeToPay: Number(r.amount_safe_to_pay),
                status: r.affordability_status,
                method: r.recommended_payment_method,
                schedule: parsePlanBack(r.payment_plan),
                earliestFullPayment: r.earliest_date_for_full_payment,
                spendingChanges: parseChangesBack(r.spending_changes_needed),
            },
            explanation: r.decision_explanation,
        })));
        log(`phase=write done path=${outPath}`);

        // ---- 6. Summary -----------------------------------------------------
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const statusCounts = countBy(rows, r => r.affordability_status);
        log(`SUMMARY elapsed=${elapsed}s status=${JSON.stringify(statusCounts)}`);
        log(`SUMMARY warnings=${warnings.length}`);
        for (const w of warnings.slice(0, 50)) log(`warning: ${w}`);

        console.log(`Wrote ${rows.length} rows to ${outPath} in ${elapsed}s`);
        console.log(`Status breakdown:`, statusCounts);
        if (warnings.length) console.warn(`${warnings.length} warnings (see log.txt)`);

        sessionEnd(ok ? 'ok' : 'verify_failed', `elapsed=${elapsed}s warnings=${warnings.length}`);
        process.exit(ok ? 0 : 2);

    } catch (err) {
        log(`FATAL ${err.stack}`);
        sessionEnd('fatal', err.message);
        console.error(err);
        process.exit(1);
    }
}

// ---- helpers for round-tripping rows through validate→write ---------------

function emptyRow(requestId) {
    return {
        request_id: requestId,
        amount_safe_to_pay: 0,
        affordability_status: 'not_affordable',
        recommended_payment_method: 'not_recommended',
        payment_plan: 'none',
        earliest_date_for_full_payment: '',
        spending_changes_needed: 'none',
        decision_explanation: 'Do not make this payment. Insufficient data to evaluate.',
    };
}

function planToString(schedule) {
    if (!schedule || schedule.length === 0) return 'none';
    return schedule.map(p => `${p.date}:${fmtCell(p.amount)}`).join('|');
}

function parsePlanBack(planStr) {
    if (!planStr || planStr === 'none') return [];
    return planStr.split('|').map(p => {
        const [date, amount] = p.split(':');
        return { date, amount: Number(amount) };
    });
}

function changesToString(changes) {
    if (!changes || changes.length === 0) return 'none';
    const stops = changes.filter(c => c.type === 'stop').map(c => `stop:${c.eventId}`);
    const reduces = changes.filter(c => c.type === 'reduce_to')
        .map(c => `reduce_to:${c.eventId}:${fmtCell(c.newAmount)}`);
    return [...stops, ...reduces].slice(0, 3).join('|');
}

function parseChangesBack(str) {
    if (!str || str === 'none') return [];
    return str.split('|').map(p => {
        const parts = p.split(':');
        if (parts[0] === 'stop') return { type: 'stop', eventId: parts[1] };
        return { type: 'reduce_to', eventId: parts[1], newAmount: Number(parts[2]) };
    });
}

function fmtCell(x) {
    const n = Math.round(Number(x) * 100) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fallbackExplanation(ctx, request, candidate) {
    return `Recommended action: ${candidate.method} for ${ctx.profile.home_currency} ${request.requested_amount}.`;
}

function countBy(arr, fn) {
    const out = {};
    for (const x of arr) {
        const k = fn(x);
        out[k] = (out[k] || 0) + 1;
    }
    return out;
}

main();