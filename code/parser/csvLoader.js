import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const DATASET_DIR = path.resolve(process.cwd(), '../dataset');

export function readCsvFile(filename) {
    try {
        const csvPath = path.join(DATASET_DIR, filename);
        if (!fs.existsSync(csvPath)) return [];
        const fileContent = fs.readFileSync(csvPath, 'utf-8');
        if (!fileContent.trim()) return [];

        return parse(fileContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            bom: true,
            cast: (value, context) => {
                if (context.column.toString().endsWith('_id') || context.column.toString().includes('date')) {
                    return String(value);
                }
                if (value === '') return null;
                const num = Number(value);
                return isNaN(num) ? value : num;
            },
        });
    } catch (e) {
        console.error(`Error reading CSV ${filename}:`, e.message);
        return [];
    }
}

export function loadAllData() {
    const requests = readCsvFile('requests.csv');
    const sampleRequests = readCsvFile('sample_requests.csv');
    const profiles = readCsvFile('financial_profiles.csv');
    const events = readCsvFile('financial_events.csv');
    const paymentOptions = readCsvFile('request_payment_options.csv');
    const exchangeRates = readCsvFile('exchange_rates.csv');
    const messages = readCsvFile('messages.csv');
    const images = readCsvFile('images.csv');

    // Fast indexing via Maps
    const profilesMap = new Map(profiles.map((p) => [String(p.user_id), p]));

    const eventsByUserId = new Map();
    for (const e of events) {
        const uid = String(e.user_id);
        if (!eventsByUserId.has(uid)) eventsByUserId.set(uid, []);
        eventsByUserId.get(uid).push(e);
    }

    const optionsByRequestId = new Map();
    for (const opt of paymentOptions) {
        const rid = String(opt.request_id);
        if (!optionsByRequestId.has(rid)) optionsByRequestId.set(rid, []);
        optionsByRequestId.get(rid).push(opt);
    }

    return {
        requests,
        sampleRequests,
        profilesMap,
        events,
        eventsByUserId,
        paymentOptions,
        optionsByRequestId,
        exchangeRates,
        messages,
        images,
    };
}

export function getContextForRequest(allData, request) {
    const userId = String(request.user_id);
    const requestId = String(request.request_id);

    const userProfile = allData.profilesMap.get(userId) || null;
    const userEvents = allData.eventsByUserId.get(userId) || [];
    const userEventIds = new Set(userEvents.map((e) => String(e.event_id)));
    const optionsForRequest = allData.optionsByRequestId.get(requestId) || [];

    // Match messages by user_id, request_id, OR related_event_id
    const userMessages = allData.messages.filter(
        (m) =>
            String(m.user_id) === userId ||
            String(m.request_id) === requestId ||
            (m.related_event_id && userEventIds.has(String(m.related_event_id)))
    );

    // Match images by user_id, request_id, OR related_event_id
    const userImages = allData.images.filter(
        (i) =>
            String(i.user_id) === userId ||
            String(i.request_id) === requestId ||
            (i.related_event_id && userEventIds.has(String(i.related_event_id)))
    );

    return {
        request,
        userProfile,
        userEvents,
        optionsForRequest,
        userMessages,
        userImages,
    };
}