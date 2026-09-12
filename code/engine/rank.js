// Spec ranking (6 levels):
// 1. Complete the full request by desired_completion_date
// 2. Require no spending changes
// 3. Minimize total amount paid
// 4. Start payment earlier
// 5. Use fewer payments
// 6. Use the lowest payment_option_id
export function rankPlans(plans, request) {
    const deadline = String(request.desired_completion_date);
    const safe = plans.filter(p => p.isSafe && p.strategy !== 'not_recommended');
    if (!safe.length) {
        return plans.find(p => p.strategy === 'not_recommended');
    }

    const completesBy = (p) => {
        if (!p.startDate && p.strategy !== 'not_recommended') return true;
        if (p.strategy === 'not_recommended') return false;
        const last = p.paymentEvents.length
            ? p.paymentEvents[p.paymentEvents.length - 1].eventDate
            : p.startDate;
        return last <= deadline;
    };

    safe.sort((a, b) => {
        // 1. completes by deadline
        const ca = completesBy(a) ? 0 : 1;
        const cb = completesBy(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;

        // 2. no spending changes
        const sa = a.spendingChanges === 'none' ? 0 : 1;
        const sb = b.spendingChanges === 'none' ? 0 : 1;
        if (sa !== sb) return sa - sb;

        // 3. minimize total cost
        if (Math.abs(a.totalCost - b.totalCost) > 0.01) return a.totalCost - b.totalCost;

        // 4. start earlier
        const da = a.startDate || '9999-99-99';
        const db = b.startDate || '9999-99-99';
        if (da !== db) return da.localeCompare(db);

        // 5. fewer payments
        if (a.numPayments !== b.numPayments) return a.numPayments - b.numPayments;

        // 6. lowest payment_option_id
        const ia = a.paymentOptionId || '';
        const ib = b.paymentOptionId || '';
        return ia.localeCompare(ib);
    });

    return safe[0];
}