import { loadAllData } from './dataset/loader.js';
import { buildFxIndex } from './engine/currency.js';
import { classifyAll, isIgnorable, isReservedDebit, isCountedCredit } from './engine/classify.js';
import { detectRecurring, projectRecurring } from './engine/recurrence.js';
import { computeSafeAmounts } from './engine/safeAmount.js';
import { generatePlans } from './engine/plans.js';
import { trySpendingChanges } from './engine/spending.js';
import { rankPlans } from './engine/rank.js';
import { explain } from './engine/explain.js';
import { writeOutput } from './output/writer.js';
import { verifyAll } from './verify/contract.js';

const HORIZON_DAYS = 90;

function main() {
    const data = loadAllData();
    const fx = buildFxIndex(data.exchangeRates);

    const rows = [];
    for (const request of data.requests) {
        const profile = data.profilesMap.get(String(request.user_id));
        if (!profile) { rows.push(blankRow(request, 'no profile')); continue; }

        const userEventsRaw = data.eventsByUser.get(String(request.user_id)) || [];
        const classified = classifyAll(userEventsRaw).filter(e => !isIgnorable(e));

        const requestDate = String(request.request_date);
        const recurring = detectRecurring(classified, requestDate);
        const projected = projectRecurring(recurring, requestDate, HORIZON_DAYS);

        // Combine historical (for context, only future ones matter for forecast),
        // reserved debits, counted credits, and projected recurring.
        const future = classified.filter(e => e.eventDate >= requestDate);
        const forecastEvents = future
            .filter(e => isReservedDebit(e) || isCountedCredit(e) || e.status === 'settled')
            .concat(projected);

        const { amountSafeToPay, earliestFullPaymentDate } = computeSafeAmounts(
            profile, forecastEvents, request, fx, { days: HORIZON_DAYS }
        );

        const plans = generatePlans({
            profile, events: forecastEvents, request, fx,
            amountSafeToPay, earliestFullPaymentDate,
            optionsForRequest: data.optionsForRequest.get(String(request.request_id)) || [],
            days: HORIZON_DAYS,
            applySpendingChanges: (events, requested, date, cur, fxIdx, days) =>
                trySpendingChanges(profile, events, requested, date, cur, fxIdx, days),
        });

        const best = rankPlans(plans, request);
        best._amountSafeToPay = amountSafeToPay;

        const minBal = Number(profile.minimum_balance_to_keep);
        const row = {
            request_id: String(request.request_id),
            amount_safe_to_pay: fmt(amountSafeToPay),
            affordability_status: best.status,
            recommended_payment_method: best.method,
            payment_plan: best.plan,
            earliest_date_for_full_payment:
                best.method === 'wait' ? best.startDate
                    : best.status === 'affordable_now' ? requestDate
                        : best.method === 'partial_payment' ? earliestFullPaymentDate
                            : '',
            spending_changes_needed: best.spendingChanges,
            decision_explanation: explain(best, request, profile, minBal),
        };
        rows.push(row);
    }

    const outPath = writeOutput(rows);
    console.log(`Wrote ${rows.length} rows to ${outPath}`);

    const problems = verifyAll(rows, data.requests);
    if (problems.length) {
        console.warn(`[verify] ${problems.length} rows have contract issues:`);
        for (const [id, errs] of problems.slice(0, 10)) console.warn(`  ${id}: ${errs.join('; ')}`);
    } else {
        console.log('[verify] all rows pass the contract check.');
    }
}

function fmt(n) { const v = Math.round(Number(n) * 100) / 100; return Number.isInteger(v) ? String(v) : v.toFixed(2); }
function blankRow(request, why) {
    return {
        request_id: String(request.request_id),
        amount_safe_to_pay: '0',
        affordability_status: 'not_affordable',
        recommended_payment_method: 'not_recommended',
        payment_plan: 'none',
        earliest_date_for_full_payment: '',
        spending_changes_needed: 'none',
        decision_explanation: `No recommendation (${why}).`,
    };
}

main();