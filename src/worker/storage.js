const STATE_KEYS = ['sub-store', 'root'];

export class StorageUnavailableError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'StorageUnavailableError';
    }
}

function normalizeStoredJson(raw, key) {
    if (raw == null) return '{}';
    if (typeof raw !== 'string') {
        throw new StorageUnavailableError(
            `Stored value for ${key} is not a JSON string`,
        );
    }

    try {
        const value = JSON.parse(raw);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('expected a JSON object');
        }
    } catch (error) {
        throw new StorageUnavailableError(
            `Stored value for ${key} is invalid JSON`,
            error,
        );
    }
    return raw;
}

/**
 * Import the two legacy KV documents before the Durable Object becomes
 * authoritative. Reads complete before the first write, so a failed KV read
 * can never initialize empty state over existing data.
 */
export async function migrateLegacyKv(storage, kv) {
    const currentEntries = await Promise.all(
        STATE_KEYS.map(async (key) => [key, await storage.get(key)]),
    );
    const missingKeys = currentEntries
        .filter(([, value]) => value === undefined)
        .map(([key]) => key);

    if (missingKeys.length === 0) return false;
    if (!kv?.get || !kv?.put) {
        throw new StorageUnavailableError(
            'Missing KV binding: SUB_STORE_DATA',
        );
    }

    let legacyEntries;
    try {
        legacyEntries = await Promise.all(
            missingKeys.map(async (key) => [key, await kv.get(key, 'text')]),
        );
    } catch (error) {
        throw new StorageUnavailableError(
            'Unable to read legacy state from SUB_STORE_DATA',
            error,
        );
    }

    const imported = Object.fromEntries(
        legacyEntries.map(([key, raw]) => [key, normalizeStoredJson(raw, key)]),
    );
    try {
        await storage.put(imported);
    } catch (error) {
        throw new StorageUnavailableError(
            'Unable to initialize Durable Object storage',
            error,
        );
    }
    return true;
}

export function createStateStore(storage, kv, ctx) {
    return {
        async get(key) {
            try {
                const value = await storage.get(key);
                return value === undefined ? null : value;
            } catch (error) {
                throw new StorageUnavailableError(
                    `Unable to read ${key} from Durable Object storage`,
                    error,
                );
            }
        },

        async putMany(entries) {
            try {
                await storage.put(entries);
            } catch (error) {
                throw new StorageUnavailableError(
                    'Unable to persist Durable Object state',
                    error,
                );
            }

            for (const [key, value] of Object.entries(entries)) {
                ctx.waitUntil(
                    kv.put(key, value).catch((error) => {
                        console.error(
                            JSON.stringify({
                                event: 'kv_mirror_failed',
                                key,
                                error: error?.message ?? String(error),
                            }),
                        );
                    }),
                );
            }
        },
    };
}
