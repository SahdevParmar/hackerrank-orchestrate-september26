// code/engine/plans.js
import { round2, parseISO, toISO, addDays } from './utils.js';

const DAY_MS = 86400000;

export function buildPlans(ctx, request) {
    const { profile, optionsByRequest } = ctx;
    const home = profile.home_currency;
    const requested = Number(request.requested_amount);
    const reqDate = request.request_date;
    const desired = request.desired_completion_date;
    const allowsPartial = String(request.allows_partial_payment).toLowerCase() === 'true';

    const safeToday = ctx.engine.safeAmountToday(ctx, request, requested);
    const plans = [];

    // full_payment today
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

    // partial_payment
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

    // installments
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

    // wait
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

    // not_recommended fallback
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