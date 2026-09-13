// code/engine/forecaster.js
import { addDays, round2 } from './utils.js';
import { detectRecurring, projectRecurring } from './recurrence.js';

const MAX_HORIZON_DAYS = 90;
const DAY_MS = 86400000;

function isValidDate(value) {
    return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function daysBetween(start, end) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    return Math.round((endMs - startMs) / DAY_MS);
}

function resolveOverrides(overrides, id) {
    if (!overrides) return null;
    if (typeof overrides.get === 'function') {
        return overrides.get(id) || null;
    }
    if (typeof overrides === 'object') {
        return overrides[id] || null;
    }
    return null;
}

function convertAmount(amount, currency, home, rates, date) {
    const value = Number(amount);

    if (!Number.isFinite(value)) {
        throw new Error(`Invalid amount: ${amount}`);
    }

    if (!currency || currency === home) return value;

    const converted = rates.convert(value, currency, home, date);

    if (!Number.isFinite(converted)) {
        throw new Error(`Invalid FX conversion result for ${currency}->${home}`);
    }

    return converted;
}

function getEventDate(event) {
    return event.settlement_date || event.event_date;
}

/**
 * Countable events:
 *   - settled (any direction)
 *   - pending debits (reserved against balance)
 *   - scheduled credits (confirmed income)
 *
 * NOT countable:
 *   - pending credits (unconfirmed income)
 *   - scheduled debits (not yet reserved per spec)
 *   - cancelled / failed / unrealized
 *   - non_cash / investment_valuation
 */
function isCountableEvent(event) {
    if (!event) return false;

    if (
        event.status !== 'settled' &&
        event.status !== 'pending' &&
        event.status !== 'scheduled'
    ) {
        return false;
    }

    if (event.direction === 'non_cash') return false;
    if (event.event_type === 'investment_valuation') return false;

    // Pending credits are not confirmed income.
    if (event.status === 'pending' && event.direction === 'credit') {
        return false;
    }

    // Scheduled debits are NOT reserved (spec: only pending debits are reserved).
    if (event.status === 'scheduled' && event.direction === 'debit') {
        return false;
    }

    return true;
}

/**
 * Horizon = min(90 days, desired_completion_date - request_date).
 * No buffer: the desired date already extends far enough to capture
 * the next projected income in the standard case.
 */
function getHorizonDays(startDate, desiredDate) {
    if (!desiredDate || desiredDate <= startDate) {
        return MAX_HORIZON_DAYS;
    }
    const diffDays = daysBetween(startDate, desiredDate);
    return Math.min(MAX_HORIZON_DAYS, Math.max(0, diffDays));
}

function addFlow(flows, date, delta, eventId) {
    if (!isValidDate(date)) return;
    if (!Number.isFinite(delta)) return;
    flows.push({ date, delta, eventId });
}

export function forecast(ctx, opts = {}) {
    const { profile, eventsByUser, rates } = ctx;

    if (!profile) {
        throw new Error('forecast: profile required');
    }
    if (!eventsByUser || typeof eventsByUser.get !== 'function') {
        throw new Error('forecast: eventsByUser Map required');
    }
    if (!rates || typeof rates.convert !== 'function') {
        throw new Error('forecast: rates.convert required');
    }

    const home = profile.home_currency;
    const minBalance = Number(profile.minimum_balance_to_keep);
    const startBalance = Number(profile.current_available_balance);

    if (!Number.isFinite(minBalance)) {
        throw new Error('forecast: invalid minimum balance');
    }
    if (!Number.isFinite(startBalance)) {
        throw new Error('forecast: invalid starting balance');
    }

    const userId =
        opts.userId ||
        (opts.request && opts.request.user_id) ||
        ctx.currentUserId;

    if (!userId) {
        throw new Error(
            'forecast: userId required (opts.userId or opts.request)'
        );
    }

    const startDate =
        opts.startDate ||
        (opts.request && opts.request.request_date);

    if (!isValidDate(startDate)) {
        throw new Error('forecast: valid startDate required');
    }

    const desired = opts.request && opts.request.desired_completion_date;
    const horizonDays = getHorizonDays(startDate, desired);
    const endDate = addDays(startDate, horizonDays);

    const events = eventsByUser.get(userId) || [];
    const extraDebits = Array.isArray(opts.extraDebits) ? opts.extraDebits : [];
    const overrides = opts.overrides || null;

    const unresolved = [];
    const flows = [];

    // ---------------------------------------------------------------
    // 1. Real countable events
    // ---------------------------------------------------------------
    for (const event of events) {
        const override = resolveOverrides(overrides, event.event_id);

        if (override && override.skip) continue;
        if (!isCountableEvent(event)) continue;

        const date = getEventDate(event);

        if (!isValidDate(date)) continue;
        if (date < startDate || date > endDate) continue;

        let amountRaw = event.amount;

        if (override && override.newAmount != null) {
            amountRaw = override.newAmount;
        }

        if (amountRaw === '' || amountRaw == null) {
            unresolved.push(event.event_id);
            continue;
        }

        const amount = Number(amountRaw);

        if (!Number.isFinite(amount) || amount < 0) {
            unresolved.push(event.event_id);
            continue;
        }

        let amountHome;

        try {
            amountHome = convertAmount(
                amount,
                event.currency,
                home,
                rates,
                date
            );
        } catch (err) {
            throw new Error(
                `forecast: FX failed for ${event.event_id} ` +
                `${event.currency}->${home} on ${date}: ${err.message}`
            );
        }

        const sign = event.direction === 'credit' ? 1 : -1;
        addFlow(flows, date, sign * amountHome, event.event_id);
    }

    // ---------------------------------------------------------------
    // 2. Projected recurring events
    // ---------------------------------------------------------------
    const recurring = detectRecurring(events, startDate);
    const projected = projectRecurring(recurring, startDate, horizonDays, events);

    for (const event of projected) {
        let override = resolveOverrides(overrides, event.event_id);

        if (!override && event.patternKey) {
            override = resolveOverrides(overrides, event.patternKey);
        }
        if (!override && event.sourceEventId) {
            override = resolveOverrides(overrides, event.sourceEventId);
        }

        if (override && override.skip) continue;

        const date = getEventDate(event);

        if (!isValidDate(date)) continue;
        if (date < startDate || date > endDate) continue;

        let amount = Number(event.amount);

        if (override && override.newAmount != null) {
            amount = Number(override.newAmount);
        }

        if (!Number.isFinite(amount) || amount <= 0) continue;

        let amountHome;

        try {
            amountHome = convertAmount(
                amount,
                event.currency,
                home,
                rates,
                date
            );
        } catch {
            // An unconvertible projection must not create a false
            // cash-flow entry.
            continue;
        }

        const sign = event.direction === 'credit' ? 1 : -1;
        addFlow(flows, date, sign * amountHome, event.event_id);
    }

    // ---------------------------------------------------------------
    // 3. Hypothetical debits
    // ---------------------------------------------------------------
    for (const debit of extraDebits) {
        if (!debit || !isValidDate(debit.date)) continue;
        if (debit.date < startDate || debit.date > endDate) continue;

        const amount = Number(debit.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        let amountHome;

        try {
            amountHome = convertAmount(
                amount,
                debit.currency,
                home,
                rates,
                debit.date
            );
        } catch {
            continue;
        }

        addFlow(flows, debit.date, -amountHome, debit.eventId || '__extra__');
    }

    // ---------------------------------------------------------------
    // 4. Sort flows
    // ---------------------------------------------------------------
    flows.sort((a, b) => {
        if (a.date !== b.date) {
            return a.date < b.date ? -1 : 1;
        }
        if (a.delta !== b.delta) {
            return a.delta - b.delta;
        }
        return String(a.eventId).localeCompare(String(b.eventId));
    });

    // ---------------------------------------------------------------
    // 5. Walk the forecast day by day
    // ---------------------------------------------------------------
    const timeline = [];
    const breaches = [];

    let balance = startBalance;
    let lowestBalance = startBalance;
    let lowestDate = startDate;

    const byDate = new Map();

    for (const flow of flows) {
        if (!byDate.has(flow.date)) {
            byDate.set(flow.date, []);
        }
        byDate.get(flow.date).push(flow);
    }

    for (let offset = 0; offset <= horizonDays; offset++) {
        const date = addDays(startDate, offset);
        const dayFlows = byDate.get(date) || [];

        let inflows = 0;
        let outflows = 0;

        for (const flow of dayFlows) {
            balance += flow.delta;

            if (flow.delta >= 0) {
                inflows += flow.delta;
            } else {
                outflows += -flow.delta;
            }
        }

        timeline.push({
            date,
            balance: round2(balance),
            inflows: round2(inflows),
            outflows: round2(outflows),
        });

        if (balance < lowestBalance) {
            lowestBalance = balance;
            lowestDate = date;
        }

        if (balance < minBalance - 1e-9) {
            breaches.push(date);
        }
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