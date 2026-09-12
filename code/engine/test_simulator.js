/**
 * Advanced Real-World Test Suite for 90-Day Cash Flow Simulator Engine
 * Tests 90-day timeline boundaries, minimum balance thresholds, bilateral transfers,
 * multi-currency conversions, orphan user provisioning, and floating-point precision.
 */

import { simulate90DayCashFlow } from './simulator.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✅ PASS: ${message}`);
    } else {
        failedTests++;
        console.error(`  ❌ FAIL: ${message}`);
    }
}

function assertEquals(actual, expected, message) {
    const isMatch = actual === expected;
    assert(isMatch, `${message} (Expected: ${expected}, Got: ${actual})`);
}

function assertCloseTo(actual, expected, precision = 0.01, message) {
    const diff = Math.abs(actual - expected);
    assert(diff <= precision, `${message} (Expected: ~${expected}, Got: ${actual})`);
}

function runTestSuite() {
    console.log('🧪 Starting Advanced 90-Day Cash Flow Simulator Test Suite...\n');

    // =========================================================================
    // Test Suite 1: Timeline Projection & 90-Day Range Boundaries
    // =========================================================================
    console.log('--- Test Suite 1: Timeline Projection & 90-Day Range Boundaries ---');
    {
        const users = [
            { user_id: 'USR_ALICE', name: 'Alice', starting_balance: 1000, minimum_balance_to_keep: 200, currency: 'USD' }
        ];
        const events = [
            { event_id: 'EVT_1', user_id: 'USR_ALICE', amount: 100, type: 'income', date: '2026-05-01' },
            { event_id: 'EVT_2', user_id: 'USR_ALICE', amount: 50, type: 'expense', date: '2026-05-15' }
        ];

        const res = simulate90DayCashFlow(users, events, {
            startDate: '2026-05-01',
            simulationDays: 90
        });

        assertEquals(res.simulationWindow.startDate, '2026-05-01', 'Starts exact on requested startDate');
        assertEquals(res.simulationWindow.endDate, '2026-07-29', 'Calculates exact 90-day inclusive cutoff date');
        assertEquals(res.simulationWindow.totalDays, 90, 'Generates exactly 90 simulation days');

        const alice = res.users.find(u => u.userId === 'USR_ALICE');
        assertEquals(alice.dailyTimeline.length, 90, 'Generates 90 daily timeline entries for user');
        assertEquals(alice.dailyTimeline[0].date, '2026-05-01', 'First timeline tick matches start date');
        assertEquals(alice.dailyTimeline[0].endingBalance, 1100, 'Day 1 reflects starting balance + income ($1000 + $100 = $1100)');
        assertEquals(alice.endingBalance, 1050, 'Final ending balance matches total transactions ($1000 + $100 - $50 = $1050)');
    }

    // =========================================================================
    // Test Suite 2: Minimum Balance Breaches & Recommended Buffer Calculation
    // =========================================================================
    console.log('\n--- Test Suite 2: Minimum Balance Breaches & Status Classification ---');
    {
        const users = [
            { user_id: 'USR_BOB', name: 'Bob', starting_balance: 500, minimum_balance_to_keep: 300, currency: 'USD' }
        ];
        // Day 5: Expense $300 -> Balance $200 (Breaches $300 min, buffer needed: $100)
        // Day 10: Expense $300 -> Balance -$100 (Breaches $0 deficit threshold, buffer needed: $400)
        const events = [
            { event_id: 'EVT_B1', user_id: 'USR_BOB', amount: 300, type: 'expense', date: '2026-06-05' },
            { event_id: 'EVT_B2', user_id: 'USR_BOB', amount: 300, type: 'expense', date: '2026-06-10' }
        ];

        const res = simulate90DayCashFlow(users, events, {
            startDate: '2026-06-01',
            simulationDays: 90
        });

        const bob = res.users.find(u => u.userId === 'USR_BOB');

        assertEquals(bob.status, 'DEFICIT_RISK', 'Classifies user as DEFICIT_RISK when balance drops below 0');
        assertEquals(bob.firstMinBalanceBreachDate, '2026-06-05', 'Detects exact first min balance breach date');
        assertEquals(bob.firstDeficitDate, '2026-06-10', 'Detects exact first overdraft deficit date');
        assertEquals(bob.lowestBalance.amount, -100, 'Tracks correct minimum balance point (-$100)');
        assertEquals(bob.lowestBalance.date, '2026-06-10', 'Identifies correct lowest balance date');
        assertEquals(bob.recommendedBufferNeeded, 400, 'Calculates exact recommended buffer needed ($300 min threshold - -$100 balance = $400)');
    }

    // =========================================================================
    // Test Suite 3: Bilateral User Transfers & Per-Account Daily Balances
    // =========================================================================
    console.log('\n--- Test Suite 3: Bilateral User Transfers & Dual-Leg Accounting ---');
    {
        const users = [
            { user_id: 'USR_ALICE', name: 'Alice', starting_balance: 1000, minimum_balance_to_keep: 100, currency: 'USD' },
            { user_id: 'USR_BOB', name: 'Bob', starting_balance: 200, minimum_balance_to_keep: 50, currency: 'USD' }
        ];
        // Transfer $300 from Alice to Bob on Day 3
        const events = [
            {
                event_id: 'TRF_101',
                user_id: 'USR_ALICE',
                from_user_id: 'USR_ALICE',
                to_user_id: 'USR_BOB',
                amount: 300,
                type: 'transfer',
                date: '2026-07-03'
            },
            {
                event_id: 'TRF_101',
                user_id: 'USR_BOB',
                from_user_id: 'USR_ALICE',
                to_user_id: 'USR_BOB',
                amount: 300,
                type: 'transfer',
                date: '2026-07-03'
            }
        ];

        const res = simulate90DayCashFlow(users, events, {
            startDate: '2026-07-01',
            simulationDays: 30
        });

        const alice = res.users.find(u => u.userId === 'USR_ALICE');
        const bob = res.users.find(u => u.userId === 'USR_BOB');

        assertEquals(alice.endingBalance, 700, 'Debits sender account correctly ($1000 - $300 = $700)');
        assertEquals(bob.endingBalance, 500, 'Credits receiver account correctly ($200 + $300 = $500)');
    }

    // =========================================================================
    // Test Suite 4: Foreign Currency Conversion & Multi-Currency Daily Ledger
    // =========================================================================
    console.log('\n--- Test Suite 4: Foreign Currency Conversion ---');
    {
        const users = [
            { user_id: 'USR_CAROL', name: 'Carol', starting_balance: 1000, minimum_balance_to_keep: 0, currency: 'USD' }
        ];
        // Carol receives 100 EUR income (Rate EUR: 1.08 -> $108 USD)
        const events = [
            { event_id: 'EVT_EUR', user_id: 'USR_CAROL', amount: 100, currency: 'EUR', type: 'income', date: '2026-08-05' }
        ];

        const res = simulate90DayCashFlow(users, events, {
            startDate: '2026-08-01',
            simulationDays: 30,
            exchangeRates: { EUR: 1.08, USD: 1.0 }
        });

        const carol = res.users.find(u => u.userId === 'USR_CAROL');
        assertEquals(carol.endingBalance, 1108, 'Converts 100 EUR income into $108 USD starting addition ($1000 + $108 = $1108)');
    }

    // =========================================================================
    // Test Suite 5: Orphan User Auto-Provisioning & Telemetry Diagnostics
    // =========================================================================
    console.log('\n--- Test Suite 5: Orphan User Auto-Provisioning & Diagnostics ---');
    {
        const users = [
            { user_id: 'USR_EXISTS', name: 'Existing User', starting_balance: 500, currency: 'USD' }
        ];
        // Event references USR_ORPHAN who is NOT in users array
        const events = [
            { event_id: 'EVT_O1', user_id: 'USR_ORPHAN', amount: 250, type: 'income', date: '2026-09-02' },
            { event_id: 'EVT_BAD_DATE', user_id: 'USR_EXISTS', amount: 100, type: 'income', date: 'INVALID_DATE' },
            { event_id: 'EVT_REC', user_id: 'USR_EXISTS', amount: 50, type: 'expense', date: '2026-09-05', is_recurring: true }
        ];

        const res = simulate90DayCashFlow(users, events, {
            startDate: '2026-09-01',
            simulationDays: 30
        });

        const orphan = res.users.find(u => u.userId === 'USR_ORPHAN');
        assert(orphan !== undefined, 'Auto-creates simulation bucket for unlisted orphan user ID');
        assertEquals(orphan.autoCreatedFromOrphanEvent, true, 'Flags auto-created orphan user status');
        assertEquals(orphan.endingBalance, 250, 'Processes events for auto-created orphan user correctly');

        assertEquals(res.diagnostics.orphanUserIdsAutoCreated.includes('USR_ORPHAN'), true, 'Tracks orphan user ID in diagnostic output');
        assertEquals(res.diagnostics.unparseableDateEventsSkipped, 1, 'Records unparseable date event count in diagnostics');
        assertEquals(res.diagnostics.possiblyUnexpandedRecurringEvents, 1, 'Flags unexpanded recurring event in diagnostics');
    }

    // =========================================================================
    // Test Suite 6: Floating-Point Cent Accuracy over 90 Days
    // =========================================================================
    console.log('\n--- Test Suite 6: Floating-Point Cent Accuracy & Defensiveness ---');
    {
        const users = [
            { user_id: 'USR_MATH', name: 'Math Test', starting_balance: 10.05, currency: 'USD' }
        ];
        // Daily pattern: +$0.10, +$0.20, -$0.33 over 3 days (net -$0.03 every 3 days)
        const events = [];
        const baseDate = new Date('2026-10-01');

        for (let i = 0; i < 90; i++) {
            const dStr = new Date(baseDate.getTime() + i * 86400000).toISOString().split('T')[0];
            events.push({ event_id: `M1_${i}`, user_id: 'USR_MATH', amount: 0.10, type: 'income', date: dStr });
            events.push({ event_id: `M2_${i}`, user_id: 'USR_MATH', amount: 0.20, type: 'income', date: dStr });
            events.push({ event_id: `M3_${i}`, user_id: 'USR_MATH', amount: 0.33, type: 'expense', date: dStr });
        }

        const res = simulate90DayCashFlow(users, events, {
            startDate: '2026-10-01',
            simulationDays: 90
        });

        const mathUser = res.users.find(u => u.userId === 'USR_MATH');
        // Expected: 10.05 + 90 * (0.10 + 0.20 - 0.33) = 10.05 + 90 * (-0.03) = 10.05 - 2.70 = 7.35 exactly
        assertEquals(mathUser.endingBalance, 7.35, 'Eliminates floating-point drift over 270 sequential transactions (10.05 - 2.70 = 7.35 exactly)');
    }

    // =========================================================================
    // Summary
    // =========================================================================
    console.log('\n==================================================');
    console.log(`📊 TEST SUITE SUMMARY: ${passedTests}/${totalTests} Passed`);
    console.log('==================================================');

    if (failedTests > 0) {
        console.error(`❌ ${failedTests} test(s) failed.`);
        process.exit(1);
    } else {
        console.log('✨ All 90-day simulator tests passed cleanly!');
    }
}

runTestSuite();