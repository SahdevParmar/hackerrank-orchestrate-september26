// code/dataset/loader.js
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

/**
 * Load every participant CSV from <repoRoot>/dataset/.
 * Paths are resolved relative to the repo root passed in, NOT process.cwd().
 *
 * Returns:
 *   requests         Array<row>            — sorted by request_id
 *   requestsById     Map<request_id, row>
 *   profilesMap      Map<user_id, row>
 *   eventsByUser     Map<user_id, Array<event>>   — sorted by settlement_date
 *   eventById        Map<event_id, event>
 *   optionsByRequest Map<request_id, Array<option>>
 *   messagesByUser   Map<user_id, Array<message>>
 *   imagesByEvent    Map<event_id, image_id>
 *   imagesByRequest  Map<request_id, image_id>
 *   rates            { convert(amount, from, to, date) }
 *   meta             { ratesRaw, missingRates: [] }
 */
export function loadDataset(repoRoot) {
    const dsDir = resolve(repoRoot, 'dataset');

    const requests = readCsv(resolve(dsDir, 'requests.csv'));
    const profiles = readCsv(resolve(dsDir, 'financial_profiles.csv'));
    const events = readCsv(resolve(dsDir, 'financial_events.csv'));
    const options = readCsv(resolve(dsDir, 'request_payment_options.csv'));
    const messages = readCsv(resolve(dsDir, 'messages.csv'));
    const images = readCsv(resolve(dsDir, 'images.csv'));
    const ratesRaw = readCsv(resolve(dsDir, 'exchange_rates.csv'));

    // ---- indexes -----------------------------------------------------------
    const requestsById = new Map();
    for (const r of requests) requestsById.set(r.request_id, r);

    const profilesMap = new Map();
    for (const p of profiles) profilesMap.set(p.user_id, p);

    const eventsByUser = new Map();
    const eventById = new Map();
    for (const e of events) {
        eventById.set(e.event_id, e);
        if (!eventsByUser.has(e.user_id)) eventsByUser.set(e.user_id, []);
        eventsByUser.get(e.user_id).push(e);
    }
    for (const [uid, list] of eventsByUser) {
        list.sort((a, b) => {
            const da = a.settlement_date || a.event_date;
            const db = b.settlement_date || b.event_date;
            if (da !== db) return da < db ? -1 : 1;
            return a.event_id < b.event_id ? -1 : 1;
        });
    }

    const optionsByRequest = new Map();
    for (const o of options) {
        if (!optionsByRequest.has(o.request_id)) optionsByRequest.set(o.request_id, []);
        optionsByRequest.get(o.request_id).push(o);
    }

    const messagesByUser = new Map();
    for (const m of messages) {
        if (!messagesByUser.has(m.user_id)) messagesByUser.set(m.user_id, []);
        messagesByUser.get(m.user_id).push(m);
    }

    const imagesByEvent = new Map();
    const imagesByRequest = new Map();
    for (const img of images) {
        if (img.related_event_id) imagesByEvent.set(img.related_event_id, img.image_id);
        if (img.request_id) imagesByRequest.set(img.request_id, img.image_id);
    }

    // ---- FX ----------------------------------------------------------------
    const rates = buildRates(ratesRaw);

    // ---- image-amount resolution ------------------------------------------
    // Any event whose amount is blank MUST have its amount resolved before
    // forecast. We attempt resolution here using a precomputed OCR cache
    // (code/dataset/image_amounts.json), which is produced separately by
    // code/dataset/ocr.js. If an amount can't be resolved, we leave it blank
    // and let the forecaster report it as unresolved.
    const amountCache = loadAmountCache(resolve(repoRoot, 'code', 'dataset', 'image_amounts.json'));
    for (const e of events) {
        if (e.amount === '' || e.amount == null) {
            const imgId = imagesByEvent.get(e.event_id);
            if (imgId && amountCache[imgId] != null) {
                const n = Number(amountCache[imgId]);
                if (Number.isFinite(n) && n > 0 && n < 1e12) {
                    e.amount = String(n);
                } else {
                    console.warn(`loader: rejecting implausible OCR amount ${amountCache[imgId]} for ${e.event_id} (${imgId})`);
                }
            }
        }
    }

    return {
        requests: requests.sort((a, b) => a.request_id.localeCompare(b.request_id)),
        requestsById,
        profilesMap,
        eventsByUser,
        eventById,
        optionsByRequest,
        messagesByUser,
        imagesByEvent,
        imagesByRequest,
        rates,
    };
}

// ---- helpers --------------------------------------------------------------

function readCsv(path) {
    if (!existsSync(path)) {
        throw new Error(`loader: missing ${path}`);
    }
    const raw = readFileSync(path, 'utf8');
    return parse(raw, {
        columns: true,
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true,
        trim: false,
    });
}

function loadAmountCache(path) {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * FX lookup. Matches by (from, to) and rate_date on-or-before the target
 * date. Falls back to inverse direction. Throws on missing rate — we do
 * NOT silently return the raw amount (that was the original currency.js bug).
 */
function buildRates(rows) {
    // byPair: Map<"FROM>TO", Array<{date, rate}> sorted by date asc>
    const byPair = new Map();
    for (const r of rows) {
        const key = `${r.from_currency}>${r.to_currency}`;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push({ date: r.rate_date, rate: Number(r.rate) });
    }
    for (const [, list] of byPair) {
        list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    function lookup(from, to, date) {
        if (from === to) return 1;

        const direct = byPair.get(`${from}>${to}`);
        if (direct) {
            const r = pickOnOrBefore(direct, date);
            if (r != null) return r;
        }

        const inv = byPair.get(`${to}>${from}`);
        if (inv) {
            const r = pickOnOrBefore(inv, date);
            if (r != null && r !== 0) return 1 / r;
        }

        return null;
    }

    function pickOnOrBefore(sorted, date) {
        // binary search: largest date <= target
        let lo = 0, hi = sorted.length - 1, best = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].date <= date) { best = sorted[mid].rate; lo = mid + 1; }
            else hi = mid - 1;
        }
        return best;
    }

    return {
        convert(amount, from, to, date) {
            const rate = lookup(from, to, date);
            if (rate == null) {
                throw new Error(`no FX rate ${from}->${to} on/before ${date}`);
            }
            return Number(amount) * rate;
        },
    };
}