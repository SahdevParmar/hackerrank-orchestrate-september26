// code/verify/contract.js
import { parseISO } from '../engine/utils.js';

const ALLOWED_STATUS = new Set([
    'affordable_now',
    'affordable_with_plan',
    'affordable_later',
    'not_affordable',
]);

const ALLOWED_METHOD = new Set([
    'full_payment',
    'partial_payment',
    'installments',
    'wait',
    'not_recommended',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_RE = /^\d{4}-\d{2}-\d{2}:\d+(\.\d{1,2})?$/;
const CHANGE_RE = /^(stop:event_\d+|reduce_to:event_\d+:\d+(\.\d{1,2})?)$/;

/**
 * Validate one output row against the 8-column contract.
 *
 * @param {object} row       — the output record (same keys as HEADER)
 * @param {object} request   — the source request row
 * @param {object} ctx       — engine context (for payment options)
 * @returns {string[]}       — array of error strings; empty = valid
 */
export function validateRow(row, request, ctx) {
    const errors = [];
    const reqId = request.request_id;

    // ---- request_id -------------------------------------------------------
    if (row.request_id !== reqId) {
        errors.push(`${reqId}: request_id mismatch (${row.request_id})`);
    }

    // ---- amount_safe_to_pay ----------------------------------------------
    const safe = Number(row.amount_safe_to_pay);
    const requested = Number(request.requested_amount);
    if (!Number.isFinite(safe)) {
        errors.push(`${reqId}: amount_safe_to_pay not numeric (${row.amount_safe_to_pay})`);
    } else {
        if (safe < 0) errors.push(`${reqId}: amount_safe_to_pay < 0`);
        if (safe > requested + 0.01) {
            errors.push(`${reqId}: amount_safe_to_pay ${safe} > requested ${requested}`);
        }
        // 2dp check
        if (Math.abs(safe * 100 - Math.round(safe * 100)) > 1e-6) {
            errors.push(`${reqId}: amount_safe_to_pay has >2dp (${safe})`);
        }
    }

    // ---- affordability_status --------------------------------------------
    if (!ALLOWED_STATUS.has(row.affordability_status)) {
        errors.push(`${reqId}: bad affordability_status (${row.affordability_status})`);
    }

    // ---- recommended_payment_method --------------------------------------
    if (!ALLOWED_METHOD.has(row.recommended_payment_method)) {
        errors.push(`${reqId}: bad recommended_payment_method (${row.recommended_payment_method})`);
    }

    // ---- payment_plan -----------------------------------------------------
    const plan = row.payment_plan;
    const planParts = plan === 'none' ? [] : String(plan).split('|');
    if (plan !== 'none') {
        if (planParts.length === 0) {
            errors.push(`${reqId}: payment_plan empty but not "none"`);
        }
        for (const part of planParts) {
            if (!PLAN_RE.test(part)) {
                errors.push(`${reqId}: malformed plan entry "${part}"`);
            }
        }
        // Chronological order
        const dates = planParts.map(p => p.split(':')[0]);
        for (let i = 1; i < dates.length; i++) {
            if (dates[i] < dates[i - 1]) {
                errors.push(`${reqId}: payment_plan not chronological`);
                break;
            }
        }
    }

    // ---- earliest_date_for_full_payment ----------------------------------
    const earliest = row.earliest_date_for_full_payment;
    if (earliest !== '' && !DATE_RE.test(earliest)) {
        errors.push(`${reqId}: bad earliest_date (${earliest})`);
    }

    // ---- spending_changes_needed -----------------------------------------
    const changes = row.spending_changes_needed;
    if (changes !== 'none') {
        const parts = String(changes).split('|');
        if (parts.length > 3) {
            errors.push(`${reqId}: >3 spending changes`);
        }
        for (const p of parts) {
            if (!CHANGE_RE.test(p)) {
                errors.push(`${reqId}: malformed spending change "${p}"`);
            }
        }
        // No duplicate event ids
        const ids = parts.map(p => p.split(':')[1]);
        if (new Set(ids).size !== ids.length) {
            errors.push(`${reqId}: duplicate event in spending changes`);
        }
    }

    // ---- decision_explanation --------------------------------------------
    if (!row.decision_explanation || String(row.decision_explanation).trim() === '') {
        errors.push(`${reqId}: empty decision_explanation`);
    }

    // ---- cross-field rules -----------------------------------------------
    errors.push(...crossField(reqId, row, request, ctx));

    return errors;
}

function crossField(reqId, row, request, ctx) {
    const errors = [];
    const status = row.affordability_status;
    const method = row.recommended_payment_method;
    const plan = row.payment_plan;
    const earliest = row.earliest_date_for_full_payment;
    const safe = Number(row.amount_safe_to_pay);
    const requested = Number(request.requested_amount);
    const reqDate = request.request_date;
    const desired = request.desired_completion_date;
    const allowsPartial = String(request.allows_partial_payment).toLowerCase() === 'true';

    const planEntries = plan === 'none' ? [] : plan.split('|');
    const planDates = planEntries.map(p => p.split(':')[0]);
    const planAmounts = planEntries.map(p => Number(p.split(':')[1]));

    // affordable_now ⇒ earliest == request_date
    if (status === 'affordable_now' && earliest !== reqDate) {
        errors.push(`${reqId}: affordable_now but earliest ${earliest} != request_date ${reqDate}`);
    }

    // affordable_now ⇒ method full_payment
    if (status === 'affordable_now' && method !== 'full_payment') {
        errors.push(`${reqId}: affordable_now but method ${method}`);
    }

    // affordable_now ⇒ single payment on request_date
    if (status === 'affordable_now') {
        if (planEntries.length !== 1) {
            errors.push(`${reqId}: affordable_now but plan has ${planEntries.length} payments`);
        } else if (planDates[0] !== reqDate) {
            errors.push(`${reqId}: affordable_now but first payment ${planDates[0]} != ${reqDate}`);
        }
    }

    // affordable_later ⇒ method wait
    if (status === 'affordable_later' && method !== 'wait') {
        errors.push(`${reqId}: affordable_later but method ${method}`);
    }

    // affordable_later ⇒ earliest == last plan date
    if (status === 'affordable_later' && planEntries.length > 0) {
        const last = planDates[planDates.length - 1];
        if (earliest !== last) {
            errors.push(`${reqId}: affordable_later earliest ${earliest} != last plan date ${last}`);
        }
    }

    // not_affordable ⇒ method not_recommended, plan none, earliest empty
    if (status === 'not_affordable') {
        if (method !== 'not_recommended') {
            errors.push(`${reqId}: not_affordable but method ${method}`);
        }
        if (plan !== 'none') {
            errors.push(`${reqId}: not_affordable but plan ${plan}`);
        }
        if (earliest !== '') {
            errors.push(`${reqId}: not_affordable but earliest ${earliest}`);
        }
    }

    // not_affordable ⇒ safe <= requested (already checked) and safe >= 0
    // (already checked)

    // partial_payment rules
    if (method === 'partial_payment') {
        if (!allowsPartial) {
            errors.push(`${reqId}: partial_payment but request disallows partial`);
        }
        if (planEntries.length !== 2) {
            errors.push(`${reqId}: partial_payment but ${planEntries.length} payments`);
        } else {
            if (planDates[0] !== reqDate) {
                errors.push(`${reqId}: partial first payment ${planDates[0]} != request_date`);
            }
            if (!(safe > 0 && safe < requested)) {
                errors.push(`${reqId}: partial safe ${safe} not in (0, requested)`);
            }
            const secondDate = planDates[1];
            if (secondDate > desired) {
                errors.push(`${reqId}: partial second payment ${secondDate} > desired ${desired}`);
            }
            const total = planAmounts.reduce((a, b) => a + b, 0);
            if (Math.abs(total - requested) > 0.01) {
                errors.push(`${reqId}: partial total ${total} != requested ${requested}`);
            }
        }
    }

    // installments ⇒ plan matches a supplied option exactly
    if (method === 'installments') {
        const opts = (ctx.optionsByRequest.get(reqId) || [])
            .filter(o => o.payment_method === 'installments');
        const match = opts.find(o => optionMatchesPlan(o, planEntries));
        if (!match) {
            errors.push(`${reqId}: installments plan does not match any supplied option`);
        }
    }

    // full_payment ⇒ plan pays full requested
    if (method === 'full_payment' && planEntries.length > 0) {
        const total = planAmounts.reduce((a, b) => a + b, 0);
        if (total < requested - 0.01) {
            errors.push(`${reqId}: full_payment but plan total ${total} < requested ${requested}`);
        }
    }

    // earliest_date_for_full_payment must be >= request_date if present
    if (earliest && earliest < reqDate) {
        errors.push(`${reqId}: earliest ${earliest} < request_date ${reqDate}`);
    }

    return errors;
}

/**
 * Does a supplied installment option produce exactly this plan schedule?
 * We compare payment count and per-payment amount (not dates — dates are
 * derived from first_payment_date + frequency, which we already validated
 * in plans.js). To be strict, compare dates too.
 */
function optionMatchesPlan(opt, planEntries) {
    const n = Number(opt.number_of_payments);
    if (n !== planEntries.length) return false;
    const amt = Number(opt.payment_amount).toFixed(2);
    for (const p of planEntries) {
        const [date, val] = p.split(':');
        if (Number(val).toFixed(2) !== amt) return false;
    }
    return true;
}

/**
 * Validate the whole output array.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAll(rows, requestsById, ctx) {
    const errors = [];
    const seen = new Set();
    for (const r of rows) {
        if (seen.has(r.request_id)) {
            errors.push(`${r.request_id}: duplicate request_id in output`);
        }
        seen.add(r.request_id);
        const req = requestsById.get(r.request_id);
        if (!req) {
            errors.push(`${r.request_id}: no matching request`);
            continue;
        }
        errors.push(...validateRow(r, req, ctx));
    }
    return { ok: errors.length === 0, errors };
}