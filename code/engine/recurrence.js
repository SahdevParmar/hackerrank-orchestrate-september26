// Detect recurring events from history. The dataset does NOT label recurrence,
// so we infer it: a (userId, category, event_type) that repeats on a roughly
// monthly cadence. We use the median day-of-month and amount.

function median(nums) {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function detectRecurring(classifiedEvents, asOfDate) {
    // Group by (userId, category, eventType) for debits and credits.
    const groups = new Map();
    for (const e of classifiedEvents) {
        if (e.kind === 'noncash' || e.kind === 'unknown') continue;
        if (e.status !== 'settled') continue;
        if (!e.eventDate || e.eventDate > asOfDate) continue;
        const key = `${e.userId}|${e.category}|${e.eventType}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    const recurring = [];
    for (const [key, list] of groups.entries()) {
        if (list.length < 3) continue; // need history

        // Compute day-of-month and check monthly spacing.
        const doms = list.map(e => Number(e.eventDate.slice(8, 10)));
        const amounts = list.map(e => e.amount).filter(a => Number.isFinite(a));
        if (!amounts.length) continue;

        // Check monthly cadence: at least 3 consecutive months with ~same DOM.
        const months = new Set(list.map(e => e.eventDate.slice(0, 7)));
        if (months.size < 3) continue;

        const medDom = Math.round(median(doms));
        const medAmount = median(amounts);
        if (medAmount <= 0) continue;

        // Latest occurrence anchors the next projection.
        const last = list.reduce((a, b) => (a.eventDate > b.eventDate ? a : b));
        recurring.push({
            key,
            userId: last.userId,
            category: last.category,
            eventType: last.eventType,
            kind: last.kind,
            currency: last.currency,
            medianAmount: medAmount,
            dayOfMonth: medDom,
            lastDate: last.eventDate,
            flexibility: last.flexibility,
            minimumAllowedAmount: last.minimumAllowedAmount,
            description: last.description,
        });
    }
    return recurring;
}

// Project recurring events from asOfDate forward `days` days.
export function projectRecurring(recurring, asOfDate, days) {
    const out = [];
    const start = new Date(`${asOfDate}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + days);

    for (const r of recurring) {
        // Next occurrence after asOfDate.
        let y = start.getUTCFullYear();
        let m = start.getUTCMonth();
        // step month by month until the projected date is > asOfDate
        for (let i = 0; i < 24; i++) {
            const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
            const dom = Math.min(r.dayOfMonth, lastDay);
            const d = new Date(Date.UTC(y, m, dom));
            if (d > end) break;
            if (d >= start) {
                out.push({
                    eventId: `${r.key}_proj_${i}`,
                    userId: r.userId,
                    kind: r.kind,
                    status: 'scheduled',        // projected
                    eventType: r.eventType,
                    category: r.category,
                    flexibility: r.flexibility,
                    minimumAllowedAmount: r.minimumAllowedAmount,
                    currency: r.currency,
                    amount: r.medianAmount,
                    eventDate: d.toISOString().slice(0, 10),
                    settlementDate: d.toISOString().slice(0, 10),
                    description: `Projected: ${r.description}`,
                });
            }
            m += 1;
            if (m > 11) { m = 0; y += 1; }
        }
    }
    return out;
}