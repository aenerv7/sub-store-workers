import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
    migrateLegacyKv,
    StorageUnavailableError,
} from '../src/worker/storage.js';
import { getBackendPath, routeRequest } from '../src/worker/security.js';

describe('Worker security boundary', () => {
    it.each([
        '/api/utils/worker-status',
        '/api/preview/sub',
        '/api/sub/flow/missing',
        '/download/missing',
    ])('rejects an unprefixed protected route: %s', async (pathname) => {
        const response = await SELF.fetch(`https://example.com${pathname}`);
        expect(response.status).toBe(401);
    });

    it('fails closed when the backend path is missing', () => {
        const result = routeRequest(
            new Request('https://example.com/api/utils/env'),
            undefined,
        );
        expect(result.response.status).toBe(503);
    });

    it('normalizes a password-only backend path for share links', () => {
        expect(getBackendPath('test-secret')).toBe('/test-secret');
        const result = routeRequest(
            new Request('https://example.com/test-secret/api/utils/env'),
            'test-secret',
        );
        expect(result.pathname).toBe('/api/utils/env');
        expect(new URL(result.request.url).searchParams.get('share')).toBe('true');
    });

    it('allows browser requests from any origin', async () => {
        const response = await SELF.fetch('https://example.com/_health', {
            headers: { Origin: 'https://frontend.example' },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('allows preflight requests from any origin', async () => {
        const response = await SELF.fetch(
            'https://example.com/test-secret/api/utils/env',
            {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://frontend.example',
                    'Access-Control-Request-Method': 'GET',
                    'Access-Control-Request-Headers': 'Content-Type',
                },
            },
        );
        expect(response.status).toBe(204);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
            'Content-Type',
        );
    });

    it('keeps path authentication with public CORS', async () => {
        const response = await SELF.fetch(
            'https://example.com/api/utils/env',
            {
                headers: { Origin: 'https://frontend.example' },
            },
        );
        expect(response.status).toBe(401);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('does not expose secrets through the environment endpoint', async () => {
        const response = await SELF.fetch(
            'https://example.com/test-secret/api/utils/env',
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        const exposed = body.data.meta.worker.env;
        expect(exposed.SUB_STORE_BACKEND_CUSTOM_NAME).toBe('Workers Test');
        expect(exposed.SUB_STORE_FRONTEND_BACKEND_PATH).toBe('/test-secret');
        expect(exposed.SUB_STORE_PUSH_SERVICE).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain('private-token');
    });

    it('returns the normalized backend path for share-mode environment requests', async () => {
        const response = await SELF.fetch(
            'https://example.com/test-secret/api/utils/env',
        );
        const body = await response.json();
        expect(body.data.meta.worker.env.SUB_STORE_FRONTEND_BACKEND_PATH).toBe(
            '/test-secret',
        );
    });

    it('returns 404 for a route suffix instead of matching the root route', async () => {
        const response = await SELF.fetch('https://example.com/not-a-route');
        expect(response.status).toBe(404);
    });
});

describe('Durable Object state migration', () => {
    it('imports existing KV state on first access', async () => {
        await env.SUB_STORE_DATA.put(
            'sub-store',
            JSON.stringify({ settings: { migrationMarker: 'legacy-kv' } }),
        );
        await env.SUB_STORE_DATA.put('root', '{}');

        const coordinator = env.SUB_STORE_COORDINATOR.getByName(
            `migration-test-${crypto.randomUUID()}`,
        );
        const response = await coordinator.fetch(
            new Request('https://example.com/test-secret/api/storage'),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.settings.migrationMarker).toBe('legacy-kv');
    });

    it('does not write empty state when a KV read fails', async () => {
        const writes = [];
        const storage = {
            get: async () => undefined,
            put: async (value) => writes.push(value),
        };
        const brokenKv = {
            get: async () => {
                throw new Error('temporary KV outage');
            },
            put: async () => {},
        };

        await expect(migrateLegacyKv(storage, brokenKv)).rejects.toBeInstanceOf(
            StorageUnavailableError,
        );
        expect(writes).toEqual([]);
    });

    it('serializes count-limited share token consumption', async () => {
        const state = {
            settings: {},
            subs: [
                {
                    name: 'demo',
                    source: 'local',
                    content:
                        'demo = ss, 1.1.1.1, 443, encrypt-method=aes-128-gcm, password=test',
                },
            ],
            collections: [],
            files: [],
            artifacts: [],
            tokens: [
                {
                    type: 'sub',
                    name: 'demo',
                    token: 'single-use',
                    mode: 'count',
                    count: 1,
                    usedCount: 0,
                    createdAt: Date.now(),
                },
            ],
        };
        await env.SUB_STORE_DATA.put('sub-store', JSON.stringify(state));
        await env.SUB_STORE_DATA.put('root', '{}');

        const coordinator = env.SUB_STORE_COORDINATOR.getByName(
            `count-test-${crypto.randomUUID()}`,
        );
        const url =
            'https://example.com/share/sub/demo/JSON?token=single-use';
        const responses = await Promise.all([
            coordinator.fetch(new Request(url)),
            coordinator.fetch(new Request(url)),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([
            200,
            404,
        ]);
    });
});
