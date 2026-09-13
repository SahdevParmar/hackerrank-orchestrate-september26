// Infer recurring events from settled historical transactions.
//
// Supported cadences:
//   - Weekly: 7 days
//   - Biweekly: 14 days
//   - Monthly: calendar-month progression
//
// Only settled events are used to infer recurrence.
// Pending and scheduled events are not historical evidence.

const DAY_MS = 86400000;

function median(numbers) {
    if (!numbers.length) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function getDate(event) {
    return event.settlement_date || event.event_date;
}

function isValidDate(date) {
    return typeof date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}

function daysBetween(a, b) {
    const start = Date.parse(`${a}T00:00:00Z`);
    const end = Date.parse(`${b}T00:00:00Z`);
    return Math.round((end - start) / DAY_MS);
}

function addDays(date, days) {
    const ms = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
    return new Date(ms).toISOString().slice(0, 10);
}

function addMonthsClamped(date, months) {
    const [year, month, day] = date.split('-').map(Number);
    const targetMonth = month - 1 + months;
    const targetYear = year + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(
        Date.UTC(targetYear, normalizedMonth + 1, 0)
    ).getUTCDate();
    const clampedDay = Math.min(day, lastDay);
    return [
        targetYear,
        String(normalizedMonth + 1).padStart(2, '0'),
        String(clampedDay).padStart(2, '0'),
    ].join('-');
}

function snapCadence(gap) {
    if (gap >= 5 && gap <= 10) return 7;
    if (gap >= 11 && gap <= 18) return 14;
    if (gap >= 25 && gap <= 35) return 30;
    return null;
}

/**
 * Choose the cadence for a group of gaps.
 * Prefers the LARGEST cadence among candidates that are supported by
 * at least 3 gaps. Rationale: a user with monthly AND weekly occurrences
 * of the same category (e.g. salary + bonuses) should have the monthly
 * cadence treated as the recurring baseline.
 */
function chooseCadence(gaps) {
    const counts = new Map();

    for (const gap of gaps) {
        const cadence = snapCadence(gap);
        if (cadence == null) continue;
        counts.set(cadence, (counts.get(cadence) || 0) + 1);
    }

    if (counts.size === 0) return null;

    const viable = [...counts.entries()].filter(([, n]) => n >= 3);
    if (viable.length === 0) return null;

    viable.sort((a, b) => b[0] - a[0]);
    return viable[0][0];
}

function chooseAmount(events) {
    const amounts = events
        .map(event => Number(event.amount))
        .filter(amount => Number.isFinite(amount) && amount > 0);

    if (amounts.length < 3) return null;

    const amount = median(amounts);
    return amount > 0 ? amount : null;
}

function latestMetadata(events) {
    let flexibility = '';
    let minimumAllowedAmount = '';

    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];

        if (!flexibility && event.flexibility) {
            flexibility = String(event.flexibility).trim();
        }

        if (
            !minimumAllowedAmount &&
            event.minimum_allowed_amount != null &&
            String(event.minimum_allowed_amount).trim() !== ''
        ) {
            minimumAllowedAmount = String(
                event.minimum_allowed_amount
            ).trim();
        }

        if (flexibility && minimumAllowedAmount) break;
    }

    return { flexibility, minimumAllowedAmount };
}

function buildGroupKey(event) {
    return [
        event.category || '',
        event.event_type || '',
        event.direction || '',
    ].join('|');
}

export function detectRecurring(events, asOfDate) {
    const groups = new Map();

    for (const event of events || []) {
        if (!event || event.status !== 'settled') continue;
        if (event.direction === 'non_cash') continue;
        if (event.event_type === 'investment_valuation') continue;

        const date = getDate(event);

        if (!isValidDate(date)) continue;
        if (date > asOfDate) continue;

        const key = buildGroupKey(event);

        if (!groups.has(key)) {
            groups.set(key, []);
        }

        groups.get(key).push(event);
    }

    const recurring = [];

    for (const [key, group] of groups) {
        if (group.length < 3) continue;

        const list = [...group].sort((a, b) => {
            const da = getDate(a);
            const db = getDate(b);

            if (da === db) {
                return String(a.event_id).localeCompare(String(b.event_id));
            }

            return da < db ? -1 : 1;
        });

        const dates = list.map(getDate);
        const gaps = [];

        for (let i = 1; i < dates.length; i++) {
            const gap = daysBetween(dates[i - 1], dates[i]);
            if (gap > 0) gaps.push(gap);
        }

        const cadenceDays = chooseCadence(gaps);
        if (cadenceDays == null) continue;

        const amount = chooseAmount(list);
        if (amount == null) continue;

        const latest = list[list.length - 1];
        const metadata = latestMetadata(list);

        // Semantic override: income, subscriptions, and debt payments are
        // monthly by definition, regardless of what the history gaps suggest.
        // This guards against misclassification when a category happens to
        // have weekly occurrences mixed in (e.g. salary + bonuses).
        let finalCadence = cadenceDays;
        if (
            latest.event_type === 'income' ||
            latest.event_type === 'subscription' ||
            latest.event_type === 'debt_payment'
        ) {
            finalCadence = 30;
        }

        recurring.push({
            key,
            category: latest.category,
            eventType: latest.event_type,
            direction: latest.direction,
            currency: latest.currency,
            amount,
            cadenceDays: finalCadence,
            lastDate: dates[dates.length - 1],
            lastEventId: latest.event_id,
            flexibility: metadata.flexibility,
            minimumAllowedAmount: metadata.minimumAllowedAmount,
        });
    }

    return recurring;
}

function makeProjection(recurring, date, index) {
    return {
        event_id: `${recurring.key}_proj_${index}`,
        patternKey: recurring.key,
        sourceEventId: recurring.lastEventId,

        category: recurring.category,
        event_type: recurring.eventType,
        direction: recurring.direction,
        currency: recurring.currency,

        amount: recurring.amount,

        event_date: date,
        settlement_date: date,
        status: '__projected__',

        flexibility: recurring.flexibility || 'fixed',
        minimum_allowed_amount:
            recurring.minimumAllowedAmount || '',
    };
}

function realEventSignature(event) {
    const date = getDate(event);
    if (!isValidDate(date)) return null;
    return [
        event.category || '',
        event.event_type || '',
        event.direction || '',
        date,
    ].join('|');
}

export function projectRecurring(
    recurring,
    asOfDate,
    days,
    realEvents = []
) {
    const out = [];

    if (!isValidDate(asOfDate)) return out;

    const endDate = addDays(asOfDate, days);
    const realDates = new Set();

    for (const event of realEvents) {
        const signature = realEventSignature(event);
        if (signature) realDates.add(signature);
    }

    for (const pattern of recurring || []) {
        let index = 0;

        if (pattern.cadenceDays === 30) {
            // Calendar-month recurrence.
            let monthOffset = 1;

            while (monthOffset <= 24) {
                const date = addMonthsClamped(pattern.lastDate, monthOffset);

                if (date > endDate) break;

                if (date >= asOfDate) {
                    const signature = [
                        pattern.category || '',
                        pattern.eventType || '',
                        pattern.direction || '',
                        date,
                    ].join('|');

                    if (!realDates.has(signature)) {
                        out.push(makeProjection(pattern, date, index));
                        index++;
                    }
                }

                monthOffset++;
            }
        } else {
            // Weekly or biweekly recurrence.
            let nextDate = addDays(pattern.lastDate, pattern.cadenceDays);

            while (nextDate <= endDate && index < 60) {
                if (nextDate >= asOfDate) {
                    const signature = [
                        pattern.category || '',
                        pattern.eventType || '',
                        pattern.direction || '',
                        nextDate,
                    ].join('|');

                    if (!realDates.has(signature)) {
                        out.push(makeProjection(pattern, nextDate, index));
                        index++;
                    }
                }

                nextDate = addDays(nextDate, pattern.cadenceDays);
            }
        }
    }

    out.sort((a, b) => {
        if (a.settlement_date !== b.settlement_date) {
            return a.settlement_date < b.settlement_date ? -1 : 1;
        }
        return String(a.event_id).localeCompare(String(b.event_id));
    });

    return out;
}