// Template-based explanations. Matches sample style:
//   affordable_now:      "Pay CURR X today. This leaves at least CURR M available over the next 90 days."
//   affordable_with_plan: "Use N installments of CURR X, starting DATE. This leaves at least CURR M available."
//                         "Pay CURR X today and the remaining CURR Y on DATE. This completes the full request and keeps the CURR M minimum protected."
//   affordable_later:    "Pay CURR X in full on DATE. Paying earlier would take the balance below the CURR M minimum."
//   not_affordable:      "Do not make this payment by DATE. None of the available options keeps the CURR M minimum protected."
//                         "Do not proceed with the CURR X request. Although CURR A is available today, the full amount cannot be completed safely within 90 days."
export function explain(plan, request, profile, minBalance) {
    const cur = String(profile.home_currency);
    const m = fmt(minBalance);

    if (plan.strategy === 'not_recommended') {
        // Two flavors based on whether some amount was safe today.
        const safeToday = Number(plan._amountSafeToPay || 0);
        if (safeToday > 0) {
            return `Do not proceed with the ${cur} ${fmt(request.requested_amount)} request. ` +
                `Although ${cur} ${fmt(safeToday)} is available today, the full amount cannot be completed safely within 90 days.`;
        }
        return `Do not make this payment by ${fmtDate(request.desired_completion_date)}. ` +
            `None of the available options keeps the ${cur} ${m} minimum protected.`;
    }

    if (plan.strategy === 'wait') {
        return `Pay ${cur} ${fmt(request.requested_amount)} in full on ${fmtDate(plan.startDate)}. ` +
            `Paying earlier would take the balance below the ${cur} ${m} minimum.`;
    }

    if (plan.strategy === 'installments') {
        const first = plan.paymentEvents[0];
        return `Use ${plan.numPayments} installments of ${cur} ${fmt(first.amount)}, ` +
            `starting ${fmtDate(first.eventDate)}. This leaves at least ${cur} ${m} available.`;
    }

    if (plan.strategy === 'partial_payment') {
        const [p1, p2] = plan.paymentEvents;
        return `Pay ${cur} ${fmt(p1.amount)} today and the remaining ${cur} ${fmt(p2.amount)} on ${fmtDate(p2.eventDate)}. ` +
            `This completes the full request and keeps the ${cur} ${m} minimum protected.`;
    }

    // full_payment (with or without spending changes)
    const todayStr = plan.paymentEvents[0]?.eventDate || request.request_date;
    if (plan.spendingChanges && plan.spendingChanges !== 'none') {
        const desc = describeSpendingChanges(plan.spendingChanges);
        return `${desc}, then pay ${cur} ${fmt(request.requested_amount)} today. This leaves at least ${cur} ${m} available.`;
    }
    return `Pay ${cur} ${fmt(request.requested_amount)} today. This leaves at least ${cur} ${m} available over the next 90 days.`;
}

function describeSpendingChanges(s) {
    const parts = String(s).split('|').map(p => {
        if (p.startsWith('stop:')) return 'stop an online subscription';
        if (p.startsWith('reduce_to:')) return 'reduce a flexible subscription';
        return 'adjust a flexible expense';
    });
    // Match sample wording loosely; samples use "Stop the X and reduce the Y".
    if (parts.length === 1) return parts[0][0].toUpperCase() + parts[0].slice(1);
    return parts.join(' and ');
}

function fmt(n) {
    const v = Math.round(Number(n) * 100) / 100;
    if (Number.isInteger(v)) return String(v);
    // Drop trailing zero on .X0
    const s = v.toFixed(2);
    return s.endsWith('0') ? s.slice(0, -1) : s;
}
function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${d} ${months[m - 1]} ${y}`;
}