function pairKey(a, b) { return `${a.toUpperCase()}|${b.toUpperCase()}`; }
function exactKey(date, a, b) { return `${date}|${pairKey(a, b)}`; }

export function buildFxIndex(rows) {
    const exact = new Map();
    const series = new Map();
    for (const r of rows || []) {
        const from = String(r.from_currency || '').toUpperCase();
        const to = String(r.to_currency || '').toUpperCase();
        const date = String(r.rate_date || r.date || '');
        const rate = Number(r.rate);
        if (!from || !to || !date || !Number.isFinite(rate) || rate <= 0) continue;
        exact.set(exactKey(date, from, to), rate);
        const k = pairKey(from, to);
        if (!series.has(k)) series.set(k, []);
        series.get(k).push({ date, rate });
    }
    for (const arr of series.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
    return { exact, series };
}

function onOrBefore(series, from, to, date) {
    const rows = series.get(pairKey(from, to));
    if (!rows || !rows.length) return null;
    let found = null;
    for (const r of rows) { if (r.date <= date) found = r.rate; else break; }
    return found;
}

export function getFxRate(idx, from, to, date) {
    const f = String(from || '').toUpperCase();
    const t = String(to || '').toUpperCase();
    const d = String(date || '');
    if (!f || !t || !d) return null;
    if (f === t) return 1;

    // 1. exact direct
    let r = idx.exact.get(exactKey(d, f, t));
    if (r != null) return r;
    // 2. exact inverse
    r = idx.exact.get(exactKey(d, t, f));
    if (r != null) return 1 / r;
    // 3. direct on-or-before
    r = onOrBefore(idx.series, f, t, d);
    if (r != null) return r;
    // 4. inverse on-or-before
    r = onOrBefore(idx.series, t, f, d);
    if (r != null) return 1 / r;
    return null;
}

export function convert(amount, from, to, date, idx) {
    const v = Number(amount);
    if (!Number.isFinite(v)) return 0;
    const rate = getFxRate(idx, from, to, date);
    if (rate == null) {
        // Spec: do not invent a rate. Throw so the caller can flag the row.
        throw new Error(`FX missing: ${from}->${to} on ${date}`);
    }
    return v * rate;
}

export function roundMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}