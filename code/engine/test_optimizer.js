import { evaluatePurchaseOptions } from './optimizer.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ PASS: ${message}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${message}`);
        failed++;
    }
}

console.log('--- Test Suite: Purchase Strategy Optimizer & Plan Ranker ---\n');

// 1. Full Purchase Preference
(() => {
    const users = [
        { user_id: 'USER_HEALTHY', starting_balance: 5000, minimum_balance_to_keep: 500, currency: 'USD' }
    ];
    const events = [
        { date: '2026-10-01', user_id: 'USER_HEALTHY', type: 'income', amount: 3000, currency: 'USD' },
        { date: '2026-10-05', user_id: 'USER_HEALTHY', type: 'expense', amount: 500, category: 'rent', currency: 'USD' }
    ];
    const item = { name: 'Laptop', cost: 1200, target_date: '2026-10-10' };
    const options = { startDate: '2026-10-01', simulationDays: 90 };

    const res = evaluatePurchaseOptions(item, users, events, options);
    assert(res.recommendedStrategy === 'FULL_PURCHASE', 'Selects FULL_PURCHASE when user has ample liquidity');
    assert(res.plans[0].strategy === 'FULL_PURCHASE', 'Ranks FULL_PURCHASE as #1');
})();

// 2. Installment Plan Selection
(() => {
    const users = [
        { user_id: 'USER_TIGHT', starting_balance: 400, minimum_balance_to_keep: 50, currency: 'USD' }
    ];
    const events = [];
    const item = { name: 'E-Bike', cost: 1000, target_date: '2026-10-05', min_down_payment: 0, installment_months: 3, interest_rate_annual: 0 };
    const options = { startDate: '2026-10-01', simulationDays: 90, disableWaitAndSave: true };

    const res = evaluatePurchaseOptions(item, users, events, options);
    assert(res.recommendedStrategy === 'INSTALLMENT_PLAN', 'Selects INSTALLMENT_PLAN when upfront purchase triggers deficit');
    assert(res.plans.find(p => p.strategy === 'FULL_PURCHASE').isViable === false, 'Flags FULL_PURCHASE as non-viable');
})();

// 3. Wait & Save Strategy Selection
(() => {
    const users = [
        { user_id: 'USER_SAVER', starting_balance: 200, minimum_balance_to_keep: 50, currency: 'USD' }
    ];
    const events = [
        { date: '2026-10-15', user_id: 'USER_SAVER', type: 'income', amount: 1500, currency: 'USD' }
    ];
    const item = { name: 'Tool Kit', cost: 800, target_date: '2026-10-05', min_down_payment: 0, installment_months: 0 };
    const options = { startDate: '2026-10-01', simulationDays: 90, waitDays: 30 };

    const res = evaluatePurchaseOptions(item, users, events, options);
    assert(res.recommendedStrategy === 'WAIT_AND_SAVE', 'Recommends WAIT_AND_SAVE when delayed date aligns with incoming cash flow');
})();

// 4. Flexible Expense Reduction Recovery (10%, 20%, 30%)
(() => {
    const users = [
        { user_id: 'USER_SPENDER', starting_balance: 400, minimum_balance_to_keep: 100, currency: 'USD' }
    ];
    const events = [
        { date: '2026-10-02', user_id: 'USER_SPENDER', type: 'expense', amount: 300, category: 'dining', is_flexible: true, currency: 'USD' },
        { date: '2026-10-03', user_id: 'USER_SPENDER', type: 'expense', amount: 200, category: 'shopping', is_flexible: true, currency: 'USD' }
    ];
    // Cost 500 with starting balance 400 creates a deficit unless flexible expenses are reduced!
    const item = { name: 'Phone', cost: 500, target_date: '2026-10-05', min_down_payment: 0, installment_months: 0 };
    const options = { startDate: '2026-10-01', simulationDays: 90, disableWaitAndSave: true };

    const res = evaluatePurchaseOptions(item, users, events, options);
    assert(res.recommendedStrategy === 'FULL_PURCHASE', 'Recovers FULL_PURCHASE viability via discretionary expense reduction');
    assert(res.recommendedPlan.expenseReductionAppliedPercent > 0, 'Records expense reduction percentage applied');
})();

// 5. DO_NOT_BUY Fallback
(() => {
    const users = [
        { user_id: 'USER_BROKE', starting_balance: 50, minimum_balance_to_keep: 10, currency: 'USD' }
    ];
    const events = [];
    const item = { name: 'Luxury Yacht', cost: 10000, target_date: '2026-10-01' };
    const options = { startDate: '2026-10-01', simulationDays: 90 };

    const res = evaluatePurchaseOptions(item, users, events, options);
    assert(res.recommendedStrategy === 'DO_NOT_BUY', 'Surfaces DO_NOT_BUY as #1 recommendation when all purchase plans are non-viable');
    assert(res.plans[0].strategy === 'DO_NOT_BUY', 'DO_NOT_BUY occupies rank 1 when purchase options fail');
})();

// 6. Tie-Breaker Ordering
(() => {
    const users = [
        { user_id: 'USER_TIE', starting_balance: 2000, minimum_balance_to_keep: 200, currency: 'USD' }
    ];
    const events = [];
    const item = { name: 'Camera', cost: 600, target_date: '2026-10-01', min_down_payment: 200, installment_months: 3, interest_rate_annual: 0 };
    const options = { startDate: '2026-10-01', simulationDays: 90 };

    const res = evaluatePurchaseOptions(item, users, events, options);
    const rank1 = res.plans[0].strategy;
    const rank2 = res.plans[1].strategy;

    assert(rank1 === 'FULL_PURCHASE', 'Tie-breaker places FULL_PURCHASE over PARTIAL_PURCHASE when deficits tie');
    assert(rank2 === 'PARTIAL_PURCHASE', 'Tie-breaker places PARTIAL_PURCHASE over INSTALLMENT_PLAN when deficits tie');
})();

// 7. Dynamic Horizon Window Expansion
(() => {
    const users = [
        { user_id: 'USER_EXPAND', starting_balance: 5000, minimum_balance_to_keep: 100, currency: 'USD' }
    ];
    const events = [];
    const item = { name: 'Industrial Lathe', cost: 12000, target_date: '2026-10-01', installment_months: 12, interest_rate_annual: 0 };
    const options = { startDate: '2026-10-01', simulationDays: 90 };

    const res = evaluatePurchaseOptions(item, users, events, options);
    const instPlan = res.plans.find(p => p.strategy === 'INSTALLMENT_PLAN');
    assert(instPlan !== undefined, 'Evaluates multi-month installment plan beyond 90 days');
})();

// 8. Defensive Edge Cases
(() => {
    const zeroCostRes = evaluatePurchaseOptions({ cost: 0 }, [], [], {});
    assert(zeroCostRes.recommendedStrategy === 'DO_NOT_BUY', 'Handles zero cost item gracefully');

    const emptyRes = evaluatePurchaseOptions(null, null, null, null);
    assert(emptyRes.evaluatedPlansCount > 0, 'Handles null parameters without crashing');
})();

console.log('\n==================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passed}/${passed + failed} Passed`);
console.log('==================================================');

if (failed > 0) process.exit(1);