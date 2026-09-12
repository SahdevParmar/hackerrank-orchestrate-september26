const VALID_STRATEGIES = [
    'FULL_PURCHASE',
    'PARTIAL_PURCHASE',
    'INSTALLMENT_PLAN',
    'WAIT_AND_SAVE',
    'DO_NOT_BUY',
];

const CENTS_TOLERANCE = 0.01;

/**
 * Validates that a string is a real calendar date in YYYY-MM-DD form.
 * Unlike a bare `new Date(...)` check, this rejects out-of-range values
 * like "2026-02-30" that JS's Date constructor silently rolls forward
 * (e.g. to 2026-03-02) instead of treating as invalid.
 */
function isValidISODate(dateStr) {
    if (!dateStr) return false;
    const trimmed = String(dateStr).trim();
    const isoRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
    const match = isoRegex.exec(trimmed);
    if (!match) return false;

    const [, yStr, mStr, dStr] = match;
    const year = Number(yStr);
    const month = Number(mStr);
    const day = Number(dStr);

    const d = new Date(Date.UTC(year, month - 1, day));
    if (isNaN(d.getTime())) return false;

    // Round-trip check: if the components didn't survive (e.g. Feb 30 became
    // Mar 2), the input wasn't actually a valid calendar date.
    return (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() === month - 1 &&
        d.getUTCDate() === day
    );
}

/**
 * A stricter numeric check than isNaN: also rejects Infinity/-Infinity,
 * which `isNaN(x) || x < 0` alone lets through for +Infinity.
 */
function isFiniteNonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0;
}

export function verifyPurchaseRecommendation(output = {}) {
    const errors = [];
    const warnings = [];

    if (!output || typeof output !== 'object') {
        return { isValid: false, errors: ['Output must be a valid non-null object.'], warnings };
    }

    // 1. Recommended Strategy Enum Check
    if (!VALID_STRATEGIES.includes(output.recommendedStrategy)) {
        errors.push(
            `Invalid recommendedStrategy: "${output.recommendedStrategy}". Must be one of [${VALID_STRATEGIES.join(', ')}].`
        );
    }

    // 2. Item Cost & Numerical Bounds Check
    const itemCost = Number(output.itemCost);
    if (!isFiniteNonNegative(itemCost)) {
        errors.push(`Invalid itemCost: "${output.itemCost}". Must be a finite, non-negative number.`);
    }

    // 3. Plans Array Validation
    if (!Array.isArray(output.plans) || output.plans.length === 0) {
        errors.push('Output must contain a non-empty "plans" array.');
    } else {
        if (typeof output.evaluatedPlansCount === 'number' && output.evaluatedPlansCount !== output.plans.length) {
            errors.push(
                `evaluatedPlansCount (${output.evaluatedPlansCount}) does not match plans.length (${output.plans.length}).`
            );
        }

        const seenRanks = new Set();
        const seenStrategies = new Set();

        output.plans.forEach((plan, index) => {
            if (!plan || typeof plan !== 'object') {
                errors.push(`Plan at index ${index} must be a valid object.`);
                return;
            }

            if (!VALID_STRATEGIES.includes(plan.strategy)) {
                errors.push(`Plan at index ${index} has invalid strategy: "${plan.strategy}".`);
            } else if (seenStrategies.has(plan.strategy)) {
                errors.push(`Duplicate strategy in plans array: "${plan.strategy}".`);
            } else {
                seenStrategies.add(plan.strategy);
            }

            // Rank should be sequential and unique, matching the array's own order
            // (index + 1). This catches a ranking pipeline that emits out-of-order
            // or duplicate ranks even though every individual plan looks valid.
            // `rank` is optional display metadata, not a required field, so this
            // only fires when the plan actually includes one.
            if (plan.rank !== undefined && plan.rank !== null) {
                if (plan.rank !== index + 1) {
                    errors.push(`Plan "${plan.strategy}" has rank ${plan.rank}, expected ${index + 1} based on array position.`);
                }
                if (seenRanks.has(plan.rank)) {
                    errors.push(`Duplicate rank detected: ${plan.rank}.`);
                } else {
                    seenRanks.add(plan.rank);
                }
            }

            const totalOutflow = Number(plan.totalOutflow);
            if (!isFiniteNonNegative(totalOutflow)) {
                errors.push(`Plan "${plan.strategy}" has invalid totalOutflow: ${plan.totalOutflow}.`);
            }

            // A "do not buy" plan shouldn't report spending money.
            if (plan.strategy === 'DO_NOT_BUY' && totalOutflow !== 0) {
                errors.push(`Plan "DO_NOT_BUY" should have totalOutflow of 0, got ${plan.totalOutflow}.`);
            }

            // Expense reduction percentage bounds [0, 100]
            const reduction = plan.expenseReductionAppliedPercent;
            if (reduction !== undefined && reduction !== null) {
                const numRed = Number(reduction);
                if (!Number.isFinite(numRed) || numRed < 0 || numRed > 100) {
                    errors.push(
                        `Plan "${plan.strategy}" has invalid expenseReductionAppliedPercent: ${reduction}. Must be between 0 and 100.`
                    );
                }
            }
        });

        // A recommender is only useful if it's actually willing to recommend
        // buying the item when doing so is affordable. This doesn't replace the
        // evaluator's own logic, but flags the specific pattern seen before:
        // DO_NOT_BUY ranked #1 while a fully viable paid strategy exists.
        const doNotBuyPlan = output.plans.find(p => p && p.strategy === 'DO_NOT_BUY');
        const viablePaidPlan = output.plans.find(p => p && p.strategy !== 'DO_NOT_BUY' && p.isViable);
        if (doNotBuyPlan && viablePaidPlan && doNotBuyPlan.rank < viablePaidPlan.rank) {
            warnings.push(
                `DO_NOT_BUY is ranked above a viable paid strategy ("${viablePaidPlan.strategy}"). ` +
                'DO_NOT_BUY should only outrank paid strategies when none of them are viable.'
            );
        }
    }

    // 4. Recommended Plan Check & Payment Dates
    if (!output.recommendedPlan || typeof output.recommendedPlan !== 'object') {
        errors.push('Output must contain a valid "recommendedPlan" object.');
    } else {
        if (output.recommendedPlan.strategy !== output.recommendedStrategy) {
            errors.push(
                `Mismatch between recommendedStrategy ("${output.recommendedStrategy}") and recommendedPlan.strategy ("${output.recommendedPlan.strategy}").`
            );
        }

        // The recommended plan should actually be the top-ranked plan, not just
        // agree on strategy name with a separate top-level field.
        if (Array.isArray(output.plans) && output.plans.length > 0) {
            const topPlan = output.plans.find(p => p && p.rank === 1) || output.plans[0];
            if (topPlan && topPlan.strategy !== output.recommendedPlan.strategy) {
                errors.push(
                    `recommendedPlan.strategy ("${output.recommendedPlan.strategy}") does not match the rank-1 plan ("${topPlan.strategy}").`
                );
            }
        }

        if (Array.isArray(output.recommendedPlan.purchaseEvents)) {
            let purchaseEventsSum = 0;
            let sumIsValid = true;

            output.recommendedPlan.purchaseEvents.forEach((event, idx) => {
                if (!event || typeof event !== 'object') {
                    errors.push(`Purchase event at index ${idx} must be a valid object.`);
                    sumIsValid = false;
                    return;
                }

                if (!isValidISODate(event.date)) {
                    errors.push(
                        `Purchase event at index ${idx} has invalid or missing date: "${event.date}". Must be a real calendar date in YYYY-MM-DD form.`
                    );
                }

                const amt = Number(event.amount);
                if (!isFiniteNonNegative(amt)) {
                    errors.push(`Purchase event at index ${idx} has invalid amount: "${event.amount}". Must be a finite number >= 0.`);
                    sumIsValid = false;
                } else {
                    purchaseEventsSum += amt;
                }

                if (isFiniteNonNegative(itemCost) && itemCost > 0 && amt > itemCost * 1.5 && event.type !== 'income') {
                    warnings.push(`Purchase event amount (${amt}) significantly exceeds item cost (${itemCost}).`);
                }
            });

            // Cross-check: the recommended plan's own purchase events should sum
            // to roughly its reported totalOutflow. This is the specific check
            // that would have caught the earlier bug class where a strategy's
            // events were generated but silently never applied/re-applied in a
            // simulation (e.g. installment or reduced-expense retry paths).
            if (sumIsValid && output.recommendedPlan.strategy !== 'DO_NOT_BUY') {
                const reportedOutflow = Number(output.recommendedPlan.totalOutflow);
                if (Number.isFinite(reportedOutflow) && Math.abs(purchaseEventsSum - reportedOutflow) > CENTS_TOLERANCE) {
                    errors.push(
                        `recommendedPlan purchaseEvents sum to ${purchaseEventsSum.toFixed(2)}, but totalOutflow is ${reportedOutflow.toFixed(2)}.`
                    );
                }
            }

            if (output.recommendedPlan.strategy === 'DO_NOT_BUY' && output.recommendedPlan.purchaseEvents.length > 0) {
                errors.push('DO_NOT_BUY plan should not have any purchaseEvents.');
            }
        }
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
    };
}