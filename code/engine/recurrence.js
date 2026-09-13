// code/engine/recurrence.js
// Infer recurrence from settled history. The dataset has no recurrence labels,
// so we detect cadence from the gaps between consecutive occurrences.

const DAY_MS = 86400000;

function median(nums) {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function daysBetween(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/**
 * Detect recurring patterns in a user's settled history.
 * Returns one descriptor per (category, event_type, direction) that recurs.
 */
export function detectRecurring(events, asOfDate) {
    const groups = new Map();
    for (const e of events) {
        if (e.status !== 'settled') continue;
        if (e.direction === 'non_cash') continue;
        if (e.event_type === 'investment_valuation') continue;
        const date = e.settlement_date || e.event_date;
        if (!date || date > asOfDate) continue;
        const key = `${e.category}|${e.event_type}|${e.direction}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    const out = [];
    for (const [key, list] of groups) {
        if (list.length < 3) continue;

        list.sort((a, b) =>
            (a.settlement_date || a.event_date) < (b.settlement_date || b.event_date) ? -1 : 1
        );
        const dates = list.map(e => e.settlement_date || e.event_date);

        const gaps = [];
        for (let i = 1; i < dates.length; i++) {
            gaps.push(daysBetween(dates[i - 1], dates[i]));
        }

        // Snap each gap to the nearest canonical cadence.
        const snapped = gaps.map(g => {
            if (g >= 5 && g <= 10) return 7;    // weekly
            if (g >= 11 && g <= 18) return 14;  // biweekly
            if (g >= 25 && g <= 35) return 30;  // monthly
            return null;                         // irregular
        });

        const counts = new Map();
        for (const s of snapped) {
            if (s == null) continue;
            counts.set(s, (counts.get(s) || 0) + 1);
        }
        if (counts.size === 0) continue;

        const viable = [...counts.entries()].filter(([, n]) => n >= 3);
        if (viable.length === 0) continue;

        // Prefer the LARGEST cadence among viable candidates. Rationale:
        // if a user has monthly AND weekly occurrences of the same category
        // (e.g. salary + bonuses), the monthly cadence is the recurring
        // baseline.
        viable.sort((a, b) => b[0] - a[0]);
        const bestCadence = viable[0][0];

        // Median amount over occurrences (not gaps).
        const amounts = list
            .map(e => Number(e.amount))
            .filter(a => Number.isFinite(a) && a > 0);
        if (amounts.length < 3) continue;
        const medAmt = median(amounts);
        if (medAmt <= 0) continue;

        const last = list[list.length - 1];

        // Semantic override: income, subscriptions, and debt payments are
        // monthly by definition, regardless of what the history gaps suggest.
        // This guards against misclassification when a category happens to
        // have weekly occurrences mixed in (e.g. salary + bonuses).
        let finalCadence = bestCadence;
        if (last.event_type === 'income' ||
            last.event_type === 'subscription' ||
            last.event_type === 'debt_payment') {
            finalCadence = 30;
        }

        out.push({
            key,
            category: last.category,
            eventType: last.event_type,
            direction: last.direction,
            currency: last.currency,
            amount: medAmt,
            cadenceDays: finalCadence,
            lastDate: dates[dates.length - 1],
        });
    }
    return out;
}

/**
 * Project recurring patterns forward from asOfDate for `days` days.
 *
 * For monthly cadences (30 days), steps by calendar month and anchors each
 * projection on the same day-of-month as the last observed event. This
 * matches how real bills and salaries actually recur (e.g. the 15th of
 * every month), rather than drifting by ±1–2 days each month.
 *
 * For non-monthly cadences (7, 14 days), steps by the cadence interval.
 *
 * Skips projections that collide with a real event on the same date in the
 * same (category, event_type, direction) group.
 */
export function projectRecurring(recurring, asOfDate, days, realEvents = []) {
    const out = [];
    const startMs = Date.parse(asOfDate + 'T00:00:00Z');
    const endMs = startMs + days * DAY_MS;

    // Index real event dates by group key so we can skip duplicates.
    const realDates = new Set();
    for (const e of realEvents) {
        const d = e.settlement_date || e.event_date;
        if (!d) continue;
        realDates.add(`${e.category}|${e.event_type}|${e.direction}|${d}`);
    }

    for (const r of recurring) {
        const [ly, lm, ld] = r.lastDate.split('-').map(Number);

        if (r.cadenceDays === 30) {
            // ---- Monthly: step by calendar month, anchor on same DOM ----
            let y = ly;
            let m = lm - 1;   // 0-indexed
            let i = 0;
            while (i < 24) {
                m += 1;
                if (m > 11) { m = 0; y += 1; }
                const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
                const dom = Math.min(ld, lastDay);
                const d = new Date(Date.UTC(y, m, dom));
                const ms = d.getTime();
                if (ms > endMs) break;
                if (ms >= startMs) {
                    const date = d.toISOString().slice(0, 10);
                    const sig = `${r.category}|${r.eventType}|${r.direction}|${date}`;
                    if (!realDates.has(sig)) {
                        out.push({
                            event_id: `${r.key}_proj_${i}`,
                            category: r.category,
                            event_type: r.eventType,
                            direction: r.direction,
                            currency: r.currency,
                            amount: r.amount,
                            event_date: date,
                            settlement_date: date,
                            status: '__projected__',
                            flexibility: 'fixed',
                        });
                    }
                }
                i++;
            }
        } else {
            // ---- Non-monthly: step by cadenceDays from lastDate ----
            let nextMs = Date.parse(r.lastDate + 'T00:00:00Z') + r.cadenceDays * DAY_MS;
            let i = 0;
            while (nextMs <= endMs && i < 60) {
                const date = new Date(nextMs).toISOString().slice(0, 10);
                const sig = `${r.category}|${r.eventType}|${r.direction}|${date}`;
                if (!realDates.has(sig)) {
                    out.push({
                        event_id: `${r.key}_proj_${i}`,
                        category: r.category,
                        event_type: r.eventType,
                        direction: r.direction,
                        currency: r.currency,
                        amount: r.amount,
                        event_date: date,
                        settlement_date: date,
                        status: '__projected__',
                        flexibility: 'fixed',
                    });
                }
                nextMs += r.cadenceDays * DAY_MS;
                i++;
            }
        }
    }

    // Sort by date so downstream consumers get chronological order.
    out.sort((a, b) =>
        a.settlement_date < b.settlement_date ? -1
            : a.settlement_date > b.settlement_date ? 1
                : 0
    );

    return out;
}