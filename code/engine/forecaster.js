// code/engine/forecaster.js
import { parseISO, toISO, addDays, round2 } from './utils.js';
import { detectRecurring, projectRecurring } from './recurrence.js';

const DAY_MS = 86400000;
const MAX_HORIZON_DAYS = 90;

/**
 * Forecast the user's daily balance from request_date forward.
 *
 * Window:
 *   endDate = min(request_date + 90d, max(request_date + 30d, desired_completion_date))
 *
 * Rules enforced:
 *   - Real events with status settled or pending are counted.
 *   - Real events with status scheduled are counted ONLY if direction is credit.
 *   - pending CREDITS are NOT counted.
 *   - investment_valuation (non_cash) is never counted.
 *   - Projected recurring events (from recurrence.js) are added on top.
 *   - Amounts converted to home_currency on their settlement date.
 *   - extraDebits applied on their date, in home currency.
 */
export function forecast(ctx, opts = {}) {
    const { profile, eventsByUser, rates } = ctx;
    const home = profile.home_currency;
    const minBalance = Number(profile.minimum_balance_to_keep);
    const startBalance = Number(profile.current_available_balance);

    const userId = opts.userId
        || (opts.request && opts.request.user_id)
        || ctx.currentUserId;
    if (!userId) throw new Error('forecast: userId required (opts.userId or opts.request)');

    const startDate = opts.startDate
        || (opts.request && opts.request.request_date);
    if (!startDate) throw new Error('forecast: startDate required (opts.startDate or opts.request)');

    // ---- Window selection --------------------------------------------------
    // Base horizon = 90 days; shrink to desired_completion_date if that's
    // sooner. Floor at 30 days so a near-term request still sees enough
    // runway to catch recurring expenses.
    let horizonDays = MAX_HORIZON_DAYS;
    const desired = opts.request && opts.request.desired_completion_date;
    if (desired && desired > startDate) {
        const [sy, sm, sd] = startDate.split('-').map(Number);
        const [dy, dm, dd] = desired.split('-').map(Number);
        const diffDays = Math.round(
            (Date.UTC(dy, dm - 1, dd) - Date.UTC(sy, sm - 1, sd)) / DAY_MS
        );
        horizonDays = Math.max(1, Math.min(MAX_HORIZON_DAYS, diffDays));
    }

    const endDate = addDays(startDate, horizonDays);

    const events = eventsByUser.get(userId) || [];
    const extraDebits = opts.extraDebits || [];
    const overrides = opts.overrides || null;

    const unresolved = [];
    const flows = [];

    // ---- 1. Real countable events -----------------------------------------
    for (const e of events) {
        const ov = overrides ? overrides.get(e.event_id) : null;
        if (ov && ov.skip) continue;

        // Count settled, pending, and scheduled CREDITS.
        // Scheduled debits are not counted.
        const isRealCountable =
            e.status === 'settled' ||
            e.status === 'pending' ||
            (e.status === 'scheduled' && e.direction === 'credit');
        if (!isRealCountable) continue;

        if (e.direction === 'non_cash') continue;
        if (e.event_type === 'investment_valuation') continue;

        let amtRaw = e.amount;
        if (ov && ov.newAmount != null) amtRaw = ov.newAmount;
        if (amtRaw === '' || amtRaw == null) { unresolved.push(e.event_id); continue; }
        const amt = Number(amtRaw);
        if (!Number.isFinite(amt)) { unresolved.push(e.event_id); continue; }

        if (e.status === 'pending' && e.direction === 'credit') continue;

        const date = e.settlement_date || e.event_date;
        if (!date) continue;
        if (date < startDate) continue;
        if (date > endDate) continue;

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

    // ---- 2. Projected recurring events ------------------------------------
    const recurring = detectRecurring(events, startDate);
    const projected = projectRecurring(recurring, startDate, horizonDays, events);

    for (const p of projected) {
        const date = p.settlement_date || p.event_date;
        if (!date || date < startDate || date > endDate) continue;

        const amt = Number(p.amount);
        if (!Number.isFinite(amt) || amt <= 0) continue;

        let amtHome;
        if (p.currency === home) {
            amtHome = amt;
        } else {
            try {
                amtHome = rates.convert(amt, p.currency, home, date);
            } catch {
                continue;
            }
        }

        const sign = p.direction === 'credit' ? +1 : -1;
        flows.push({ date, delta: sign * amtHome, eventId: p.event_id });
    }

    // ---- 3. Hypothetical debits -------------------------------------------
    for (const x of extraDebits) {
        let amtHome;
        if (!x.currency || x.currency === home) amtHome = Number(x.amount);
        else amtHome = rates.convert(Number(x.amount), x.currency, home, x.date);
        flows.push({ date: x.date, delta: -amtHome, eventId: x.eventId || '__extra__' });
    }

    // ---- 4. Sort: by date, debits before credits within a day -------------
    flows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.delta - b.delta;
    });

    // ---- 5. Walk day by day ----------------------------------------------
    const timeline = [];
    const breaches = [];
    let balance = startBalance;
    let lowestBalance = startBalance;
    let lowestDate = startDate;

    const byDate = new Map();
    for (const f of flows) {
        if (!byDate.has(f.date)) byDate.set(f.date, []);
        byDate.get(f.date).push(f);
    }

    for (let d = 0; d <= horizonDays; d++) {
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
        horizonDays,
    };
}