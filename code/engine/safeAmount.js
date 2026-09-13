// code/engine/safeAmount.js
import { round2, parseISO, toISO } from './utils.js';

const DAY_MS = 86400000;

export function safeAmountToday(ctx, request, cap, overrides = null) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const startBal = Number(profile.current_available_balance);
    const home = profile.home_currency;

    const absoluteMax = Math.max(0, startBal - minBal);
    const upper = Math.min(cap, absoluteMax);
    if (upper <= 0) return 0;

    const isSafe = (amount) => {
        const f = ctx.engine.forecast(ctx, {
            request,
            extraDebits: [{ date: request.request_date, amount, currency: home }],
            overrides,
        });
        return f.lowestBalance >= minBal - 1e-9;
    };

    if (!isSafe(0)) return 0;
    if (isSafe(upper)) return round2(upper);

    let lo = 0, hi = upper;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (isSafe(mid)) lo = mid; else hi = mid;
    }
    return round2(lo);
}

export function earliestFullPaymentDate(ctx, request) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const start = parseISO(request.request_date);
    const horizon = 90;

    for (let d = 0; d <= horizon; d++) {
        const date = toISO(new Date(start.getTime() + d * DAY_MS));
        const f = ctx.engine.forecast(ctx, {
            request,
            extraDebits: [{ date, amount: Number(request.requested_amount), currency: profile.home_currency }],
        });
        if (f.lowestBalance >= minBal - 1e-9) return date;
    }
    return null;
}

export function earliestCompletionDate(ctx, request, schedule) {
    const { profile } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const totalPaid = schedule.reduce((s, p) => s + Number(p.amount), 0);
    if (totalPaid < Number(request.requested_amount) - 0.01) return null;

    const f = ctx.engine.forecast(ctx, {
        request,
        extraDebits: schedule.map(p => ({ date: p.date, amount: Number(p.amount), currency: profile.home_currency })),
    });
    if (f.lowestBalance < minBal - 1e-9) return null;
    return schedule[schedule.length - 1].date;
}