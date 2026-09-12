import { verifyPurchaseRecommendation } from './verifier.js';

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

console.log('--- Test Suite: Verification Guardrails ---\n');

// 1. Valid Output Passes
(() => {
    const validOutput = {
        itemName: 'Laptop',
        itemCost: 1200,
        recommendedStrategy: 'FULL_PURCHASE',
        plans: [
            {
                strategy: 'FULL_PURCHASE',
                totalOutflow: 1200,
                expenseReductionAppliedPercent: 0,
            }
        ],
        recommendedPlan: {
            strategy: 'FULL_PURCHASE',
            purchaseEvents: [
                { date: '2026-10-05', amount: 1200, type: 'expense' }
            ]
        }
    };

    const res = verifyPurchaseRecommendation(validOutput);
    assert(res.isValid === true, 'Valid purchase recommendation passes verification');
    assert(res.errors.length === 0, 'Zero errors reported for valid structure');
})();

// 2. Invalid Strategy Enum Fails
(() => {
    const invalidOutput = {
        itemName: 'Phone',
        itemCost: 500,
        recommendedStrategy: 'INVALID_STRATEGY',
        plans: [],
        recommendedPlan: { strategy: 'INVALID_STRATEGY', purchaseEvents: [] }
    };

    const res = verifyPurchaseRecommendation(invalidOutput);
    assert(res.isValid === false, 'Flags invalid recommendedStrategy enum');
    assert(res.errors.some(e => e.includes('recommendedStrategy')), 'Error message specifies invalid strategy');
})();

// 3. Out-of-Bounds Numerical Checks Fails
(() => {
    const invalidOutput = {
        itemName: 'Tablet',
        itemCost: -300,
        recommendedStrategy: 'FULL_PURCHASE',
        plans: [
            {
                strategy: 'FULL_PURCHASE',
                totalOutflow: 300,
                expenseReductionAppliedPercent: 150, // Invalid > 100
            }
        ],
        recommendedPlan: {
            strategy: 'FULL_PURCHASE',
            purchaseEvents: [
                { date: '2026-10-05', amount: -50, type: 'expense' } // Negative amount
            ]
        }
    };

    const res = verifyPurchaseRecommendation(invalidOutput);
    assert(res.isValid === false, 'Flags negative itemCost, negative amounts, and invalid percentage bounds');
})();

// 4. Invalid Payment Dates Fails
(() => {
    const invalidOutput = {
        itemName: 'Monitor',
        itemCost: 400,
        recommendedStrategy: 'FULL_PURCHASE',
        plans: [
            { strategy: 'FULL_PURCHASE', totalOutflow: 400 }
        ],
        recommendedPlan: {
            strategy: 'FULL_PURCHASE',
            purchaseEvents: [
                { date: '2026/13/45', amount: 400, type: 'expense' } // Malformed date
            ]
        }
    };

    const res = verifyPurchaseRecommendation(invalidOutput);
    assert(res.isValid === false, 'Flags malformed purchase event date');
    assert(res.errors.some(e => e.includes('date')), 'Error specifies date validation failure');
})();

console.log('\n==================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passed}/${passed + failed} Passed`);
console.log('==================================================');

if (failed > 0) process.exit(1);