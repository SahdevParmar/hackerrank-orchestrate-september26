// code/engine/plans.js
import { round2, parseISO, toISO, addDays } from './utils.js';
import { detectRecurring, projectRecurring } from './recurrence.js';

const DAY_MS = 86400000;

export function buildPlans(ctx, request) {
    const { profile, optionsByRequest, eventsByUser } = ctx;
    const home = profile.home_currency;
    const minBal = Number(profile.minimum_balance_to_keep);
    const requested = Number(request.requested_amount);
    const reqDate = request.request_date;
    const desired = request.desired_completion_date;
    const allowsPartial = String(request.allows_partial_payment).toLowerCase() === 'true';

    const safeToday = ctx.engine.safeAmountToday(ctx, request, requested);
    const plans = [];

    // ---- 1. full_payment today --------------------------------------------
    if (safeToday >= requested - 0.01) {
        plans.push({
            method: 'full_payment',
            schedule: [{ date: reqDate, amount: requested }],
            spendingChanges: [],
            safeToday: requested,
            completesBy: reqDate,
            optionId: null,
        });
    }

    // ---- 2. partial_payment ------------------------------------------------
    // Search candidate second-payment dates (income days + desired) and, for
    // each, binary-search the largest feasible first payment.
    if (allowsPartial && safeToday > 0.01 && safeToday < requested - 0.01) {
        const best = bestPartialPlan(ctx, request, safeToday);
        if (best) {
            plans.push({
                method: 'partial_payment',
                schedule: [
                    { date: reqDate, amount: best.first },
                    { date: best.secondDate, amount: best.remainder },
                ],
                spendingChanges: [],
                safeToday: best.first,
                completesBy: best.secondDate,
                optionId: null,
            });
        }
    }

    // ---- 3. installments ---------------------------------------------------
    const opts = optionsByRequest.get(request.request_id) || [];
    for (const opt of opts) {
        if (opt.payment_method !== 'installments') continue;
        const schedule = ctx.engine.expandInstallmentOption(opt);
        if (!schedule) continue;
        const last = schedule[schedule.length - 1].date;
        if (last > desired) continue;
        const total = schedule.reduce((s, p) => s + p.amount, 0);
        if (total < requested - 0.01) continue;

        const f = ctx.engine.forecast(ctx, {
            request,
            extraDebits: schedule.map(p => ({ date: p.date, amount: p.amount, currency: home })),
        });
        if (f.lowestBalance < minBal - 1e-9) continue;

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
    const waitDate = ctx.engine.earliestFullPaymentDate(ctx, request);
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
 * Find the best feasible partial_payment plan.
 *
 * For each candidate second-payment date D (income days + desired), compute
 * the largest first payment X such that paying X on request_date and
 * (requested - X) on D is safe. Prefer the pair with the largest X; tie-break
 * to the earliest D.
 */
function bestPartialPlan(ctx, request, safeToday) {
    const { profile, eventsByUser } = ctx;
    const home = profile.home_currency;
    const minBal = Number(profile.minimum_balance_to_keep);
    const requested = Number(request.requested_amount);
    const reqDate = request.request_date;
    const desired = request.desired_completion_date;

    if (!desired || desired < reqDate) return null;

    // Collect candidate second-payment dates.
    const candidateDates = new Set();
    candidateDates.add(desired);

    const events = eventsByUser.get(request.user_id) || [];

    // Real income events within [reqDate, desired].
    for (const e of events) {
        if (e.direction !== 'credit') continue;
        const d = e.settlement_date || e.event_date;
        if (!d || d < reqDate || d > desired) continue;
        candidateDates.add(d);
    }

    // Projected income events within [reqDate, desired].
    const startMs = parseISO(reqDate).getTime();
    const desiredMs = parseISO(desired).getTime();
    const windowDays = Math.max(1, Math.round((desiredMs - startMs) / DAY_MS));
    try {
        const recurring = detectRecurring(events, reqDate);
        const projected = projectRecurring(recurring, reqDate, windowDays, events);
        for (const p of projected) {
            if (p.direction !== 'credit') continue;
            const d = p.settlement_date || p.event_date;
            if (!d || d < reqDate || d > desired) continue;
            candidateDates.add(d);
        }
    } catch {
        // projection unavailable; proceed with real income dates only
    }

    const isSafePair = (first, secondDate) => {
        const second = round2(requested - first);
        const f = ctx.engine.forecast(ctx, {
            request,
            extraDebits: [
                { date: reqDate, amount: first, currency: home },
                { date: secondDate, amount: second, currency: home },
            ],
        });
        return f.lowestBalance >= minBal - 1e-9;
    };

    let best = null;
    const sortedDates = [...candidateDates].sort();
    for (const secondDate of sortedDates) {
        if (secondDate < reqDate || secondDate > desired) continue;

        // If 0 is not safe, skip this D.
        if (!isSafePair(0.01, secondDate)) continue;

        // If paying everything today (requested on reqDate, 0 on D) is safe,
        // this request should have been classified as affordable_now. Skip.
        if (isSafePair(requested - 0.01, secondDate)) continue;

        // Binary search for the largest X in (0, requested) such that the
        // pair is safe.
        let lo = 0.01;
        let hi = requested - 0.01;
        if (!isSafePair(lo, secondDate)) continue;

        for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            if (isSafePair(mid, secondDate)) lo = mid; else hi = mid;
        }
        const first = round2(lo);
        if (first <= 0.01 || first >= requested - 0.01) continue;

        // Keep the plan with the largest first payment; tie-break earlier D.
        if (!best || first > best.first || (first === best.first && secondDate < best.secondDate)) {
            best = {
                first,
                remainder: round2(requested - first),
                secondDate,
            };
        }
    }

    return best;
}

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

export function earliestDateForRemainder(ctx, request, firstAmt, remainder) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const start = parseISO(request.request_date);
    const home = profile.home_currency;

    for (let d = 0; d <= 90; d++) {
        const date = toISO(new Date(start.getTime() + d * DAY_MS));
        const f = ctx.engine.forecast(ctx, {
            request,
            extraDebits: [
                { date: request.request_date, amount: firstAmt, currency: home },
                { date, amount: remainder, currency: home },
            ],
        });
        if (f.lowestBalance >= minBal - 1e-9) return date;
    }
    return null;
}