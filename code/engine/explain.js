// code/engine/explain.js
import { round2 } from './utils.js';

export function explain(ctx, request, candidate) {
    const { profile } = ctx;
    const cur = profile.home_currency;
    const minBal = Number(profile.minimum_balance_to_keep);

    switch (candidate.status) {
        case 'affordable_now':
            return affordableNow(ctx, candidate);
        case 'affordable_with_plan':
            return affordableWithPlan(ctx, request, candidate, cur, minBal);
        case 'affordable_later':
            return affordableLater(ctx, candidate, cur, minBal);
        case 'not_affordable':
            return notAffordable(ctx, request, candidate, cur, minBal);
        default:
            throw new Error(`explain: unknown status ${candidate.status}`);
    }
}

function affordableNow(ctx, c) {
    const cur = ctx.profile.home_currency;
    const minBal = Number(ctx.profile.minimum_balance_to_keep);
    const amt = fmtMoney(c.schedule[0].amount);
    return `Pay ${cur} ${amt} today. This leaves at least ${cur} ${fmtClean(minBal)} available over the next 90 days.`;
}

function affordableWithPlan(ctx, request, c, cur, minBal) {
    const minStr = `${cur} ${fmtClean(minBal)}`;

    if (c.method === 'installments') {
        const n = c.schedule.length;
        const each = fmtMoney(c.schedule[0].amount);
        const start = fmtDate(c.schedule[0].date);
        return `Use ${n} installments of ${cur} ${each}, starting ${start}. This leaves at least ${minStr} available.`;
    }

    if (c.method === 'partial_payment') {
        const first = fmtMoney(c.schedule[0].amount);
        const second = fmtMoney(c.schedule[1].amount);
        const secondDate = fmtDate(c.schedule[1].date);
        return `Pay ${cur} ${first} today and the remaining ${cur} ${second} on ${secondDate}. This completes the full request and keeps the ${minStr} minimum protected.`;
    }

    if (c.method === 'full_payment') {
        const action = describeSpendingChanges(ctx, c.spendingChanges);
        const amt = fmtMoney(request.requested_amount);
        if (action) {
            return `${action}, then pay ${cur} ${amt} today. This leaves at least ${minStr} available.`;
        }
        const d = fmtDate(c.schedule[0].date);
        return `Pay ${cur} ${amt} in full on ${d}. This leaves at least ${minStr} available.`;
    }

    throw new Error(`explain: unhandled plan method ${c.method}`);
}

function affordableLater(ctx, c, cur, minBal) {
    const amt = fmtMoney(c.schedule[0].amount);
    const d = fmtDate(c.schedule[0].date);
    return `Pay ${cur} ${amt} in full on ${d}. Paying earlier would take the balance below the ${cur} ${fmtClean(minBal)} minimum.`;
}

function notAffordable(ctx, request, c, cur, minBal) {
    const minStr = `${cur} ${fmtClean(minBal)}`;

    if (c.explanationKey === 'available_today_but_incomplete') {
        const reqAmt = fmtMoney(request.requested_amount);
        const safeAmt = fmtMoney(c.amountSafeToPay);
        return `Do not proceed with the ${cur} ${reqAmt} request. Although ${cur} ${safeAmt} is available today, the full amount cannot be completed safely within 90 days.`;
    }

    const deadline = fmtDate(request.desired_completion_date);
    return `Do not make this payment by ${deadline}. None of the available options keeps the ${minStr} minimum protected.`;
}

function describeSpendingChanges(ctx, changes) {
    if (!changes || changes.length === 0) return '';
    const parts = changes.map(c => {
        const ev = ctx.eventById.get(c.eventId);
        const desc = ev ? ev.description : c.eventId;
        const phrase = `the ${lowerFirst(desc)}`;
        if (c.type === 'stop') return `Stop ${phrase}`;
        if (c.type === 'reduce_to') {
            const cur = ev ? ev.currency : ctx.profile.home_currency;
            return `reduce ${phrase} to ${cur} ${fmtMoney(c.newAmount)}`;
        }
        return '';
    }).filter(Boolean);
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function fmtMoney(x) {
    const n = Number(x);
    const hasCents = Math.round(n * 100) % 100 !== 0;
    const s = hasCents ? n.toFixed(2) : String(Math.round(n));
    return withThousands(s);
}
function fmtClean(x) { return fmtMoney(x); }

function withThousands(s) {
    const [intPart, decPart] = s.split('.');
    const sign = intPart.startsWith('-') ? '-' : '';
    const digits = sign ? intPart.slice(1) : intPart;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decPart ? `${sign}${grouped}.${decPart}` : `${sign}${grouped}`;
}

function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    return `${d} ${months[m - 1]} ${y}`;
}

function lowerFirst(s) {
    if (!s) return s;
    return s.charAt(0).toLowerCase() + s.slice(1);
}