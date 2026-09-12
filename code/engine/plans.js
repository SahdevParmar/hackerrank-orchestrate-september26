// code/engine/plans.js
import { forecast } from './forecaster.js';
import { safeAmountToday, earliestFullPaymentDate, earliestCompletionDate } from './safeAmount.js';

const DAY_MS = 86400000;

/**
 * Build every candidate plan for a request, then let rank.js pick.
 *
 * Candidate shapes (all money in home currency, all dates ISO):
 *   { method: 'full_payment',      schedule: [{date, amount}], spendingChanges: [], safeToday, completesBy }
 *   { method: 'partial_payment',   schedule: [p1, p2],         spendingChanges: [], safeToday, completesBy }
 *   { method: 'installments',      schedule: [...],            spendingChanges: [], safeToday, completesBy, optionId }
 *   { method: 'wait',              schedule: [{date, amount}], spendingChanges: [], safeToday, completesBy }
 *   { method: 'not_recommended',   schedule: [],               spendingChanges: [], safeToday: 0, completesBy: null }
 *
 * spendingChanges are attached later by spending.js when a plan is
 * otherwise infeasible; plans.js returns the raw shapes.
 */
export function buildPlans(ctx, request) {
    const { profile, optionsByRequest } = ctx;
    const home = profile.home_currency;
    const requested = Number(request.requested_amount);
    const reqDate = request.request_date;
    const desired = request.desired_completion_date;
    const allowsPartial = String(request.allows_partial_payment).toLowerCase() === 'true';

    const safeToday = safeAmountToday(ctx, request, requested);
    const plans = [];

    // ---- 1. full_payment today ---------------------------------------------
    // Only viable if paying the full amount today never breaches.
    const fullSafeToday = safeToday >= requested - 0.01;
    if (fullSafeToday) {
        plans.push({
            method: 'full_payment',
            schedule: [{ date: reqDate, amount: requested }],
            spendingChanges: [],
            safeToday: requested,
            completesBy: reqDate,
            optionId: null,
        });
    }

    // ---- 2. partial_payment (exactly two payments) -------------------------
    // Requires: request allows partial, safeToday > 0 and < requested,
    // and remainder can be paid by desired_completion_date.
    if (allowsPartial && safeToday > 0.01 && safeToday < requested - 0.01) {
        const remainder = round2(requested - safeToday);
        const secondDate = earliestDateForRemainder(ctx, request, safeToday, remainder);
        if (secondDate && secondDate <= desired) {
            plans.push({
                method: 'partial_payment',
                schedule: [
                    { date: reqDate, amount: safeToday },
                    { date: secondDate, amount: remainder },
                ],
                spendingChanges: [],
                safeToday,
                completesBy: secondDate,
                optionId: null,
            });
        }
    }

    // ---- 3. installments (must match a supplied option) -------------------
    // For each option with payment_method === 'installments', build the
    // schedule from the option row and test it. We do NOT invent schedules.
    const opts = optionsByRequest.get(request.request_id) || [];
    for (const opt of opts) {
        if (opt.payment_method !== 'installments') continue;

        const schedule = expandInstallmentOption(opt);
        if (!schedule) continue;

        // Reject if any payment lands after desired_completion_date.
        const last = schedule[schedule.length - 1].date;
        if (last > desired) continue;

        // Option must actually cover the requested amount.
        const total = schedule.reduce((s, p) => s + p.amount, 0);
        if (total < requested - 0.01) continue;

        // Test safety of the whole schedule.
        const f = forecast(ctx, {
            extraDebits: schedule.map(p => ({ date: p.date, amount: p.amount, currency: home })),
        });
        if (f.lowestBalance < Number(profile.minimum_balance_to_keep) - 1e-9) continue;

        plans.push({
            method: 'installments',
            schedule,
            spendingChanges: [],
            safeToday,
            completesBy: last,
            optionId: opt.payment_option_id,
        });
    }

    // ---- 4. wait -----------------------------------------------------------
    // If full amount can be paid in one shot later within 90 days.
    const waitDate = earliestFullPaymentDate(ctx, request);
    if (waitDate && waitDate > reqDate && waitDate <= addDays(reqDate, 90)) {
        plans.push({
            method: 'wait',
            schedule: [{ date: waitDate, amount: requested }],
            spendingChanges: [],
            safeToday,
            completesBy: waitDate,
            optionId: null,
        });
    }

    // ---- 5. not_recommended ------------------------------------------------
    // Always available as the fallback. Explanation flavor chosen in explain.js.
    plans.push({
        method: 'not_recommended',
        schedule: [],
        spendingChanges: [],
        safeToday: safeToday > 0 ? safeToday : 0,
        completesBy: null,
        optionId: null,
    });

    return plans;
}

/**
 * Expand a request_payment_options.csv installments row into a concrete
 * schedule: number_of_payments payments of payment_amount, spaced by
 * payment_frequency_days, starting first_payment_date.
 *
 * NOTE: per spec, total_payable_amount = payment_amount * n + financing_fee.
 * The financing fee is a real cost; we include it as a separate debit on
 * the first payment date so the forecast sees it. The schedule that the
 * user SEES in output.csv is the payment_amount installments only.
 */
export function expandInstallmentOption(opt) {
    const n = Number(opt.number_of_payments);
    const amt = Number(opt.payment_amount);
    const freq = Number(opt.payment_frequency_days);
    const first = opt.first_payment_date;
    if (!n || !amt || !freq || !first) return null;

    const out = [];
    let d = parseISO(first);
    for (let i = 0; i < n; i++) {
        out.push({ date: toISO(d), amount: round2(amt) });
        d = new Date(d.getTime() + freq * DAY_MS);
    }
    return out;
}

/**
 * Given a first payment of `firstAmt` today, find the earliest date the
 * remainder can be paid in full without breaching.
 */
export function earliestDateForRemainder(ctx, request, firstAmt, remainder) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const start = parseISO(request.request_date);
    const home = profile.home_currency;

    for (let d = 0; d <= 90; d++) {
        const date = toISO(new Date(start.getTime() + d * DAY_MS));
        const f = forecast(ctx, {
            extraDebits: [
                { date: request.request_date, amount: firstAmt, currency: home },
                { date, amount: remainder, currency: home },
            ],
        });
        if (f.lowestBalance >= minBal - 1e-9) return date;
    }
    return null;
}

function round2(x) { return Math.round(x * 100) / 100; }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function toISO(dt) { return dt.toISOString().slice(0, 10); }
function addDays(iso, n) { const d = parseISO(iso); return toISO(new Date(d.getTime() + n * DAY_MS)); }