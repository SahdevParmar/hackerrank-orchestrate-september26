import { simulate90DayCashFlow } from './simulator.js';

const STRATEGY_PREFERENCE_RANK = {
    FULL_PURCHASE: 1,
    PARTIAL_PURCHASE: 2,
    INSTALLMENT_PLAN: 3,
    WAIT_AND_SAVE: 4,
    DO_NOT_BUY: 5,
};

function parseUTCDate(dateVal) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return isNaN(dateVal.getTime()) ? null : dateVal;
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateVal).trim());
    if (isoMatch) {
        const [, y, m, d] = isoMatch;
        return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    }
    const parsed = new Date(dateVal);
    return isNaN(parsed.getTime())
        ? null
        : new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function formatDateISO(d) {
    return d.toISOString().split('T')[0];
}

function addDaysToISO(isoDateStr, days) {
    const d = parseUTCDate(isoDateStr) || new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return formatDateISO(d);
}

function cloneEvents(events = []) {
    return (events || []).map(e => ({ ...e }));
}

function latestEventDate(events) {
    let latest = null;
    for (const e of events || []) {
        if (!e || !e.date) continue;
        const d = parseUTCDate(e.date);
        if (d && (!latest || d > latest)) latest = d;
    }
    return latest;
}

function ensureWindowCoversEvents(events, safeOptions, startDateObj) {
    const latest = latestEventDate(events);
    if (!latest || !startDateObj) return safeOptions;

    const requestedDays = Number(safeOptions.simulationDays || 90);
    const msPerDay = 24 * 60 * 60 * 1000;
    const spanDays = Math.ceil((latest.getTime() - startDateObj.getTime()) / msPerDay) + 1;

    if (spanDays <= requestedDays) return safeOptions;
    return { ...safeOptions, simulationDays: spanDays };
}

function findUserResult(simResult, targetUserId) {
    if (!simResult || !Array.isArray(simResult.users)) return {};
    const target = String(targetUserId || '').toUpperCase();
    return (
        simResult.users.find(u => {
            const id = String(u.userId || u.user_id || u.id || '').toUpperCase();
            return id === target;
        }) || simResult.users[0] || {}
    );
}

export function evaluatePurchaseOptions(item = {}, users = [], baseEvents = [], options = {}) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const safeUsers = Array.isArray(users) ? users : [];
    const safeEvents = Array.isArray(baseEvents) ? baseEvents : [];
    const safeOptions = options && typeof options === 'object' ? options : {};

    const targetUserId = String(
        safeOptions.targetUserId || safeUsers[0]?.user_id || safeUsers[0]?.userId || 'DEFAULT_USER'
    ).toUpperCase();
    const baseCurrency = safeOptions.baseCurrency || safeUsers[0]?.currency || 'USD';

    const itemCost = Math.max(0, Number(safeItem.cost || safeItem.price || 0));
    const itemDate = safeItem.target_date || safeItem.date || safeOptions.startDate || formatDateISO(new Date());
    const itemName = safeItem.name || safeItem.title || 'Target Purchase';

    const startDateObj = parseUTCDate(safeOptions.startDate) || parseUTCDate(itemDate) || new Date();

    // 0. Baseline Evaluation (DO_NOT_BUY)
    const baselineSim = simulate90DayCashFlow(safeUsers, safeEvents, safeOptions);
    const baselineUser = findUserResult(baselineSim, targetUserId);

    const candidates = [];

    // --- 1. DO_NOT_BUY Strategy ---
    candidates.push({
        strategy: 'DO_NOT_BUY',
        title: `Do Not Buy (${itemName})`,
        description: 'Maintain current cash flow trajectory without purchasing.',
        itemCost: 0,
        totalOutflow: 0,
        purchaseDate: null,
        expenseReductionApplied: 0,
        purchaseEvents: [],
        simResult: baselineSim,
        targetUserResult: baselineUser,
        isViable: true,
    });

    // --- 2. FULL_PURCHASE Strategy ---
    if (itemCost > 0) {
        const purchaseEvents = [
            {
                event_id: `OPT_FULL_${Date.now()}`,
                user_id: targetUserId,
                type: 'expense',
                amount: itemCost,
                date: itemDate,
                currency: baseCurrency,
                description: `Purchase: ${itemName} (Full)`,
            },
        ];
        const fullEvents = cloneEvents(safeEvents).concat(purchaseEvents);
        const fullOptions = ensureWindowCoversEvents(fullEvents, safeOptions, startDateObj);

        const fullSim = simulate90DayCashFlow(safeUsers, fullEvents, fullOptions);
        const fullUser = findUserResult(fullSim, targetUserId);

        candidates.push({
            strategy: 'FULL_PURCHASE',
            title: `Full Purchase on ${itemDate}`,
            description: `Pay full amount of ${itemCost.toFixed(2)} ${baseCurrency} upfront.`,
            itemCost,
            totalOutflow: itemCost,
            purchaseDate: itemDate,
            expenseReductionApplied: 0,
            purchaseEvents,
            simResult: fullSim,
            targetUserResult: fullUser,
            isViable: (fullUser.deficitDaysCount || 0) === 0,
        });
    }

    // --- 3. PARTIAL_PURCHASE Strategy ---
    const minDown = Number(safeItem.min_down_payment !== undefined ? safeItem.min_down_payment : itemCost * 0.3);
    if (itemCost > 0 && minDown > 0 && minDown < itemCost && safeItem.min_down_payment !== 0) {
        const remainingBalance = Number((itemCost - minDown).toFixed(2));
        const secondPaymentDate = addDaysToISO(itemDate, 30);

        const purchaseEvents = [
            {
                event_id: `OPT_PARTIAL_1_${Date.now()}`,
                user_id: targetUserId,
                type: 'expense',
                amount: minDown,
                date: itemDate,
                currency: baseCurrency,
                description: `Down payment for ${itemName}`,
            },
            {
                event_id: `OPT_PARTIAL_2_${Date.now()}`,
                user_id: targetUserId,
                type: 'expense',
                amount: remainingBalance,
                date: secondPaymentDate,
                currency: baseCurrency,
                description: `Remaining balance for ${itemName}`,
            },
        ];
        const partialEvents = cloneEvents(safeEvents).concat(purchaseEvents);
        const partialOptions = ensureWindowCoversEvents(partialEvents, safeOptions, startDateObj);

        const partialSim = simulate90DayCashFlow(safeUsers, partialEvents, partialOptions);
        const partialUser = findUserResult(partialSim, targetUserId);

        candidates.push({
            strategy: 'PARTIAL_PURCHASE',
            title: `Partial Purchase (Down Payment + Split)`,
            description: `Pay ${minDown.toFixed(2)} on ${itemDate} and ${remainingBalance.toFixed(2)} on ${secondPaymentDate}.`,
            itemCost,
            totalOutflow: itemCost,
            purchaseDate: itemDate,
            expenseReductionApplied: 0,
            purchaseEvents,
            simResult: partialSim,
            targetUserResult: partialUser,
            isViable: (partialUser.deficitDaysCount || 0) === 0,
        });
    }

    // --- 4. INSTALLMENT_PLAN Strategy ---
    const installmentMonths = Math.max(0, Number(safeItem.installment_months || 0));
    if (itemCost > 0 && installmentMonths > 1) {
        const interestRate = Number(
            safeItem.interest_rate_annual ?? 0
        );
        const monthlyInterestRate = interestRate / 12;
        const rawMonthly =
            monthlyInterestRate > 0
                ? (itemCost * (monthlyInterestRate * Math.pow(1 + monthlyInterestRate, installmentMonths))) /
                (Math.pow(1 + monthlyInterestRate, installmentMonths) - 1)
                : itemCost / installmentMonths;
        const monthlyPayment = Number(rawMonthly.toFixed(2));

        const purchaseEvents = [];
        let currentDate = itemDate;

        for (let m = 0; m < installmentMonths; m++) {
            purchaseEvents.push({
                event_id: `OPT_INSTALLMENT_${m + 1}_${Date.now()}`,
                user_id: targetUserId,
                type: 'expense',
                amount: monthlyPayment,
                date: currentDate,
                currency: baseCurrency,
                description: `Installment ${m + 1}/${installmentMonths} for ${itemName}`,
            });
            currentDate = addDaysToISO(currentDate, 30);
        }

        const installmentEvents = cloneEvents(safeEvents).concat(purchaseEvents);
        const installmentOptions = ensureWindowCoversEvents(installmentEvents, safeOptions, startDateObj);

        const installmentSim = simulate90DayCashFlow(safeUsers, installmentEvents, installmentOptions);
        const installmentUser = findUserResult(installmentSim, targetUserId);
        const totalOutflow = Number(purchaseEvents.reduce((sum, e) => sum + e.amount, 0).toFixed(2));

        candidates.push({
            strategy: 'INSTALLMENT_PLAN',
            title: `${installmentMonths}-Month Installment Plan`,
            description: `${installmentMonths} monthly payments of ${monthlyPayment.toFixed(2)} ${baseCurrency}.`,
            itemCost,
            totalOutflow,
            purchaseDate: itemDate,
            expenseReductionApplied: 0,
            purchaseEvents,
            simResult: installmentSim,
            targetUserResult: installmentUser,
            isViable: (installmentUser.deficitDaysCount || 0) === 0,
        });
    }

    // --- 5. WAIT_AND_SAVE Strategy ---
    const waitDays = Math.max(14, Number(safeOptions.waitDays || 30));
    // Skip wait and save if explicitly disabled via option flag or if target date is pushed too far and unwanted in specific tests
    if (itemCost > 0 && safeOptions.disableWaitAndSave !== true) {
        const delayedDate = addDaysToISO(itemDate, waitDays);
        const purchaseEvents = [
            {
                event_id: `OPT_WAIT_${Date.now()}`,
                user_id: targetUserId,
                type: 'expense',
                amount: itemCost,
                date: delayedDate,
                currency: baseCurrency,
                description: `Deferred Purchase: ${itemName}`,
            },
        ];
        const waitEvents = cloneEvents(safeEvents).concat(purchaseEvents);
        const waitOptions = ensureWindowCoversEvents(waitEvents, safeOptions, startDateObj);

        const waitSim = simulate90DayCashFlow(safeUsers, waitEvents, waitOptions);
        const waitUser = findUserResult(waitSim, targetUserId);

        candidates.push({
            strategy: 'WAIT_AND_SAVE',
            title: `Wait and Save (${waitDays} Days Delay)`,
            description: `Delay purchase until ${delayedDate} to accumulate cash buffer.`,
            itemCost,
            totalOutflow: itemCost,
            purchaseDate: delayedDate,
            expenseReductionApplied: 0,
            purchaseEvents,
            simResult: waitSim,
            targetUserResult: waitUser,
            isViable: (waitUser.deficitDaysCount || 0) === 0,
        });
    }

    // --- Dynamic Discretionary Expense Reduction Retry Loop ---
    const reductionLevels = safeOptions.reductionLevels || [0.1, 0.2, 0.3];

    for (const candidate of candidates) {
        if (candidate.strategy === 'DO_NOT_BUY' || candidate.isViable) continue;

        for (const reductionFraction of reductionLevels) {
            const reducedBaseline = applyDiscretionaryReduction(safeEvents, targetUserId, reductionFraction);
            const reducedEvents = reducedBaseline.concat(cloneEvents(candidate.purchaseEvents));
            const reducedOptions = ensureWindowCoversEvents(reducedEvents, safeOptions, startDateObj);

            const retrySim = simulate90DayCashFlow(safeUsers, reducedEvents, reducedOptions);
            const retryUser = findUserResult(retrySim, targetUserId);

            if ((retryUser.deficitDaysCount || 0) === 0) {
                candidate.isViable = true;
                candidate.expenseReductionApplied = Math.round(reductionFraction * 100);
                candidate.simResult = retrySim;
                candidate.targetUserResult = retryUser;
                candidate.description += ` (Achieved viability by reducing flexible expenses by ${Math.round(reductionFraction * 100)}%).`;
                break;
            }
        }
    }

    // --- Strategy Ranking & Tie-Breaker Resolution ---
    const tieBreakCompare = (a, b) => {
        const userA = a.targetUserResult;
        const userB = b.targetUserResult;

        // 1. Deficit days count (Ascending)
        const defA = userA.deficitDaysCount || 0;
        const defB = userB.deficitDaysCount || 0;
        if (defA !== defB) return defA - defB;

        // 2. Minimum balance breach days count (Ascending)
        const breachA = userA.minBalanceBreachDaysCount || 0;
        const breachB = userB.minBalanceBreachDaysCount || 0;
        if (breachA !== breachB) return breachA - breachB;

        // 3. Ending balance (Descending)
        const endA = userA.endingBalance || 0;
        const endB = userB.endingBalance || 0;
        if (Math.abs(endA - endB) > 0.01) return endB - endA;

        // 4. Total Outflow (Ascending)
        if (Math.abs(a.totalOutflow - b.totalOutflow) > 0.01) return a.totalOutflow - b.totalOutflow;

        // 5. Canonical Preference Hierarchy
        const rankA = STRATEGY_PREFERENCE_RANK[a.strategy] || 99;
        const rankB = STRATEGY_PREFERENCE_RANK[b.strategy] || 99;
        return rankA - rankB;
    };

    const doNotBuy = candidates.find(c => c.strategy === 'DO_NOT_BUY');
    const purchaseCandidates = candidates.filter(c => c.strategy !== 'DO_NOT_BUY');
    const viablePurchaseCandidates = purchaseCandidates.filter(c => c.isViable).sort(tieBreakCompare);
    const nonViablePurchaseCandidates = purchaseCandidates.filter(c => !c.isViable).sort(tieBreakCompare);

    const rankedPlans =
        viablePurchaseCandidates.length > 0
            ? [...viablePurchaseCandidates, doNotBuy, ...nonViablePurchaseCandidates]
            : [doNotBuy, ...nonViablePurchaseCandidates];

    const recommendedPlan = rankedPlans[0];

    return {
        itemName,
        itemCost,
        targetUserId,

        recommendedStrategy: recommendedPlan.strategy,

        recommendedPlan: {
            ...recommendedPlan,
            expenseReductionAppliedPercent:
                recommendedPlan.expenseReductionApplied,
        },

        evaluatedPlansCount: rankedPlans.length,

        plans: rankedPlans.map((p, index) => ({
            rank: index + 1,
            strategy: p.strategy,
            title: p.title,
            isViable: p.isViable,

            expenseReductionAppliedPercent:
                p.expenseReductionApplied,

            endingBalance: p.targetUserResult.endingBalance || 0,

            lowestBalance:
                p.targetUserResult.lowestBalance?.amount || 0,

            deficitDaysCount:
                p.targetUserResult.deficitDaysCount || 0,

            minBalanceBreachDaysCount:
                p.targetUserResult.minBalanceBreachDaysCount || 0,

            recommendedBufferNeeded:
                p.targetUserResult.recommendedBufferNeeded || 0,

            totalOutflow: p.totalOutflow,
        })),
    };
}

function applyDiscretionaryReduction(events, userId, reductionFraction) {
    const flexibleCategories = [
        'entertainment',
        'dining',
        'shopping',
        'subscription',
        'leisure',
        'discretionary',
        'food',
        'movies',
        'games',
    ];

    const target = String(userId || '').toUpperCase();

    return (events || []).map(e => {
        if (!e) return { ...e };
        const eventUser = String(e.user_id || e.userId || target).toUpperCase();
        if (eventUser !== target) return { ...e };

        const type = String(e.type || e.transaction_type || 'expense').toLowerCase();
        const categoryStr = String(e.category || '').toLowerCase();
        const descStr = String(e.description || '').toLowerCase();

        const isFlexible =
            e.is_flexible === true ||
            e.is_discretionary === true ||
            flexibleCategories.some(cat => categoryStr.includes(cat) || descStr.includes(cat));

        if ((type === 'expense' || type === 'debit') && isFlexible) {
            const origAmount = Number(e.amount || 0);
            return {
                ...e,
                amount: Number((origAmount * (1 - reductionFraction)).toFixed(2)),
            };
        }
        return { ...e };
    });
}