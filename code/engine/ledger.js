/**
 * Financial Ledger Engine (Production Ready)
 * Handles starting balance aggregation, recurring event expansion,
 * transfer deduplication, multi-currency conversion, and cutoff dates.
 */

const MAX_RECURRING_INSTANCES = 10000;

// Default exchange rates relative to USD base
const DEFAULT_EXCHANGE_RATES = {
    USD: 1.0,
    EUR: 1.08,
    GBP: 1.27,
    INR: 0.012,
    JPY: 0.0065,
    CAD: 0.74,
    AUD: 0.65,
};

function toUTCDate(dateVal) {
    if (dateVal instanceof Date) {
        return new Date(Date.UTC(dateVal.getUTCFullYear(), dateVal.getUTCMonth(), dateVal.getUTCDate()));
    }
    const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateVal || ''));
    if (isoDateOnly) {
        const [, y, m, d] = isoDateOnly;
        return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    }
    const parsed = new Date(dateVal);
    if (isNaN(parsed.getTime())) return parsed;
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function normalizeDate(dateVal) {
    if (!dateVal) return new Date().toISOString().split('T')[0];
    const d = toUTCDate(dateVal);
    return isNaN(d.getTime()) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
}

function addMonthsPreservingAnchor(baseDate, monthsToAdd) {
    const anchorDay = baseDate.getUTCDate();
    const targetMonthIndex = baseDate.getUTCMonth() + monthsToAdd;
    const targetYear = baseDate.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
    const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;

    const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
    const dayToUse = Math.min(anchorDay, lastDayOfTargetMonth);

    return new Date(Date.UTC(targetYear, normalizedMonth, dayToUse));
}

export function projectRecurringEvents(events = [], projectionEndDate = '2026-12-31') {
    const safeEvents = Array.isArray(events) ? events : [];
    const expandedEvents = [];
    const cutoff = toUTCDate(projectionEndDate);

    for (const event of safeEvents) {
        if (!event) continue;
        expandedEvents.push(event);

        if (!event.is_recurring || !event.frequency) continue;

        const startDate = toUTCDate(event.date || event.timestamp);
        if (isNaN(startDate.getTime())) continue;

        const frequency = String(event.frequency).toLowerCase();
        let instanceCount = 1;
        let safetyCounter = 0;

        while (safetyCounter < MAX_RECURRING_INSTANCES) {
            safetyCounter++;
            let currentDate;

            if (frequency === 'daily') {
                currentDate = new Date(startDate);
                currentDate.setUTCDate(currentDate.getUTCDate() + instanceCount);
            } else if (frequency === 'weekly') {
                currentDate = new Date(startDate);
                currentDate.setUTCDate(currentDate.getUTCDate() + instanceCount * 7);
            } else if (frequency === 'bi-weekly') {
                currentDate = new Date(startDate);
                currentDate.setUTCDate(currentDate.getUTCDate() + instanceCount * 14);
            } else if (frequency === 'monthly') {
                currentDate = addMonthsPreservingAnchor(startDate, instanceCount);
            } else if (frequency === 'annually' || frequency === 'yearly') {
                currentDate = addMonthsPreservingAnchor(startDate, instanceCount * 12);
            } else {
                break;
            }

            if (isNaN(currentDate.getTime()) || currentDate > cutoff) break;

            const instanceDateStr = currentDate.toISOString().split('T')[0];
            const baseId = event.event_id || `EVT_${instanceCount}_${Math.random().toString(36).slice(2, 8)}`;
            expandedEvents.push({
                ...event,
                event_id: `${baseId}_rec_${instanceCount}`,
                parent_event_id: event.event_id || baseId,
                date: instanceDateStr,
                is_projected_instance: true,
            });

            instanceCount++;
        }
    }

    return expandedEvents;
}

export function deduplicateEvents(events = []) {
    const safeEvents = Array.isArray(events) ? events : [];
    const seenUserEventKeys = new Set();
    const deduplicated = [];

    for (const event of safeEvents) {
        if (!event) continue;

        const eventId = String(event.event_id || '').toUpperCase();
        const userId = String(event.user_id || 'DEFAULT_USER').toUpperCase();
        const userEventKey = `${userId}::${eventId}`;

        if (eventId && seenUserEventKeys.has(userEventKey)) {
            continue;
        }

        if (eventId) seenUserEventKeys.add(userEventKey);
        deduplicated.push(event);
    }

    return deduplicated;
}

function classifyEventType(event, currentUserId) {
    const type = String(event.type || event.transaction_type || '').toLowerCase();
    const amount = Number(event.amount || 0);

    if (type === 'income' || type === 'credit') return 'income';
    if (type === 'expense' || type === 'debit') return 'expense';

    if (type === 'transfer') {
        const fromUser = String(event.from_user_id || '').toUpperCase();
        const toUser = String(event.to_user_id || '').toUpperCase();

        if (fromUser && fromUser === currentUserId) return 'expense';
        if (toUser && toUser === currentUserId) return 'income';

        if (amount < 0) return 'expense';
        if (amount > 0) return 'income';
    }

    if (amount > 0) return 'income';
    if (amount < 0) return 'expense';
    return null;
}

function convertToBaseCurrency(amount, currency = 'USD', rates = {}, targetCurrency = 'USD') {
    const normalizedFrom = String(currency || 'USD').toUpperCase();
    const normalizedTarget = String(targetCurrency || 'USD').toUpperCase();

    const mergedRates = { ...DEFAULT_EXCHANGE_RATES, ...rates };
    const fromRate = mergedRates[normalizedFrom] || 1.0;
    const targetRate = mergedRates[normalizedTarget] || 1.0;

    return (amount * fromRate) / targetRate;
}

export function calculateLedger(users = [], events = [], options = {}) {
    const safeUsers = Array.isArray(users) ? users : [];
    const safeEvents = Array.isArray(events) ? events : [];
    const safeOptions = options && typeof options === 'object' ? options : {};

    const {
        projectionEndDate = '2026-12-31',
        baseCurrency = 'USD',
        exchangeRates = {},
    } = safeOptions;

    // Step 1: Initialize User Balances & Parse Historical Cutoff Dates
    const userLedgers = new Map();
    for (const u of safeUsers) {
        if (!u) continue;
        const userId = String(u.user_id || u.id || 'DEFAULT_USER').toUpperCase();
        const startingBalance = Number(u.starting_balance || u.initial_balance || 0);
        const userCurrency = u.currency || baseCurrency;

        const startingDateStr = u.as_of_date || u.starting_balance_date || null;
        const startingDate = startingDateStr ? toUTCDate(startingDateStr) : null;

        userLedgers.set(userId, {
            user_id: userId,
            name: u.name || u.user_name || userId,
            starting_balance: startingBalance,
            starting_balance_date: startingDateStr,
            starting_date_obj: startingDate,
            currency: userCurrency,
            total_income: 0,
            total_expenses: 0,
            ending_balance: startingBalance,
            transactions_count: 0,
        });
    }

    if (userLedgers.size === 0) {
        userLedgers.set('DEFAULT_USER', {
            user_id: 'DEFAULT_USER',
            name: 'Default User',
            starting_balance: 0,
            starting_balance_date: null,
            starting_date_obj: null,
            currency: baseCurrency,
            total_income: 0,
            total_expenses: 0,
            ending_balance: 0,
            transactions_count: 0,
        });
    }

    // Step 2: Expand recurring events & deduplicate
    const projectedEvents = projectRecurringEvents(safeEvents, projectionEndDate);
    const cleanEvents = deduplicateEvents(projectedEvents);

    // Step 3: Compute transaction impacts using integer cents
    const centsLedgers = new Map();
    for (const [userId, ledger] of userLedgers.entries()) {
        centsLedgers.set(userId, {
            starting_cents: Math.round(ledger.starting_balance * 100),
            income_cents: 0,
            expense_cents: 0,
        });
    }

    for (const event of cleanEvents) {
        if (!event) continue;
        const userId = String(event.user_id || 'DEFAULT_USER').toUpperCase();

        if (!userLedgers.has(userId)) {
            userLedgers.set(userId, {
                user_id: userId,
                name: userId,
                starting_balance: 0,
                starting_balance_date: null,
                starting_date_obj: null,
                currency: baseCurrency,
                total_income: 0,
                total_expenses: 0,
                ending_balance: 0,
                transactions_count: 0,
            });
            centsLedgers.set(userId, { starting_cents: 0, income_cents: 0, expense_cents: 0 });
        }

        const ledger = userLedgers.get(userId);

        const eventDate = toUTCDate(event.date || event.timestamp);
        if (ledger.starting_date_obj && !isNaN(eventDate.getTime())) {
            if (eventDate < ledger.starting_date_obj) {
                continue;
            }
        }

        const rawAmount = Math.abs(Number(event.amount || 0));
        const eventCurrency = event.currency || ledger.currency;
        const convertedAmount = convertToBaseCurrency(rawAmount, eventCurrency, exchangeRates, ledger.currency);
        const amountCents = Math.round(convertedAmount * 100);

        const classification = classifyEventType(event, userId);

        const cents = centsLedgers.get(userId);
        if (classification === 'income') {
            cents.income_cents += amountCents;
        } else if (classification === 'expense') {
            cents.expense_cents += amountCents;
        }

        ledger.transactions_count++;
    }

    // Step 4: Final conversion back to decimal units
    const userSummaries = Array.from(userLedgers.values()).map(l => {
        const cents = centsLedgers.get(l.user_id);
        const startingBalance = cents.starting_cents / 100;
        const totalIncome = cents.income_cents / 100;
        const totalExpenses = cents.expense_cents / 100;
        const endingBalance = (cents.starting_cents + cents.income_cents - cents.expense_cents) / 100;

        const { starting_date_obj, ...cleanSummary } = l;

        return {
            ...cleanSummary,
            starting_balance: Number(startingBalance.toFixed(2)),
            total_income: Number(totalIncome.toFixed(2)),
            total_expenses: Number(totalExpenses.toFixed(2)),
            ending_balance: Number(endingBalance.toFixed(2)),
        };
    });

    const netLedgerBalance = userSummaries.reduce((sum, u) => sum + u.ending_balance, 0);

    return {
        users: userSummaries,
        net_ledger_balance: Number(netLedgerBalance.toFixed(2)),
        processed_events_count: cleanEvents.length,
        processed_events: cleanEvents,
    };
}
