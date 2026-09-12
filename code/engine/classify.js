// Maps raw financial_events.csv rows to a normalized internal shape.
// Confirmed real columns:
// event_id,user_id,event_type,description,category,direction,amount,currency,
// event_date,settlement_date,status,linked_event_id,flexibility,minimum_allowed_amount

const DEBIT_TYPES = new Set(['expense', 'debt_payment', 'subscription']);
const CREDIT_TYPES = new Set(['income', 'refund']);
const NONCASH_TYPES = new Set(['investment_valuation']);

// Statuses that mean "ignore for cash-flow forecasting".
const IGNORE_STATUS = new Set(['failed', 'cancelled', 'unrealized']);

// Statuses that are future/committed and must be reserved or counted.
const RESERVED_DEBIT_STATUS = new Set(['pending', 'scheduled']);
const COUNTED_CREDIT_STATUS = new Set(['settled', 'scheduled']); // pending credits NOT counted

export function classifyEvent(e) {
    const type = String(e.event_type || '').toLowerCase();
    const dir = String(e.direction || '').toLowerCase();
    const status = String(e.status || '').toLowerCase();

    let kind = 'unknown';
    if (DEBIT_TYPES.has(type)) kind = 'debit';
    else if (CREDIT_TYPES.has(type)) kind = 'credit';
    else if (NONCASH_TYPES.has(type)) kind = 'noncash';
    // fallback to direction
    if (kind === 'unknown') {
        if (dir === 'debit') kind = 'debit';
        else if (dir === 'credit') kind = 'credit';
        else if (dir === 'non_cash') kind = 'noncash';
    }

    return {
        eventId: String(e.event_id),
        userId: String(e.user_id),
        kind,                 // debit | credit | noncash | unknown
        status,               // settled|pending|scheduled|failed|cancelled|unrealized
        eventType: type,
        direction: dir,
        category: String(e.category || ''),
        flexibility: String(e.flexibility || ''), // fixed|stoppable|reducible|reducible_or_stoppable|''
        minimumAllowedAmount: e.minimum_allowed_amount != null ? Number(e.minimum_allowed_amount) : null,
        linkedEventId: e.linked_event_id ? String(e.linked_event_id) : null,
        currency: String(e.currency || ''),
        amount: e.amount != null ? Number(e.amount) : null, // null means blank → resolve via image
        eventDate: String(e.event_date || ''),
        settlementDate: String(e.settlement_date || e.event_date || ''),
        description: String(e.description || ''),
    };
}

export function isIgnorable(ev) { return IGNORE_STATUS.has(ev.status); }
export function isReservedDebit(ev) { return ev.kind === 'debit' && RESERVED_DEBIT_STATUS.has(ev.status); }
export function isCountedCredit(ev) { return ev.kind === 'credit' && COUNTED_CREDIT_STATUS.has(ev.status); }

export function classifyAll(events) {
    return events.map(classifyEvent);
}