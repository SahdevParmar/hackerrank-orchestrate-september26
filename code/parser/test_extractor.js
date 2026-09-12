import { extractAmountFromText, parseMessageModifiers, enrichEvents } from './llmExtractor.js';

function runSuite() {
    console.log('🧪 Starting Comprehensive llmExtractor.js Test Suite...\n');
    let passed = 0;
    let failed = 0;

    function assert(condition, testName) {
        if (condition) {
            console.log(`  ✅ PASS: ${testName}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${testName}`);
            failed++;
        }
    }

    // --- Suite 1: extractAmountFromText Edge Cases ---
    console.log('--- Test Suite 1: OCR Amount Extraction & Noise Masking ---');

    assert(
        extractAmountFromText('Receipt date: 2026-09-12 Total $150.00') === 150,
        'Masks YYYY-MM-DD date and extracts correctly formatted USD amount'
    );

    assert(
        extractAmountFromText('Date 15/09/2026 Subtotal: €45.50 (Tax 15% incl.)') === 45.5,
        'Masks DD/MM/YYYY dates and percentage values for Euro amount'
    );

    assert(
        extractAmountFromText('Support Call: 1-800-555-0199 | Amount Paid: INR 2,500') === 2500,
        'Ignores phone numbers and extracts comma-formatted INR amount'
    );

    assert(
        extractAmountFromText('STORE #99401 - Order 88210 - Total: ₹450.75') === 450.75,
        'Ignores store/order hash numbers and extracts Rupee amount'
    );

    assert(
        extractAmountFromText('Invoice #9904 paid on 05/12/2026 without price') === null,
        'Returns null when text contains no monetary values'
    );

    assert(
        extractAmountFromText(null) === null && extractAmountFromText('') === null,
        'Handles null, undefined, or empty string gracefully'
    );

    // --- Suite 2: parseMessageModifiers Schema & Regex Flexibility ---
    console.log('\n--- Test Suite 2: Message Modifier & Case Insensitivity ---');

    const edgeMessages = [
        { text: 'PLEASE VOID EVENT evt_104 IMMEDIATELY' },
        { content: 'Please skip transaction EVT_202' }, // uses 'content' property key
        { message_text: 'Event evt_105 amount is set to $500.00' }, // uses 'message_text' key
        { text: 'Change EVT_106 to 75.50' },
    ];

    const { cancelledEventIds, amountOverrides } = parseMessageModifiers(edgeMessages);

    assert(
        cancelledEventIds.has('EVT_104') && cancelledEventIds.has('EVT_202'),
        'Normalizes lowercase event IDs and supports multiple cancel keywords (void/skip)'
    );

    assert(
        amountOverrides.get('EVT_105') === 500 && amountOverrides.get('EVT_106') === 75.5,
        'Parses amount overrides across varied message object schemas'
    );

    // --- Suite 3: enrichEvents Fallbacks & Conflict Resolution ---
    console.log('\n--- Test Suite 3: Event Pipeline & Conflict Resolution ---');

    const rawEvents = [
        { event_id: 'EVT_201', amount: 100, description: 'Groceries' },
        { event_id: 'EVT_202', amount: null, description: 'Utility Bill' },  // Needs OCR (raw_text property)
        { event_id: 'EVT_203', amount: null, description: 'Internet Bill' }, // Needs OCR (description property)
        { event_id: 'EVT_204', amount: 50, description: 'Subscriptions' },   // Cancelled & Overridden -> Cancel wins
        { event_id: 'EVT_205', amount: 0, description: 'Unknown' },          // Missing amount, no image available
    ];

    const rawImages = [
        { related_event_id: 'evt_202', raw_text: 'Utility Bill Statement: $120.00' }, // lowercase related_event_id
        { event_id: 'EVT_203', description: 'Total Due: GBP 60.00' },                // uses 'event_id' and 'description'
    ];

    const modifierMessages = [
        { text: 'Void EVT_204' },
        { text: 'EVT_204 amount changed to $999' }, // Conflicting modification
    ];

    const enriched = enrichEvents(rawEvents, rawImages, modifierMessages);

    assert(
        enriched.find((e) => e.event_id === 'EVT_204') === undefined,
        'Ensures event cancellation takes priority over amount override'
    );

    const evt202 = enriched.find((e) => e.event_id === 'EVT_202');
    assert(
        evt202 && evt202.amount === 120 && evt202.is_missing_resolved === true,
        'Resolves image OCR using fallback property name (raw_text) and lowercase keys'
    );

    const evt203 = enriched.find((e) => e.event_id === 'EVT_203');
    assert(
        evt203 && evt203.amount === 60 && evt203.is_missing_resolved === true,
        'Resolves image OCR using fallback property name (description)'
    );

    const evt205 = enriched.find((e) => e.event_id === 'EVT_205');
    assert(
        evt205 && evt205.amount === 0 && evt205.is_missing_resolved === false,
        'Defaults unresolved missing events to amount: 0 and is_missing_resolved: false'
    );

    // --- Summary ---
    console.log(`\n-----------------------------------`);
    console.log(`Test Execution Finished: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) process.exit(1);
}

runSuite();