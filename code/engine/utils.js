// code/engine/utils.js
export function overridesFrom(changes) {
    const m = new Map();
    for (const c of changes) {
        if (c.type === 'stop') m.set(c.eventId, { skip: true });
        else m.set(c.eventId, { newAmount: c.newAmount });
    }
    return m;
}
export function round2(x) { return Math.round(x * 100) / 100; }
export function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
export function toISO(dt) { return dt.toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = parseISO(iso); return toISO(new Date(d.getTime() + n * 86400000)); }
export function fmtCell(x) {
    const n = round2(Number(x));
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}