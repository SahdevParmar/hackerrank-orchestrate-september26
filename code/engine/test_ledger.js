import { calculateLedger, projectRecurringEvents, deduplicateEvents, normalizeDate } from './ledger.js';

function runLedgerSuite() {
    console.log('🧪 Starting Advanced Financial Ledger Engine Test Suite...\n');
    let passed = 0;
    let failed = 0;

    function assert(condition, testName, failDetails = '') {
        if (condition) {
            console.log(`  ✅ PASS: ${testName}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${testName} ${failDetails ? `(${failDetails})` : ''}`);
            failed++;
        }
    }

    // --- Suite 1: Date Normalization & Recurring Calendar Anchor Math ---
    console.log('--- Test Suite 1: UTC Date Anchoring & Month End Recurrences ---');

    const jan31Event = [{
        event_id: 'REC_RENT',
        amount: 1200,
        type: 'expense',
        is_recurring: true,
        frequency: 'monthly',
        date: '2026-01-31',
        user_id: 'USER_1'
    }];

    const projectedRent = projectRecurringEvents(jan31Event, '2026-04-30');
    const rentDates = projectedRent.map(e => e.date);

    assert(
        rentDates.includes('2026-01-31') && rentDates.includes('2026-02-28') && rentDates.includes('2026-03-31') && rentDates.includes('2026-04-30'),
        'Preserves day-of-month anchor across short months (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30)',
        `Got dates: ${rentDates.join(', ')}`
    );

    assert(
        projectedRent.length === 4,
        'Enforces hard cutoff date for recurring events expansion',
        `Expected 4 instances, got ${projectedRent.length}`
    );

    // --- Suite 2: Non-Disruptive Bilateral Transfer Deduplication ---
    console.log('\n--- Test Suite 2: Bilateral User Transfers & Scoped Deduplication ---');

    const users = [
        { user_id: 'ALICE', starting_balance: 1000, currency: 'USD' },
        { user_id: 'BOB', starting_balance: 200, currency: 'USD' }
    ];

    const transferEvents = [
        {
            event_id: 'TRF_9901',
            user_id: 'ALICE',
            from_user_id: 'ALICE',
            to_user_id: 'BOB',
            amount: 150,
            type: 'transfer',
            date: '2026-02-10'
        },
        {
            event_id: 'TRF_9901', // Mirror transaction record for receiving user
            user_id: 'BOB',
            from_user_id: 'ALICE',
            to_user_id: 'BOB',
            amount: 150,
            type: 'transfer',
            date: '2026-02-10'
        }
    ];

    const transferLedger = calculateLedger(users, transferEvents);
    const alice = transferLedger.users.find(u => u.user_id === 'ALICE');
    const bob = transferLedger.users.find(u => u.user_id === 'BOB');

    assert(
        alice && alice.ending_balance === 850 && alice.total_expenses === 150,
        'Deducts outgoing transfer from sender account balance (Alice: $1000 -> $850)',
        `Alice balance: ${alice?.ending_balance}`
    );

    assert(
        bob && bob.ending_balance === 350 && bob.total_income === 150,
        'Preserves receiver leg without dropping transfer record (Bob: $200 -> $350)',
        `Bob balance: ${bob?.ending_balance}`
    );

    // --- Suite 3: Multi-Currency Exchange Rate Conversion ---
    console.log('\n--- Test Suite 3: Multi-Currency Normalization ---');

    const multiCurrUser = [{ user_id: 'GLOBAL_USER', starting_balance: 0, currency: 'USD' }];
    const multiCurrEvents = [
        { event_id: 'INC_EUR', user_id: 'GLOBAL_USER', amount: 100, currency: 'EUR', type: 'income', date: '2026-03-01' },
        { event_id: 'INC_INR', user_id: 'GLOBAL_USER', amount: 1000, currency: 'INR', type: 'income', date: '2026-03-02' }
    ];

    // Rates: 1 EUR = 1.08 USD, 1 INR = 0.012 USD -> Total = 108 + 12 = $120.00 USD
    const currencyLedger = calculateLedger(multiCurrUser, multiCurrEvents, {
        exchangeRates: { EUR: 1.08, INR: 0.012 }
    });
    const globalUser = currencyLedger.users[0];

    assert(
        globalUser && globalUser.ending_balance === 120,
        'Converts foreign currencies (EUR & INR) accurately into USD target currency ($120.00)',
        `Got ending balance: ${globalUser?.ending_balance}`
    );

    // --- Suite 4: Historical Cutoff Date Boundary Enforcement ---
    console.log('\n--- Test Suite 4: Historical Cutoff Date Anchoring ---');

    const cutoffUser = [{
        user_id: 'CHARLIE',
        starting_balance: 500,
        starting_balance_date: '2026-03-01',
        currency: 'USD'
    }];

    const historicalEvents = [
        { event_id: 'OLD_EVT', user_id: 'CHARLIE', amount: 200, type: 'income', date: '2026-01-15' }, // Should be ignored
        { event_id: 'NEW_EVT', user_id: 'CHARLIE', amount: 50, type: 'expense', date: '2026-03-05' }  // Should be processed
    ];

    const cutoffLedger = calculateLedger(cutoffUser, historicalEvents);
    const charlie = cutoffLedger.users[0];

    assert(
        charlie && charlie.ending_balance === 450 && charlie.transactions_count === 1,
        'Filters out transactions prior to starting balance cutoff date (Ignores Jan 15 income)',
        `Charlie ending balance: ${charlie?.ending_balance}, transactions: ${charlie?.transactions_count}`
    );

    // --- Suite 5: Floating Point Cent Integrity & Edge Null Handling ---
    console.log('\n--- Test Suite 5: Integer Cent Accuracy & Defensiveness ---');

    const floatUsers = [{ user_id: 'PRECISION_USER', starting_balance: 10.05 }];
    const floatEvents = [
        { event_id: 'F1', user_id: 'PRECISION_USER', amount: 0.10, type: 'income', date: '2026-04-01' },
        { event_id: 'F2', user_id: 'PRECISION_USER', amount: 0.20, type: 'income', date: '2026-04-01' },
        { event_id: 'F3', user_id: 'PRECISION_USER', amount: 0.33, type: 'expense', date: '2026-04-01' }
    ];

    const floatLedger = calculateLedger(floatUsers, floatEvents);
    const precisionUser = floatLedger.users[0];

    assert(
        precisionUser && precisionUser.ending_balance === 10.02,
        'Eliminates floating point drift (10.05 + 0.10 + 0.20 - 0.33 = 10.02 exactly)',
        `Got balance: ${precisionUser?.ending_balance}`
    );

    const emptyLedger = calculateLedger(null, null);
    assert(
        emptyLedger && emptyLedger.users.length === 1 && emptyLedger.net_ledger_balance === 0,
        'Handles null inputs gracefully by defaulting to standard zero ledger structure'
    );

    // --- Summary ---
    console.log(`\n-----------------------------------`);
    console.log(`Test Execution Finished: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) process.exit(1);
}

runLedgerSuite();