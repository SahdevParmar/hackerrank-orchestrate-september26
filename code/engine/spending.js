// code/engine/spending.js
import { round2, addDays } from './utils.js';

const MAX_CHANGES = 3;

export function generateSpendingChangeSets(ctx, request, planSchedule) {
    const { profile, eventsByUser } = ctx;
    const reqDate = request.request_date;

    const protect = splitPipe(profile.expense_categories_to_protect);
    const canStop = splitPipe(profile.expense_categories_user_is_willing_to_stop);
    const canReduce = splitPipe(profile.expense_categories_user_is_willing_to_reduce);

    const events = eventsByUser.get(request.user_id) || [];

    // For each (category, event_type, direction) group, find the latest event.
    // We'll allow the latest-settled event of each group as a candidate even
    // though it's "settled" — it serves as the identifier for the pattern
    // that has future projections.
    const latestByGroup = new Map();
    for (const e of events) {
        if (e.direction !== 'debit') continue;
        const key = `${e.category}|${e.event_type}|${e.direction}`;
        const d = e.settlement_date || e.event_date;
        if (!d) continue;
        const cur = latestByGroup.get(key);
        if (!cur || d > (cur.settlement_date || cur.event_date)) {
            latestByGroup.set(key, e);
        }
    }

    const candidates = events.filter(e => {
        if (e.direction !== 'debit') return false;
        const cat = e.category;
        if (!cat) return false;
        if (protect.includes(cat)) return false;

        const flex = e.flexibility;
        if (flex !== 'stoppable' && flex !== 'reducible' && flex !== 'reducible_or_stoppable') {
            return false;
        }

        const d = e.settlement_date || e.event_date;
        if (!d) return false;

        if (e.status === 'cancelled' || e.status === 'failed') return false;

        // Case A: future-dated, not settled — always eligible.
        if (e.status !== 'settled' && d >= reqDate && d <= addDays(reqDate, 90)) {
            return true;
        }

        // Case B: settled — eligible ONLY if it's the latest in its group.
        // Its future projections carry the pattern; we're using this event
        // as the reference id for stopping/reducing that pattern.
        if (e.status === 'settled') {
            const key = `${e.category}|${e.event_type}|${e.direction}`;
            const latest = latestByGroup.get(key);
            if (latest === e) return true;
        }

        return false;
    });

    const singles = [];
    for (const e of candidates) {
        const flex = e.flexibility;
        const cat = e.category;
        const amt = toHome(e.amount, e.currency, e.settlement_date || e.event_date, ctx);

        if ((flex === 'stoppable' || flex === 'reducible_or_stoppable') && canStop.includes(cat)) {
            singles.push({
                type: 'stop',
                eventId: e.event_id,
                event: e,
                patternKey: `${e.category}|${e.event_type}|${e.direction}`,
                savings: amt,
            });
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
                patternKey: `${e.category}|${e.event_type}|${e.direction}`,
                newAmount: minAllowed,
                newAmountRaw: String(minAllowedRaw).trim(),
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
        patternKey: s.patternKey,
        newAmount: s.type === 'reduce_to' ? s.newAmount : undefined,
        newAmountRaw: s.type === 'reduce_to' ? s.newAmountRaw : undefined,
    }));

    const savings = rawChanges.reduce((sum, s) => sum + s.savings, 0);

    // Build overrides keyed by eventId AND patternKey. The forecaster looks up
    // overrides by exact event_id first, then by patternKey. This lets a
    // `stop:event_476` override skip the projected recurrences of event_476's
    // pattern, even though event_476 itself is settled/past.
    const overrides = new Map();
    for (const c of rawChanges) {
        const payload = c.type === 'stop'
            ? { skip: true }
            : { newAmount: c.newAmount };
        overrides.set(c.eventId, payload);
        if (c.patternKey) overrides.set(c.patternKey, payload);
    }

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
function fmtCell(x) {
    const n = Math.round(Number(x) * 100) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}