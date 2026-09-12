// code/engine/spending.js
import { forecast } from './forecaster.js';

const DAY_MS = 86400000;
const MAX_CHANGES = 3;

/**
 * Generate candidate spending-change sets for a request.
 *
 * A "spending change" is one of:
 *   stop:<event_id>                    — zero out a stoppable event
 *   reduce_to:<event_id>:<new_amount>  — lower a reducible event to new_amount
 *
 * Rules enforced here:
 *   - Only events with flexibility in {stoppable, reducible, reducible_or_stoppable}
 *   - Only events whose category is in profile.expense_categories_user_is_willing_to_stop
 *     (for stop) or ..._willing_to_reduce (for reduce_to)
 *   - Never touch categories in profile.expense_categories_to_protect
 *   - Never touch events already in the past (settled before request_date)
 *   - reduce_to amount must be >= event.minimum_allowed_amount
 *   - reduce_to amount must be < current amount (no point "reducing" upward)
 *   - At most 3 changes total, across distinct events
 *   - Prefer fewer changes; prefer smaller total reduction that still works
 *
 * Returns an array of candidate change-sets, each:
 *   { changes: [{type:'stop'|'reduce_to', eventId, newAmount?}],
 *     schedule: [{date, amount}],   // the request payments (unchanged)
 *     savings: number,              // home-currency reduction in outflows
 *     feasible: boolean }
 *
 * The caller (rank.js) pairs each change-set with a plan schedule and
 * re-forecasts; this module only proposes candidates.
 */
export function generateSpendingChangeSets(ctx, request, planSchedule) {
    const { profile, eventsByUser } = ctx;
    const home = profile.home_currency;
    const reqDate = request.request_date;
    const desired = request.desired_completion_date;

    const protect = splitPipe(profile.expense_categories_to_protect);
    const canStop = splitPipe(profile.expense_categories_user_is_willing_to_stop);
    const canReduce = splitPipe(profile.expense_categories_user_is_willing_to_reduce);

    const events = eventsByUser.get(request.user_id) || [];

    // Candidate events: future-ish, flexible, in an allowed category, not protected.
    const candidates = events.filter(e => {
        if (e.event_date < reqDate) return false;                 // past
        if (e.status === 'cancelled' || e.status === 'failed') return false;
        if (e.status === 'settled') return false;                 // already happened
        if (e.direction !== 'debit') return false;                // only outflows
        const cat = e.category;
        if (!cat) return false;
        if (protect.includes(cat)) return false;
        const flex = e.flexibility;
        if (flex !== 'stoppable' && flex !== 'reducible' && flex !== 'reducible_or_stoppable') return false;
        // Event must fall inside the 90-day window from request_date.
        if (e.settlement_date && e.settlement_date > addDays(reqDate, 90)) return false;
        return true;
    });

    // Build the universe of single changes we're allowed to make.
    const singles = [];
    for (const e of candidates) {
        const flex = e.flexibility;
        const cat = e.category;
        const amt = toHome(e.amount, e.currency, e.settlement_date || e.event_date, ctx);

        // stop candidate
        if ((flex === 'stoppable' || flex === 'reducible_or_stoppable') && canStop.includes(cat)) {
            singles.push({
                type: 'stop',
                eventId: e.event_id,
                event: e,
                savings: amt,
            });
        }

        // reduce_to candidate
        if ((flex === 'reducible' || flex === 'reducible_or_stoppable') && canReduce.includes(cat)) {
            const minAllowed = Number(e.minimum_allowed_amount);
            if (!Number.isFinite(minAllowed)) continue;
            if (minAllowed >= amt) continue;                        // no room to reduce
            singles.push({
                type: 'reduce_to',
                eventId: e.event_id,
                event: e,
                newAmount: minAllowed,                                // most aggressive reduction
                savings: amt - minAllowed,
            });
        }
    }

    // If nothing is changeable, return empty.
    if (singles.length === 0) return [];

    // Sort singles by savings descending — bigger wins first, so small sets
    // can cover the gap.
    singles.sort((a, b) => b.savings - a.savings);

    // Enumerate change-sets of size 1..3 over DISTINCT events, greedy by savings.
    // We don't need the full power set: the spec caps at 3 and prefers fewer
    // changes. A greedy prefix is sufficient and keeps 12k-event users fast.
    const sets = [];
    const usedEvents = new Set();
    let running = [];

    for (const s of singles) {
        if (usedEvents.has(s.eventId)) continue;
        usedEvents.add(s.eventId);
        running.push(s);
        sets.push(makeSet(running, planSchedule, ctx, request));
        if (running.length === MAX_CHANGES) break;
    }

    // Also try each single alone, in case the greedy prefix overshoots.
    for (const s of singles) {
        sets.push(makeSet([s], planSchedule, ctx, request));
    }

    // Deduplicate by the set of (type,eventId,newAmount) tuples.
    const seen = new Set();
    const unique = [];
    for (const set of sets) {
        const key = set.changes
            .map(c => `${c.type}:${c.eventId}:${c.newAmount ?? ''}`)
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
    }));

    const savings = rawChanges.reduce((sum, s) => sum + s.savings, 0);

    // Re-forecast with the changes applied. The forecaster accepts
    // `overrides: Map<event_id, {skip?:true, newAmount?:number}>`.
    const overrides = new Map();
    for (const s of rawChanges) {
        if (s.type === 'stop') overrides.set(s.eventId, { skip: true });
        else overrides.set(s.eventId, { newAmount: s.newAmount });
    }

    const f = forecast(ctx, {
        extraDebits: planSchedule.map(p => ({
            date: p.date,
            amount: p.amount,
            currency: home,
        })),
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

/**
 * Format a change-set into the output.csv `spending_changes_needed` string.
 * Order: stops first (by event_id asc), then reduces (by event_id asc).
 */
export function formatSpendingChanges(changes) {
    if (!changes || changes.length === 0) return 'none';
    const stops = changes.filter(c => c.type === 'stop').sort((a, b) => a.eventId.localeCompare(b.eventId));
    const reduces = changes.filter(c => c.type === 'reduce_to').sort((a, b) => a.eventId.localeCompare(b.eventId));
    const parts = [
        ...stops.map(c => `stop:${c.eventId}`),
        ...reduces.map(c => `reduce_to:${c.eventId}:${fmtNum(c.newAmount)}`),
    ];
    return parts.slice(0, MAX_CHANGES).join('|');
}

function splitPipe(s) {
    if (!s) return [];
    return String(s).split('|').map(x => x.trim()).filter(Boolean);
}
function toHome(amount, currency, date, ctx) {
    const { rates, profile } = ctx;
    const amt = Number(amount);
    if (currency === profile.home_currency) return amt;
    return rates.convert(amt, currency, profile.home_currency, date);
}
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return new Date(dt.getTime() + n * DAY_MS).toISOString().slice(0, 10); }
function round2(x) { return Math.round(x * 100) / 100; }
function fmtNum(x) { return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); }