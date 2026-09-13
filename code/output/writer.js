// code/output/writer.js
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { formatSpendingChanges } from '../engine/spending.js';
import { round2 } from '../engine/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const HEADER = [
    'request_id',
    'amount_safe_to_pay',
    'affordability_status',
    'recommended_payment_method',
    'payment_plan',
    'earliest_date_for_full_payment',
    'spending_changes_needed',
    'decision_explanation',
];

/**
 * Write output.csv at repo root (and mirror to code/output/output.csv).
 *
 * @param {Array<{requestId, candidate, explanation}>} rows
 * @returns {string} absolute path written
 */
export function writeOutput(rows) {
    const records = rows.map(r => toRecord(r));

    const csv = stringify(records, {
        header: true,
        columns: HEADER,
        quoted: true,        // always quote — explanations contain commas
        quoted_empty: true,
        record_delimiter: '\n',
    });

    const rootPath = resolve(REPO_ROOT, 'output.csv');
    writeFileSync(rootPath, csv, 'utf8');

    // Mirror next to the code, in case the harness reads there.
    const mirrorDir = resolve(REPO_ROOT, 'code', 'output');
    if (!existsSync(mirrorDir)) mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(resolve(mirrorDir, 'output.csv'), csv, 'utf8');

    return rootPath;
}

function toRecord({ requestId, candidate, explanation }) {
    return {
        request_id: requestId,
        amount_safe_to_pay: fmtMoneyCell(candidate.amountSafeToPay),
        affordability_status: candidate.status,
        recommended_payment_method: candidate.method,
        payment_plan: fmtPlan(candidate.schedule),
        earliest_date_for_full_payment: candidate.earliestFullPayment || '',
        spending_changes_needed: formatSpendingChanges(candidate.spendingChanges),
        decision_explanation: explanation,
    };
}

/**
 * payment_plan format: "YYYY-MM-DD:amount|YYYY-MM-DD:amount", or "none".
 * Amounts: 2dp, no thousands separators.
 *   → "2025-08-08:15952906.67|2025-09-07:15952906.67|2025-10-07:15952906.67"
 *   → "2024-03-03:25256"
 */
function fmtPlan(schedule) {
    if (!schedule || schedule.length === 0) return 'none';
    return schedule
        .map(p => `${p.date}:${fmtNumCell(p.amount)}`)
        .join('|');
}

/**
 * Money cell in output.csv: up to 2dp, no separators, no trailing ".00"
 * for whole numbers. Matches samples:
 *   25256 → "25256"
 *   15952906.67 → "15952906.67"
 *   87170.56 → "87170.56"
 */
function fmtNumCell(x) {
    const n = round2(Number(x));
    if (Number.isInteger(n)) return String(n);
    // Trim trailing zeros but keep at least 2dp when fractional.
    return n.toFixed(2);
}

function fmtMoneyCell(x) {
    const n = round2(Number(x));
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}