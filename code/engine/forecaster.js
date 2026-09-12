// 90-day daily balance projection.
// Safety rule (spec): balance must never drop below minimum_balance_to_keep
// after any projected essential expense or payment.
import { convert } from './currency.js';

const MS_PER_DAY = 86400000;

function d(str) { return new Date(`${str}T00:00:00Z`); }
function iso(dt) { return dt.toISOString().slice(0, 10); }

/**
 * @param {object} profile  financial_profiles row
 * @param {Array}  events   classified + projected events for this user (home currency amounts)
 * @param {string} startDate YYYY-MM-DD (request_date)
 * @param {number} days
 * @param {object} fx       fx index
 * @returns {object} { timeline, lowestBalance, lowestDate, breaches, minBalance }
 */
export function forecast(profile, events, startDate, days = 90, fx) {
    const homeCurrency = String(profile.home_currency);
    const startBal = Number(profile.current_available_balance);
    const minBal = Number(profile.minimum_balance_to_keep);

    // Convert every event to home currency on its settlement date.
    const byDate = new Map();
    for (const e of events) {
        if (e.amount == null || !Number.isFinite(e.amount)) continue;
        if (!e.eventDate) continue;
        let amt;
        try {
            amt = convert(e.amount, e.currency || homeCurrency, homeCurrency, e.settlementDate || e.eventDate, fx);
        } catch {
            // Missing rate → skip and flag (do not invent).
            continue;
        }
        const key = e.eventDate;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push({ ...e, amountHome: amt });
    }

    const timeline = [];
    let bal = startBal;
    let lowest = startBal;
    let lowestDate = startDate;
    let breaches = 0;

    const start = d(startDate);
    for (let i = 0; i < days; i++) {
        const cur = new Date(start.getTime() + i * MS_PER_DAY);
        const dateStr = iso(cur);
        const todays = byDate.get(dateStr) || [];
        let income = 0, expense = 0;
        for (const e of todays) {
            if (e.kind === 'credit') income += e.amountHome;
            else if (e.kind === 'debit') expense += e.amountHome;
        }
        bal = bal + income - expense;
        if (bal < lowest) { lowest = bal; lowestDate = dateStr; }
        if (bal < minBal) breaches++;
        timeline.push({ date: dateStr, balance: bal, income, expense });
    }

    return {
        timeline,
        lowestBalance: lowest,
        lowestDate,
        breaches,
        minBalance: minBal,
        startBalance: startBal,
    };
}

export { d as parseDate, iso as toIso };