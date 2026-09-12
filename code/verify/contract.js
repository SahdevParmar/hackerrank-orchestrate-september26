// Validates each output row against the REAL contract.
import { COLUMNS } from '../output/writer.js';

const STATUSES = new Set(['affordable_now', 'affordable_with_plan', 'affordable_later', 'not_affordable']);
const METHODS = new Set(['full_payment', 'partial_payment', 'installments', 'wait', 'not_recommended']);

export function verifyRow(row, request) {
    const errs = [];
    if (row.request_id !== request.request_id) errs.push('request_id mismatch');

    const safe = Number(row.amount_safe_to_pay);
    const requested = Number(request.requested_amount);
    if (!(safe >= 0 && safe <= requested)) errs.push(`amount_safe_to_pay ${safe} out of [0, ${requested}]`);

    if (!STATUSES.has(row.affordability_status)) errs.push(`bad status ${row.affordability_status}`);
    if (!METHODS.has(row.recommended_payment_method)) errs.push(`bad method ${row.recommended_payment_method}`);

    if (row.affordability_status === 'affordable_now' && row.earliest_date_for_full_payment !== request.request_date) {
        errs.push('affordable_now must have earliest == request_date');
    }
    if (row.recommended_payment_method === 'partial_payment') {
        const parts = String(row.payment_plan).split('|');
        if (parts.length !== 2) errs.push('partial must have exactly 2 payments');
        const sum = parts.reduce((s, p) => s + Number(p.split(':')[1]), 0);
        if (Math.abs(sum - requested) > 0.01) errs.push(`partial sum ${sum} != requested ${requested}`);
    }
    if (row.recommended_payment_method === 'not_recommended') {
        if (String(row.payment_plan) !== 'none') errs.push('not_recommended must have plan=none');
    }
    return errs;
}

export function verifyAll(rows, requests) {
    const byId = new Map(requests.map(r => [String(r.request_id), r]));
    const problems = [];
    for (const row of rows) {
        const req = byId.get(String(row.request_id));
        if (!req) { problems.push([row.request_id, ['unknown request']]); continue; }
        const errs = verifyRow(row, req);
        if (errs.length) problems.push([row.request_id, errs]);
    }
    return problems;
}
export { COLUMNS };