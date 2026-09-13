// code/engine/forecaster.js
import { parseISO, toISO, addDays, round2 } from './utils.js';

const DAY_MS = 86400000;
const HORIZON_DAYS = 90;

/**
 * 90-day daily balance projection.
 *
 * Contract:
 *   forecast(ctx, opts?) -> {
 *     timeline: [{date, balance, inflows, outflows}],
 *     lowestBalance: number,
 *     lowestDate: string,
 *     breaches: string[],       // dates where balance < minBalance
 *     minBalance: number,
 *     startBalance: number,
 *     unresolved: string[]      // event_ids whose amount couldn't be resolved
 *   }
 *
 * opts:
 *   extraDebits: [{date, amount, currency}]  — hypothetical payments to test
 *   overrides:   Map<event_id, {skip?:true, newAmount?:number}>
 *
 * Rules enforced:
 *   - Only events with status in {settled, scheduled, pending} are counted.
 *     cancelled / failed / unrealized are dropped (unless overridden).
 *   - pending CREDITS are NOT counted (spec: don't count until settled).
 *   - pending DEBITS ARE reserved (they'll hit the account).
 *   - investment_valuation (non_cash) is never counted.
 *   - Every amount is converted to home_currency on its settlement date.
 *   - extraDebits are applied on their date, in home currency, after
 *     regular events, so they stack correctly.
 *   - overrides: skip=true removes the event entirely; newAmount replaces
 *     the amount (still on the same settlement date).
 */
export function forecast(ctx, opts = {}) {
    const { profile, eventsByUser, rates } = ctx;
    const home = profile.home_currency;
    const minBalance = Number(profile.minimum_balance_to_keep);
    const startBalance = Number(profile.current_available_balance);

    const userId = opts.userId || (opts.request && opts.request.user_id);
    if (!userId) throw new Error('forecast: userId required (opts.userId or opts.request)');

    const startDate = opts.startDate || (opts.request && opts.request.request_date);
    if (!startDate) throw new Error('forecast: startDate required (opts.startDate or opts.request)');

    const events = eventsByUser.get(userId) || [];
    const extraDebits = opts.extraDebits || [];
    const overrides = opts.overrides || null;

    const unresolved = [];

    // ---- 1. Normalize every event into (date, delta) in home currency -----
    const flows = []; // {date, delta, eventId}

    for (const e of events) {
        const ov = overrides ? overrides.get(e.event_id) : null;
        if (ov && ov.skip) continue;

        if (!isCountableStatus(e.status)) continue;
        if (e.direction === 'non_cash') continue;
        if (e.event_type === 'investment_valuation') continue;

        // Resolve amount (blank => image-linked; must already be filled by loader).
        let amtRaw = e.amount;
        if (ov && ov.newAmount != null) amtRaw = ov.newAmount;
        if (amtRaw === '' || amtRaw == null) {
            unresolved.push(e.event_id);
            continue;
        }
        const amt = Number(amtRaw);
        if (!Number.isFinite(amt)) {
            unresolved.push(e.event_id);
            continue;
        }

        // Pending credits are NOT counted. Pending debits ARE.
        if (e.status === 'pending' && e.direction === 'credit') continue;

        // Settlement date is the cash date; fall back to event_date.
        const date = e.settlement_date || e.event_date;
        if (!date) continue;
        if (date < startDate) continue;              // already happened
        if (date > addDays(startDate, HORIZON_DAYS)) continue; // outside window

        // Convert to home currency on the settlement date.
        let amtHome;
        if (e.currency === home) {
            amtHome = amt;
        } else {
            try {
                amtHome = rates.convert(amt, e.currency, home, date);
            } catch (err) {
                throw new Error(`forecast: FX failed for ${e.event_id} ${e.currency}->${home} on ${date}: ${err.message}`);
            }
        }

        const sign = e.direction === 'credit' ? +1 : -1;
        flows.push({ date, delta: sign * amtHome, eventId: e.event_id });
    }

    // ---- 2. Fold in hypothetical debits (already in home currency) ---------
    for (const x of extraDebits) {
        let amtHome;
        if (!x.currency || x.currency === home) amtHome = Number(x.amount);
        else amtHome = rates.convert(Number(x.amount), x.currency, home, x.date);
        flows.push({ date: x.date, delta: -amtHome, eventId: x.eventId || '__extra__' });
    }

    // ---- 3. Sort by date; stable within a day: credits before debits? ------
    // Spec is ambiguous. We apply debits-then-credits within a day so the
    // lowest intraday balance is captured (conservative).
    flows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.delta - b.delta; // more negative (debit) first
    });

    // ---- 4. Walk day by day ------------------------------------------------
    const timeline = [];
    const breaches = [];
    let balance = startBalance;
    let lowestBalance = startBalance;
    let lowestDate = startDate;

    // Index flows by date for O(1) lookup.
    const byDate = new Map();
    for (const f of flows) {
        if (!byDate.has(f.date)) byDate.set(f.date, []);
        byDate.get(f.date).push(f);
    }

    const endDate = addDays(startDate, HORIZON_DAYS);
    for (let d = 0; d <= HORIZON_DAYS; d++) {
        const date = addDays(startDate, d);
        const dayFlows = byDate.get(date) || [];
        let inflows = 0, outflows = 0;
        for (const f of dayFlows) {
            balance += f.delta;
            if (f.delta >= 0) inflows += f.delta; else outflows += -f.delta;
        }
        timeline.push({ date, balance, inflows, outflows });
        if (balance < lowestBalance) {
            lowestBalance = balance;
            lowestDate = date;
        }
        if (balance < minBalance - 1e-9) breaches.push(date);
        if (date === endDate) break;
    }

    return {
        timeline,
        lowestBalance: round2(lowestBalance),
        lowestDate,
        breaches,
        minBalance,
        startBalance,
        unresolved,
    };
}

function isCountableStatus(status) {
    return status === 'settled' || status === 'scheduled' || status === 'pending';
}