
import { forecast } from './forecaster.js';

const DAY_MS = 86400000;

/**
 * Binary search the largest amount the user can pay TODAY (on request_date)
 * such that the 90-day forecast never drops below minimum_balance_to_keep.
 *
 * Monotonic: paying more today can only lower future balances, so we can
 * binary search on the "safe" predicate.
 *
 * @returns {number} amount in home currency, 2dp, in [0, cap]
 */
export function safeAmountToday(ctx, request, cap) {
    const { profile, events, rates } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const startBal = Number(profile.current_available_balance);
    const home = profile.home_currency;

    // Hard ceiling: even with no events, balance can't go below minBal.
    const absoluteMax = Math.max(0, startBal - minBal);
    const upper = Math.min(cap, absoluteMax);
    if (upper <= 0) return 0;

    const isSafe = (amount) => {
        // Simulate: apply the payment on request_date as an extra debit,
        // then run the 90-day forecast.
        const f = forecast(ctx, {
            extraDebits: [{ date: request.request_date, amount, currency: home }],
        });
        return f.lowestBalance >= minBal - 1e-9;
    };

    if (!isSafe(0)) return 0; // even paying nothing breaches — data problem
    if (isSafe(upper)) return round2(upper);

    let lo = 0, hi = upper;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (isSafe(mid)) lo = mid; else hi = mid;
    }
    return round2(lo);
}

/**
 * Forward scan: the earliest date on/after request_date at which paying
 * `requested_amount` in full would be safe, within the 90-day window.
 * Returns ISO date string, or null if never safe within the window.
 */
export function earliestFullPaymentDate(ctx, request) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const start = parseISO(request.request_date);
    const horizon = 90;

    for (let d = 0; d <= horizon; d++) {
        const date = toISO(new Date(start.getTime() + d * DAY_MS));
        const f = forecast(ctx, {
            extraDebits: [{ date, amount: Number(request.requested_amount), currency: profile.home_currency }],
        });
        if (f.lowestBalance >= minBal - 1e-9) return date;
    }
    return null;
}

/**
 * For a supplied installment/partial schedule, find the earliest date
 * by which the FULL requested amount has been paid AND the forecast
 * never breached. Used for `earliest_date_for_full_payment`.
 */
export function earliestCompletionDate(ctx, request, schedule) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const totalPaid = schedule.reduce((s, p) => s + Number(p.amount), 0);
    if (totalPaid < Number(request.requested_amount) - 0.01) return null;

    // The completion date is simply the last payment date in the schedule,
    // provided the schedule itself is safe.
    const f = forecast(ctx, {
        extraDebits: schedule.map(p => ({ date: p.date, amount: Number(p.amount), currency: profile.home_currency })),
    });
    if (f.lowestBalance < minBal - 1e-9) return null;
    return schedule[schedule.length - 1].date;
}

function round2(x) { return Math.round(x * 100) / 100; }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function toISO(dt) { return dt.toISOString().slice(0, 10); }