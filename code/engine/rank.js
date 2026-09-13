// code/engine/rank.js
import { buildPlans } from './plans.js';
import { generateSpendingChangeSets } from './spending.js';
import { overridesFrom, round2 } from './utils.js';

/**
 * Pick the winning candidate for a request per the spec's 6-level ranking.
 */
export function pickBest(ctx, request) {
    const { profile } = ctx;
    const requested = Number(request.requested_amount);

    const rawPlans = buildPlans(ctx, request);
    const candidates = [];

    for (const plan of rawPlans) {
        if (plan.method === 'not_recommended') {
            candidates.push(makeCandidate(plan, null, request, ctx));
            continue;
        }

        const feasibleAsIs = isFeasible(ctx, request, plan.schedule, null);
        if (feasibleAsIs) {
            candidates.push(makeCandidate(plan, null, request, ctx));
            continue;
        }

        // Plan not feasible as-is. Try spending changes to rescue it.
        const changeSets = generateSpendingChangeSets(ctx, request, plan.schedule);
        const feasibleSets = changeSets.filter(s => s.feasible);
        if (feasibleSets.length === 0) continue;

        feasibleSets.sort((a, b) =>
            a.changes.length - b.changes.length || b.savings - a.savings
        );
        candidates.push(makeCandidate(plan, feasibleSets[0], request, ctx));
    }

    // Full-payment-today rescue: pay the full amount today, cover the gap
    // with spending changes.
    const fullRescue = tryFullPaymentRescue(ctx, request);
    if (fullRescue) candidates.push(fullRescue);

    candidates.sort(compareCandidates);

    const winner = candidates[0];
    if (!winner) {
        return {
            status: 'not_affordable',
            method: 'not_recommended',
            amountSafeToPay: 0,
            schedule: [],
            spendingChanges: [],
            earliestFullPayment: '',
            explanationKey: 'none_options',
        };
    }
    return winner;
}

function tryFullPaymentRescue(ctx, request) {
    const requested = Number(request.requested_amount);
    const reqDate = request.request_date;

    const schedule = [{ date: reqDate, amount: requested }];
    const changeSets = generateSpendingChangeSets(ctx, request, schedule);
    const feasibleSets = changeSets.filter(s => s.feasible);
    if (feasibleSets.length === 0) return null;

    feasibleSets.sort((a, b) =>
        a.changes.length - b.changes.length || b.savings - a.savings
    );
    const chosen = feasibleSets[0];

    const overrides = overridesFrom(chosen.changes);
    const safeToday = ctx.engine.safeAmountToday(ctx, request, requested, overrides);

    return makeCandidate(
        {
            method: 'full_payment',
            schedule,
            spendingChanges: chosen.changes,
            safeToday,
            completesBy: reqDate,
            optionId: null,
        },
        chosen,
        request,
        ctx
    );
}

function makeCandidate(plan, spendingSet, request, ctx) {
    const requested = Number(request.requested_amount);

    const changes = spendingSet ? spendingSet.changes : (plan.spendingChanges || []);
    const schedule = plan.schedule || [];

    let cost = schedule.reduce((s, p) => s + Number(p.amount), 0);
    if (plan.method === 'installments' && plan.optionId) {
        const opt = (ctx.optionsByRequest.get(request.request_id) || [])
            .find(o => o.payment_option_id === plan.optionId);
        if (opt && opt.financing_fee) cost += Number(opt.financing_fee);
    }

    const paidFull = cost >= requested - 0.01;
    const earliestFullPayment = paidFull && schedule.length > 0
        ? schedule[schedule.length - 1].date
        : '';

    let status, method;
    if (plan.method === 'not_recommended') {
        status = 'not_affordable'; method = 'not_recommended';
    } else if (plan.method === 'wait') {
        status = 'affordable_later'; method = 'wait';
    } else if (plan.method === 'installments') {
        status = 'affordable_with_plan'; method = 'installments';
    } else if (plan.method === 'partial_payment') {
        status = 'affordable_with_plan'; method = 'partial_payment';
    } else if (plan.method === 'full_payment') {
        if (changes.length > 0) {
            status = 'affordable_with_plan'; method = 'full_payment';
        } else if (schedule.length === 1 && schedule[0].date === request.request_date) {
            status = 'affordable_now'; method = 'full_payment';
        } else {
            status = 'affordable_with_plan'; method = 'full_payment';
        }
    } else {
        status = 'not_affordable'; method = 'not_recommended';
    }

    let explanationKey = null;
    if (status === 'not_affordable') {
        const allowsPartial = String(request.allows_partial_payment).toLowerCase() === 'true';
        explanationKey = allowsPartial ? 'available_today_but_incomplete' : 'none_options';
    }

    return {
        status,
        method,
        amountSafeToPay: round2(Math.min(plan.safeToday ?? 0, requested)),
        schedule,
        spendingChanges: changes,
        earliestFullPayment,
        cost: round2(cost),
        completesByDesired: plan.completesBy
            ? plan.completesBy <= request.desired_completion_date
            : false,
        paymentOptionId: plan.optionId || null,
        explanationKey,
        _plan: plan,
    };
}

/**
 * Spec's 6-level ranking:
 *   1. completes by desired_completion_date     (true > false)
 *   2. no spending changes                      (true > false)
 *   3. minimize total cost                      (lower > higher)
 *   4. earlier start                            (earlier > later)
 *   5. fewer payments                           (fewer > more)
 *   6. lowest payment_option_id                 (lex asc; null sorts last)
 */
function compareCandidates(a, b) {
    if (a.completesByDesired !== b.completesByDesired) {
        return a.completesByDesired ? -1 : 1;
    }
    const aNo = a.spendingChanges.length === 0;
    const bNo = b.spendingChanges.length === 0;
    if (aNo !== bNo) return aNo ? -1 : 1;
    if (Math.abs(a.cost - b.cost) > 1e-9) return a.cost - b.cost;
    const aStart = a.schedule.length ? a.schedule[0].date : '9999-99-99';
    const bStart = b.schedule.length ? b.schedule[0].date : '9999-99-99';
    if (aStart !== bStart) return aStart < bStart ? -1 : 1;
    if (a.schedule.length !== b.schedule.length) {
        return a.schedule.length - b.schedule.length;
    }
    const aId = a.paymentOptionId || '~';
    const bId = b.paymentOptionId || '~';
    return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function isFeasible(ctx, request, schedule, overrides) {
    const { profile, engine } = ctx;
    const home = profile.home_currency;
    const f = engine.forecast(ctx, {
        request,
        extraDebits: schedule.map(p => ({ date: p.date, amount: p.amount, currency: home })),
        overrides,
    });
    return f.lowestBalance >= Number(profile.minimum_balance_to_keep) - 1e-9;
}