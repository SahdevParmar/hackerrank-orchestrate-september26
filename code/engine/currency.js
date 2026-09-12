/**
 * Fixed dated FX converter engine with indexed lookups and settlement date support.
 */

function pairKey(fromCurrency, toCurrency) {
    return `${fromCurrency.toUpperCase()}|${toCurrency.toUpperCase()}`;
}

function exactKey(rateDate, fromCurrency, toCurrency) {
    return `${rateDate}|${pairKey(fromCurrency, toCurrency)}`;
}

/**
 * Pre-indexes exchange rates for O(1) instant lookup time.
 */
export function buildFxIndex(exchangeRates) {
    const exact = new Map();
    const series = new Map();

    for (const row of exchangeRates || []) {
        const from = String(row.from_currency || '').toUpperCase();
        const to = String(row.to_currency || '').toUpperCase();
        // Handles both 'date' and 'rate_date' header variations
        const date = String(row.date || row.rate_date || '');
        const rate = Number(row.rate);

        if (!from || !to || !date || !Number.isFinite(rate) || rate <= 0) continue;

        exact.set(exactKey(date, from, to), rate);

        const key = pairKey(from, to);
        if (!series.has(key)) series.set(key, []);
        series.get(key).push({ date, rate });
    }

    for (const rows of series.values()) {
        rows.sort((a, b) => a.date.localeCompare(b.date));
    }

    return { exact, series };
}

function rateOnOrBefore(series, fromCurrency, toCurrency, rateDate) {
    const rows = series.get(pairKey(fromCurrency, toCurrency));
    if (!rows || rows.length === 0) return null;

    let found = null;
    for (const row of rows) {
        if (row.date <= rateDate) found = row.rate;
        else break;
    }
    return found;
}

/**
 * Resolves conversion rate using direct, inverse, or historical fallback lookup.
 */
export function getFxRate(fxIndex, fromCurrency, toCurrency, rateDate) {
    const from = String(fromCurrency || '').toUpperCase();
    const to = String(toCurrency || '').toUpperCase();
    const date = String(rateDate || '');

    if (!from || !to || !date) return null;
    if (from === to) return 1;

    // 1. Exact direct rate
    const exact = fxIndex.exact.get(exactKey(date, from, to));
    if (exact != null) return exact;

    // 2. Exact inverse rate
    const inverse = fxIndex.exact.get(exactKey(date, to, from));
    if (inverse != null) return 1 / inverse;

    // 3. Historical rate on or before date
    const prior = rateOnOrBefore(fxIndex.series, from, to, date);
    if (prior != null) return prior;

    // 4. Historical inverse rate on or before date
    const priorInverse = rateOnOrBefore(fxIndex.series, to, from, date);
    if (priorInverse != null) return 1 / priorInverse;

    console.warn(`[FX Warning] Missing exchange rate for ${from} -> ${to} on ${date}`);
    return null;
}

/**
 * Converts monetary amount to target currency.
 */
export function convertAmount(amount, fromCurrency, toCurrency, rateDate, fxIndex) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return 0;

    const rate = getFxRate(fxIndex, fromCurrency, toCurrency, rateDate);
    if (rate == null) return value; // Fallback to raw value if unresolvable
    return value * rate;
}

/**
 * Converts financial event to user's home currency prioritizing settlement_date.
 */
export function convertEventToHome(event, homeCurrency, fxIndex) {
    if (!event) return 0;
    const rateDate = event.settlement_date || event.event_date;
    return convertAmount(event.amount, event.currency, homeCurrency, rateDate, fxIndex);
}

/**
 * Rounds monetary amounts to 2 decimal places.
 */
export function roundMoney(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 100) / 100;
}