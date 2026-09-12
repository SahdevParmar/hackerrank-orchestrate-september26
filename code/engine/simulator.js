
/**
 * 90-Day Cash Flow Simulator Engine
 *
 * Simulates daily balances for users over a configurable horizon.
 * A deficit means the actual balance is below zero.
 * A minimum-balance breach means the balance is below the user's
 * preferred reserve, but is not necessarily a cash deficit.
 */

const MAX_SIMULATION_DAYS = 36500;

const DEFAULT_EXCHANGE_RATES = {
    USD: 1.0,
    EUR: 1.08,
    GBP: 1.27,
    INR: 0.012,
    JPY: 0.0065,
    CAD: 0.74,
    AUD: 0.65,
};

function parseUTCDate(dateVal) {
    if (dateVal === null || dateVal === undefined || dateVal === '') {
        return null;
    }

    if (dateVal instanceof Date) {
        if (Number.isNaN(dateVal.getTime())) return null;

        return new Date(Date.UTC(
            dateVal.getUTCFullYear(),
            dateVal.getUTCMonth(),
            dateVal.getUTCDate()
        ));
    }

    const value = String(dateVal).trim();
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        const date = new Date(Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day)
        ));

        return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) return null;

    return new Date(Date.UTC(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth(),
        parsed.getUTCDate()
    ));
}

function formatDateISO(date) {
    return date.toISOString().split('T')[0];
}

function normalizeEventDateKey(dateVal) {
    const date = parseUTCDate(dateVal);
    return date ? formatDateISO(date) : null;
}

function addDaysToDate(date, days) {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

function convertToBaseCurrency(
    amount,
    currency = 'USD',
    rates = {},
    targetCurrency = 'USD'
) {
    const from = String(currency || 'USD').toUpperCase();
    const target = String(targetCurrency || 'USD').toUpperCase();

    const numericAmount = Number(amount) || 0;

    if (from === target) return numericAmount;

    const mergedRates = {
        ...DEFAULT_EXCHANGE_RATES,
        ...(rates || {}),
    };

    const fromRate = Number(mergedRates[from]) || 1;
    const targetRate = Number(mergedRates[target]) || 1;

    return (numericAmount * fromRate) / targetRate;
}

function createSimState(
    userId,
    name,
    startingBalance,
    minBalanceToKeep,
    currency,
    anchorDate
) {
    const starting = Number(startingBalance) || 0;
    const minimum = Number(minBalanceToKeep) || 0;
    const startingCents = Math.round(starting * 100);

    return {
        userId,
        name,
        currency,

        startingBalance: starting,
        minBalanceToKeep: minimum,

        runningBalanceCents: startingCents,
        minBalanceCents: Math.round(minimum * 100),

        lowestBalanceCents: startingCents,
        lowestBalanceDate: anchorDate,

        highestBalanceCents: startingCents,
        highestBalanceDate: anchorDate,

        deficitDaysCount: 0,
        minBalanceBreachDaysCount: 0,

        firstDeficitDate: null,
        firstBreachDate: null,

        maxBufferDeficitCents: 0,

        timeline: [],
        autoCreatedFromOrphanEvent: false,
    };
}

function getUserId(value) {
    return String(
        value?.user_id ??
        value?.userId ??
        value?.id ??
        'DEFAULT_USER'
    ).toUpperCase();
}

function getEventType(event) {
    return String(
        event?.type ??
        event?.transaction_type ??
        ''
    ).toLowerCase();
}

function isIncomeEvent(event, userId) {
    const type = getEventType(event);

    if (type === 'income' || type === 'credit') return true;
    if (type === 'expense' || type === 'debit') return false;

    if (type === 'transfer') {
        return String(event.to_user_id || '').toUpperCase() === userId;
    }

    return Number(event.amount || 0) > 0;
}

function roundMoney(cents) {
    return Number((cents / 100).toFixed(2));
}

export function simulate90DayCashFlow(
    users = [],
    events = [],
    options = {}
) {
    const safeUsers = Array.isArray(users) ? users : [];
    const safeEvents = Array.isArray(events) ? events : [];
    const safeOptions =
        options && typeof options === 'object' ? options : {};

    const requestedDays = Number(safeOptions.simulationDays ?? 90);
    const daysToSimulate = Math.max(
        0,
        Math.min(
            Number.isFinite(requestedDays) ? requestedDays : 90,
            MAX_SIMULATION_DAYS
        )
    );

    const startDate =
        parseUTCDate(safeOptions.startDate) || parseUTCDate(new Date());

    const endDate = addDaysToDate(
        startDate,
        Math.max(daysToSimulate - 1, 0)
    );

    const startDateStr = formatDateISO(startDate);
    const endDateStr = formatDateISO(endDate);

    const userSimulations = new Map();

    for (const user of safeUsers) {
        if (!user) continue;

        const userId = getUserId(user);
        const currency =
            user.currency || safeOptions.baseCurrency || 'USD';

        userSimulations.set(
            userId,
            createSimState(
                userId,
                user.name || user.user_name || userId,
                user.starting_balance ?? user.initial_balance ?? 0,
                user.minimum_balance_to_keep ?? user.min_balance ?? 0,
                currency,
                startDateStr
            )
        );
    }

    if (userSimulations.size === 0) {
        const userId = 'DEFAULT_USER';

        userSimulations.set(
            userId,
            createSimState(
                userId,
                'Default User',
                safeOptions.startingBalance ?? 0,
                safeOptions.minimumBalanceToKeep ?? 0,
                safeOptions.baseCurrency || 'USD',
                startDateStr
            )
        );
    }

    const eventsByDateUser = new Map();
    const diagnostics = {
        orphanUserIdsAutoCreated: [],
        unparseableDateEventsSkipped: 0,
        possiblyUnexpandedRecurringEvents: 0,
        currencyWarnings: [],
    };

    const orphanIds = new Set();

    for (const event of safeEvents) {
        if (!event || !event.date) {
            diagnostics.unparseableDateEventsSkipped++;
            continue;
        }

        const dateKey = normalizeEventDateKey(event.date);

        if (!dateKey) {
            diagnostics.unparseableDateEventsSkipped++;
            continue;
        }

        if (event.is_recurring && !event.is_projected_instance) {
            diagnostics.possiblyUnexpandedRecurringEvents++;
        }

        const userId = getUserId(event);

        if (!userSimulations.has(userId)) {
            const sim = createSimState(
                userId,
                userId,
                0,
                0,
                safeOptions.baseCurrency || 'USD',
                startDateStr
            );

            sim.autoCreatedFromOrphanEvent = true;
            userSimulations.set(userId, sim);
            orphanIds.add(userId);
        }

        const sim = userSimulations.get(userId);

        if (
            event.currency &&
            sim.currency &&
            event.currency.toUpperCase() !== sim.currency.toUpperCase()
        ) {
            diagnostics.currencyWarnings.push({
                userId,
                eventId: event.event_id || null,
                eventCurrency: event.currency,
                accountCurrency: sim.currency,
                date: dateKey,
            });
        }

        const key = `${dateKey}::${userId}`;

        if (!eventsByDateUser.has(key)) {
            eventsByDateUser.set(key, []);
        }

        eventsByDateUser.get(key).push(event);
    }

    diagnostics.orphanUserIdsAutoCreated = [...orphanIds];

    const currentDate = new Date(startDate);

    for (let dayIndex = 0; dayIndex < daysToSimulate; dayIndex++) {
        const dateStr = formatDateISO(currentDate);

        for (const [userId, sim] of userSimulations.entries()) {
            const dayEvents =
                eventsByDateUser.get(`${dateStr}::${userId}`) || [];

            let incomeCents = 0;
            let expenseCents = 0;

            for (const event of dayEvents) {
                const amount = Math.abs(Number(event.amount || 0));

                const convertedAmount = convertToBaseCurrency(
                    amount,
                    event.currency || sim.currency,
                    safeOptions.exchangeRates || {},
                    sim.currency
                );

                const amountCents = Math.round(convertedAmount * 100);

                if (isIncomeEvent(event, userId)) {
                    incomeCents += amountCents;
                } else {
                    expenseCents += amountCents;
                }
            }

            const startingCents = sim.runningBalanceCents;
            const endingCents =
                startingCents + incomeCents - expenseCents;

            sim.runningBalanceCents = endingCents;

            const isDeficit = endingCents < 0;
            const isBelowMin = endingCents < sim.minBalanceCents;

            const bufferDeficit = Math.max(
                0,
                sim.minBalanceCents - endingCents
            );

            sim.maxBufferDeficitCents = Math.max(
                sim.maxBufferDeficitCents,
                bufferDeficit
            );

            if (endingCents < sim.lowestBalanceCents) {
                sim.lowestBalanceCents = endingCents;
                sim.lowestBalanceDate = dateStr;
            }

            if (endingCents > sim.highestBalanceCents) {
                sim.highestBalanceCents = endingCents;
                sim.highestBalanceDate = dateStr;
            }

            if (isDeficit) {
                sim.deficitDaysCount++;

                if (!sim.firstDeficitDate) {
                    sim.firstDeficitDate = dateStr;
                }
            }

            if (isBelowMin) {
                sim.minBalanceBreachDaysCount++;

                if (!sim.firstBreachDate) {
                    sim.firstBreachDate = dateStr;
                }
            }

            sim.timeline.push({
                date: dateStr,
                dayIndex: dayIndex + 1,
                startingBalance: roundMoney(startingCents),
                income: roundMoney(incomeCents),
                expenses: roundMoney(expenseCents),
                endingBalance: roundMoney(endingCents),
                minimumBalanceThreshold: sim.minBalanceToKeep,
                isBelowMinBalance: isBelowMin,
                isDeficit,
                eventsCount: dayEvents.length,
            });
        }

        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    const userResults = [...userSimulations.values()].map(sim => ({
        userId: sim.userId,
        name: sim.name,
        currency: sim.currency,

        startingBalance: sim.startingBalance,
        endingBalance: roundMoney(sim.runningBalanceCents),

        minimumBalanceToKeep: sim.minBalanceToKeep,

        lowestBalance: {
            amount: roundMoney(sim.lowestBalanceCents),
            date: sim.lowestBalanceDate,
        },

        highestBalance: {
            amount: roundMoney(sim.highestBalanceCents),
            date: sim.highestBalanceDate,
        },

        deficitDaysCount: sim.deficitDaysCount,
        minBalanceBreachDaysCount: sim.minBalanceBreachDaysCount,

        firstDeficitDate: sim.firstDeficitDate,
        firstMinBalanceBreachDate: sim.firstBreachDate,

        recommendedBufferNeeded: roundMoney(
            sim.maxBufferDeficitCents
        ),

        status:
            sim.deficitDaysCount > 0
                ? 'DEFICIT_RISK'
                : sim.minBalanceBreachDaysCount > 0
                    ? 'WARNING_BELOW_MIN'
                    : 'HEALTHY',

        autoCreatedFromOrphanEvent: sim.autoCreatedFromOrphanEvent,
        dailyTimeline: sim.timeline,
    }));

    return {
        simulationWindow: {
            startDate: startDateStr,
            endDate: endDateStr,
            totalDays: daysToSimulate,
            requestedDays,
        },
        users: userResults,
        diagnostics,
    };
}