// code/engine/safeAmount.js
import { round2, parseISO, toISO, addDays } from './utils.js';
import { detectRecurring, projectRecurring } from './recurrence.js';

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
    const { profile, eventsByUser } = ctx;
    const minBal = Number(profile.minimum_balance_to_keep);
    const home = profile.home_currency;
    const start = request.request_date;
    const horizon = 90;

    const incomeDates = new Set();

    // Real credit events at/after request_date
    const events = eventsByUser.get(request.user_id) || [];
    for (const e of events) {
        if (e.direction !== 'credit') continue;
        const d = e.settlement_date || e.event_date;
        if (!d || d < request.request_date) continue;
        if (d > addDays(request.request_date, horizon)) continue;
        incomeDates.add(d);
    }

    // Projected recurring credit dates
    const recurring = detectRecurring(events, request.request_date);
    const projected = projectRecurring(recurring, request.request_date, horizon, events);
    for (const p of projected) {
        if (p.direction !== 'credit') continue;
        const d = p.settlement_date || p.event_date;
        if (d && d >= request.request_date && d <= addDays(request.request_date, horizon)) {
            incomeDates.add(d);
        }
    }

    const isSafeOn = (date) => {
        const f = ctx.engine.forecast(ctx, {
            request,
            extraDebits: [{ date, amount: Number(request.requested_amount), currency: home }],
        });
        return f.lowestBalance >= minBal - 1e-9;
    };

    // Pass 1: income dates
    const sortedIncome = [...incomeDates].sort();
    for (const date of sortedIncome) {
        if (isSafeOn(date)) return date;
    }

    // Pass 2: any day
    const startMs = parseISO(start).getTime();
    for (let d = 0; d <= horizon; d++) {
        const date = toISO(new Date(startMs + d * DAY_MS));
        if (incomeDates.has(date)) continue;
        if (isSafeOn(date)) return date;
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
        extraDebits: schedule.map(p => ({
            date: p.date,
            amount: Number(p.amount),
            currency: profile.home_currency,
        })),
    });
    if (f.lowestBalance < minBal - 1e-9) return null;
    return schedule[schedule.length - 1].date;
}