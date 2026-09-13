// code/engine/spending.js
import { forecast } from './forecaster.js';   // kept only for typing; calls use ctx.engine
import { round2, overridesFrom, fmtCell, addDays } from './utils.js';

const MAX_CHANGES = 3;

export function generateSpendingChangeSets(ctx, request, planSchedule) {
    const { profile, eventsByUser } = ctx;
    const reqDate = request.request_date;

    const protect = splitPipe(profile.expense_categories_to_protect);
    const canStop = splitPipe(profile.expense_categories_user_is_willing_to_stop);
    const canReduce = splitPipe(profile.expense_categories_user_is_willing_to_reduce);

    const events = eventsByUser.get(request.user_id) || [];

    const candidates = events.filter(e => {
        if (e.event_date < reqDate) return false;
        if (e.status === 'cancelled' || e.status === 'failed') return false;
        if (e.status === 'settled') return false;
        if (e.direction !== 'debit') return false;
        const cat = e.category;
        if (!cat) return false;
        if (protect.includes(cat)) return false;
        const flex = e.flexibility;
        if (flex !== 'stoppable' && flex !== 'reducible' && flex !== 'reducible_or_stoppable') return false;
        if (e.settlement_date && e.settlement_date > addDays(reqDate, 90)) return false;
        return true;
    });

    const singles = [];
    for (const e of candidates) {
        const flex = e.flexibility;
        const cat = e.category;
        const amt = toHome(e.amount, e.currency, e.settlement_date || e.event_date, ctx);

        if ((flex === 'stoppable' || flex === 'reducible_or_stoppable') && canStop.includes(cat)) {
            singles.push({ type: 'stop', eventId: e.event_id, event: e, savings: amt });
        }

        if ((flex === 'reducible' || flex === 'reducible_or_stoppable') && canReduce.includes(cat)) {
            const minAllowedRaw = e.minimum_allowed_amount;
            const minAllowed = Number(minAllowedRaw);
            if (!Number.isFinite(minAllowed)) continue;
            if (minAllowed >= amt) continue;
            singles.push({
                type: 'reduce_to',
                eventId: e.event_id,
                event: e,
                newAmount: minAllowed,
                newAmountRaw: String(minAllowedRaw).trim(),   // preserve source formatting
                savings: amt - minAllowed,
            });
        }
    }

    if (singles.length === 0) return [];
    singles.sort((a, b) => b.savings - a.savings);

    const sets = [];
    const usedEvents = new Set();
    const running = [];
    for (const s of singles) {
        if (usedEvents.has(s.eventId)) continue;
        usedEvents.add(s.eventId);
        running.push(s);
        sets.push(makeSet(running, planSchedule, ctx, request));
        if (running.length === MAX_CHANGES) break;
    }
    for (const s of singles) {
        sets.push(makeSet([s], planSchedule, ctx, request));
    }

    const seen = new Set();
    const unique = [];
    for (const set of sets) {
        const key = set.changes
            .map(c => `${c.type}:${c.eventId}:${c.newAmountRaw ?? ''}`)
            .sort()
            .join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(set);
    }
    return unique;
}

function makeSet(rawChanges, planSchedule, ctx, request) {
    const { profile } = ctx;
    const home = profile.home_currency;

    const changes = rawChanges.map(s => ({
        type: s.type,
        eventId: s.eventId,
        newAmount: s.type === 'reduce_to' ? s.newAmount : undefined,
        newAmountRaw: s.type === 'reduce_to' ? s.newAmountRaw : undefined,
    }));

    const savings = rawChanges.reduce((sum, s) => sum + s.savings, 0);

    const overrides = overridesFrom(changes);
    const f = ctx.engine.forecast(ctx, {
        request,
        extraDebits: planSchedule.map(p => ({ date: p.date, amount: p.amount, currency: home })),
        overrides,
    });

    return {
        changes,
        schedule: planSchedule,
        savings: round2(savings),
        feasible: f.lowestBalance >= Number(profile.minimum_balance_to_keep) - 1e-9,
        lowestBalance: f.lowestBalance,
    };
}

export function formatSpendingChanges(changes) {
    if (!changes || changes.length === 0) return 'none';
    const stops = changes.filter(c => c.type === 'stop').sort((a, b) => a.eventId.localeCompare(b.eventId));
    const reduces = changes.filter(c => c.type === 'reduce_to').sort((a, b) => a.eventId.localeCompare(b.eventId));
    const parts = [
        ...stops.map(c => `stop:${c.eventId}`),
        ...reduces.map(c => `reduce_to:${c.eventId}:${fmtCell(c.newAmount)}`),
    ];
    return parts.slice(0, MAX_CHANGES).join('|');
}

function splitPipe(s) {
    if (!s) return [];
    return String(s).split('|').map(x => x.trim()).filter(Boolean);
}
function toHome(amount, currency, date, ctx) {
    const amt = Number(amount);
    if (currency === ctx.profile.home_currency) return amt;
    return ctx.rates.convert(amt, currency, ctx.profile.home_currency, date);
}