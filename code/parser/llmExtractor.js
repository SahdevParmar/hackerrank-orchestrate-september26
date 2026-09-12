// Enforce word boundaries around text currency codes to avoid matching inside words like "Order" or "Server"
const CURRENCY_PREFIX = /(?:(?:\b(?:USD|EUR|INR|IDR|ZAR|GBP|Rp|Rs\.?|R)\b)|[\$€£₹])\s*/i;
const AMOUNT_BODY = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.\d+|-?\d+/;

/**
 * Extracts numeric monetary amount from raw OCR text with date & percentage masking.
 * @param {string} text
 * @returns {number|null}
 */
export function extractAmountFromText(text) {
    if (text == null) return null;
    const raw = String(text).trim();
    if (!raw) return null;

    // Mask out dates (YYYY-MM-DD, DD/MM/YYYY, etc.) and percentages (e.g. 15%)
    const masked = raw
        .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ')
        .replace(/\d+(?:\.\d+)?\s*%/g, ' ');

    // 1. Match explicit currency symbol/code prefix first
    const currencyPrefixed = new RegExp(`${CURRENCY_PREFIX.source}(${AMOUNT_BODY.source})`, 'gi');
    const prefixed = firstMatch(masked, currencyPrefixed);
    if (prefixed != null) return parseMoney(prefixed);

    // 2. Match standard decimal or comma-formatted numbers
    const groupedOrDecimal = /(?<![\w.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.\d+)(?![\d.])/g;
    const grouped = firstMatch(masked, groupedOrDecimal);
    if (grouped != null) return parseMoney(grouped);

    return null;
}

function firstMatch(text, regex) {
    const match = regex.exec(text);
    return match ? match[1] : null;
}

function parseMoney(token) {
    const value = Number(String(token).replace(/,/g, ''));
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parses user messages to find event cancellations or amount corrections.
 * @param {Array<Object>} messages
 * @returns {{ cancelledEventIds: Set<string>, amountOverrides: Map<string, number> }}
 */
export function parseMessageModifiers(messages = []) {
    const cancelledEventIds = new Set();
    const amountOverrides = new Map();

    for (const msg of messages) {
        const text = String(msg.message_text || msg.text || msg.content || '').toLowerCase();
        if (!text) continue;

        // Detect cancellations: cancel, void, drop, delete, ignore, skip
        const cancelMatch = text.match(/(?:cancel|cancelled|ignore|void|delete|remove|drop|skip)\s*(?:event|transaction)?\s*([a-z0-9_-]+)/i);
        if (cancelMatch && cancelMatch[1]) {
            cancelledEventIds.add(cancelMatch[1].toUpperCase());
        }

        // Detect amount overrides
        const overrideMatch = text.match(/(?:event|transaction|change)?\s*([a-z0-9_-]+)\b[^0-9\n\r]*?\b(?:amount|is|updated|changed|set|to|=)\b[^0-9\n\r]*?\$?\s*(\d+(?:\.\d{1,2})?)/i);
        if (overrideMatch && overrideMatch[1] && overrideMatch[2]) {
            const eventId = overrideMatch[1].toUpperCase();
            const amount = parseFloat(overrideMatch[2]);
            if (!isNaN(amount)) {
                amountOverrides.set(eventId, amount);
            }
        }
    }

    return { cancelledEventIds, amountOverrides };
}

/**
 * Enriches financial events by resolving missing amounts from images and applying message modifications.
 * @param {Array<Object>} events
 * @param {Array<Object>} images
 * @param {Array<Object>} messages
 * @returns {Array<Object>}
 */
export function enrichEvents(events = [], images = [], messages = []) {
    const imageByEventId = new Map();
    for (const img of images) {
        const key = String(img.related_event_id || img.event_id || '').toUpperCase();
        if (key) imageByEventId.set(key, img);
    }

    const { cancelledEventIds, amountOverrides } = parseMessageModifiers(messages);

    return events
        .map((event) => {
            const eventId = String(event.event_id || '').toUpperCase();

            if (cancelledEventIds.has(eventId)) {
                return null;
            }

            let finalAmount = event.amount != null && event.amount !== '' ? Number(event.amount) : null;

            if (amountOverrides.has(eventId)) {
                finalAmount = amountOverrides.get(eventId);
            }

            if (finalAmount == null || isNaN(finalAmount) || finalAmount <= 0) {
                const matchingImage = imageByEventId.get(eventId);
                if (matchingImage) {
                    const ocrText = matchingImage.ocr_text || matchingImage.raw_text || matchingImage.description || matchingImage.text || '';
                    const extracted = extractAmountFromText(ocrText);
                    if (extracted != null) {
                        finalAmount = extracted;
                    }
                }
            }

            return {
                ...event,
                amount: finalAmount ?? 0,
                is_missing_resolved: finalAmount != null && finalAmount > 0,
            };
        })
        .filter(Boolean);
}