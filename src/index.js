/** Sub-Store Workers 入口 */

import { DurableObject } from 'cloudflare:workers';
import { version as workersVersion } from '../package.json';
import { version as substoreVersion } from '../../Sub-Store/backend/package.json';
const version = `${substoreVersion}(w${workersVersion})`;
import $ from '@/core/app';
import { StateDataError } from '@/vendor/open-api';
import express from '@/vendor/express';
import migrate from '@/utils/migration';

import registerSubscriptionRoutes from '@/restful/subscriptions';
import registerCollectionRoutes from '@/restful/collections';
import registerArtifactRoutes from '@/restful/artifacts';
import registerFileRoutes from '@/restful/file';
import registerTokenRoutes from '@/restful/token';
import registerArchiveRoutes from '@/restful/archives';
import registerModuleRoutes from '@/restful/module';
import registerSyncRoutes from '@/restful/sync';
import registerDownloadRoutes from '@/restful/download';
import registerSettingRoutes from '@/restful/settings';
import registerPreviewRoutes from '@/restful/preview';
import registerSortingRoutes from '@/restful/sort';
import registerMiscRoutes from '@/restful/miscs';
import registerNodeInfoRoutes from '@/restful/node-info';
import registerParserRoutes from '@/restful/parser';
import registerLogRoutes from '@/restful/logs';
import registerAgeRoutes from '@/restful/age';

import { produceArtifact } from '@/restful/sync';
import { syncToGist } from '@/restful/artifacts';
import { gistBackupAction } from '@/restful/miscs';
import { consumeShareToken } from '@/restful/token';
import { SETTINGS_KEY, ARTIFACTS_KEY, SUBS_KEY, COLLECTIONS_KEY } from '@/constants';
import { findByName } from '@/utils/database';
import {
    createStateStore,
    migrateLegacyKv,
    StorageUnavailableError,
} from '@/worker/storage';
import {
    applyCors,
    isOriginAllowed,
    jsonResponse,
    preflightResponse,
    routeRequest,
} from '@/worker/security';

// 初始化应用及路由
const $app = express({ substore: $ });

registerCollectionRoutes($app);
registerSubscriptionRoutes($app);
registerDownloadRoutes($app);
registerPreviewRoutes($app);
registerSortingRoutes($app);
registerSettingRoutes($app);
registerArtifactRoutes($app);
registerFileRoutes($app);
registerTokenRoutes($app);
registerArchiveRoutes($app);
registerModuleRoutes($app);
registerSyncRoutes($app);
registerNodeInfoRoutes($app);
registerMiscRoutes($app);
registerParserRoutes($app);
registerLogRoutes($app);
registerAgeRoutes($app);

const COORDINATOR_NAME = 'primary';

export class SubStoreCoordinator extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.queue = Promise.resolve();
        this.stateStore = null;
    }

    fetch(request) {
        return this.enqueue(async () => {
            const stateStore = await this.getStateStore();
            return handleRequest(request, this.env, this.ctx, stateStore);
        });
    }

    runScheduled() {
        return this.enqueue(async () => {
            const stateStore = await this.getStateStore();
            await initializeApplication(this.env, stateStore);
            try {
                await cronSyncArtifacts(this.env);
                await commitApplicationState(this.ctx);
            } catch (error) {
                $.discardPendingPushes();
                throw error;
            }
        });
    }

    enqueue(operation) {
        const result = this.queue.then(operation, operation);
        this.queue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    async getStateStore() {
        if (!this.stateStore) {
            await migrateLegacyKv(this.ctx.storage, this.env.SUB_STORE_DATA);
            this.stateStore = createStateStore(
                this.ctx.storage,
                this.env.SUB_STORE_DATA,
                this.ctx,
            );
        }
        return this.stateStore;
    }
}

export default {
    async scheduled(_event, env, ctx) {
        const bindingError = validateBindings(env);
        if (bindingError) {
            console.error(bindingError.message);
            return;
        }
        ctx.waitUntil(getCoordinator(env).runScheduled());
    },

    async fetch(request, env) {
        const bindingError = validateBindings(env);
        if (bindingError) return bindingError.response;
        return getCoordinator(env).fetch(request);
    },
};

async function handleRequest(originalRequest, env, ctx, stateStore) {
    let request = originalRequest;
    let initialized = false;
    try {
        const routed = routeRequest(request, env.SUB_STORE_FRONTEND_BACKEND_PATH);
        if (routed.response) return applyCors(routed.response, request, env);
        request = routed.request;
        const pathname = routed.pathname;

        if (!isOriginAllowed(request, env)) {
            return jsonResponse(403, {
                status: 'failed',
                message: 'CORS origin not allowed',
            });
        }
        if (request.method === 'OPTIONS') {
            return preflightResponse(request, env);
        }

        await initializeApplication(env, stateStore);
        initialized = true;

        if (pathname === '/_health') {
            return commitResponse(
                jsonResponse(200, {
                    status: 'ok',
                    version,
                    storage: 'durable-object',
                }),
                request,
                env,
                ctx,
            );
        }

        console.log(
            JSON.stringify({
                event: 'request',
                version,
                method: request.method,
                pathname,
            }),
        );

        if (pathname.startsWith('/share/')) {
            const shareError = validateShareRequest(request, pathname);
            if (shareError) {
                return commitResponse(shareError, request, env, ctx);
            }
            request = applyInvalidShareFallback(request, pathname);
            if (!request) {
                return commitResponse(
                    jsonResponse(404, {
                        status: 'failed',
                        message: 'Invalid or expired share token',
                    }),
                    originalRequest,
                    env,
                    ctx,
                );
            }
        }

        const response = await $app.handleRequest(request);
        return commitResponse(response, request, env, ctx);
    } catch (error) {
        $.discardPendingPushes();
        const unavailable =
            error instanceof StorageUnavailableError ||
            error instanceof StateDataError;
        console.error(
            JSON.stringify({
                event: unavailable ? 'storage_unavailable' : 'request_failed',
                error: error?.message ?? String(error),
                stack: error?.stack,
            }),
        );
        const response = jsonResponse(unavailable ? 503 : 500, {
            status: 'failed',
            message: unavailable
                ? 'Storage temporarily unavailable'
                : 'Internal Server Error',
        });
        return applyCors(response, originalRequest, env);
    } finally {
        if (!initialized) $.discardPendingPushes();
    }
}

async function initializeApplication(env, stateStore) {
    globalThis.__workerEnv = env;
    await $.initFromStorage(stateStore);
    $.workerEnv = env;
    migrate();
}

async function commitResponse(response, request, env, ctx) {
    await commitApplicationState(ctx);
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    response.headers.set('CDN-Cache-Control', 'no-store');
    return applyCors(response, request, env);
}

async function commitApplicationState(ctx) {
    await $.persistCache();
    const pushes = $.drainPendingPushes();
    if (pushes.length > 0) ctx.waitUntil(Promise.allSettled(pushes));
}

function validateShareRequest(request, pathname) {
    if (request.method.toUpperCase() !== 'GET') {
        return jsonResponse(405, {
            status: 'failed',
            message: 'Method not allowed',
        });
    }
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
        return jsonResponse(403, {
            status: 'failed',
            message: 'Share token is required',
        });
    }
    return null;
}

function applyInvalidShareFallback(request, pathname) {
    const token = new URL(request.url).searchParams.get('token');
    const shareToken = consumeShareToken({
        token,
        pathname: decodeURIComponent(pathname),
    });
    if (shareToken) return request;

    const settings = $.read(SETTINGS_KEY);
    if (!settings?.appearanceSetting?.invalidShareFakeNode) return null;
    const fakeUrl = new URL(request.url);
    fakeUrl.pathname = pathname.replace(/\/share\/.*?\//, '/share/sub/');
    fakeUrl.searchParams.set('_fakeNode', 'true');
    return new Request(fakeUrl.toString(), request);
}

function getCoordinator(env) {
    return env.SUB_STORE_COORDINATOR.getByName(COORDINATOR_NAME);
}

function validateBindings(env) {
    const missing = [];
    if (!env?.SUB_STORE_DATA?.get || !env?.SUB_STORE_DATA?.put) {
        missing.push('SUB_STORE_DATA');
    }
    if (!env?.SUB_STORE_COORDINATOR?.getByName) {
        missing.push('SUB_STORE_COORDINATOR');
    }
    if (missing.length === 0) return null;
    const message = `Missing Worker bindings: ${missing.join(', ')}`;
    return {
        message,
        response: jsonResponse(500, { status: 'failed', message }),
    };
}

/** 定时同步 artifacts 到 Gist */
async function cronSyncArtifacts(env) {
    try {
        console.log(`[Cron] Sub-Store Workers v${version} 开始同步...`);

        const settings = $.read(SETTINGS_KEY);
        if (!settings?.githubUser || !settings?.gistToken) {
            console.log('[Cron] 未配置 GitHub Token，跳过同步');
            return;
        }

        const allArtifacts = $.read(ARTIFACTS_KEY);
        if (!allArtifacts || allArtifacts.length === 0) {
            console.log('[Cron] 无 artifacts，跳过同步');
            return;
        }

        const shouldSync = allArtifacts.some((a) => a.sync);
        if (!shouldSync) {
            console.log('[Cron] 无需同步的配置');
            return;
        }

        // 收集需要同步的订阅名
        const allSubs = $.read(SUBS_KEY);
        const allCols = $.read(COLLECTIONS_KEY);
        const subNames = [];
        let enabledCount = 0;

        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source) {
                enabledCount++;
                if (artifact.type === 'subscription') {
                    const sub = findByName(allSubs, artifact.source);
                    if (sub?.url && !subNames.includes(artifact.source)) {
                        subNames.push(artifact.source);
                    }
                } else if (artifact.type === 'collection') {
                    const col = findByName(allCols, artifact.source);
                    if (col?.subscriptions) {
                        for (const sn of col.subscriptions) {
                            const sub = findByName(allSubs, sn);
                            if (sub?.url && !subNames.includes(sn)) {
                                subNames.push(sn);
                            }
                        }
                    }
                }
            }
        }

        if (enabledCount === 0) {
            console.log('[Cron] 无启用同步的配置');
            return;
        }

        // 预生成订阅缓存
        if (subNames.length > 0) {
            await Promise.all(
                subNames.map(async (name) => {
                    try {
                        await produceArtifact({ type: 'subscription', name, awaitCustomCache: true });
                    } catch (e) { /* 忽略 */ }
                }),
            );
        }

        // 生成所有 artifacts
        const files = {};
        const valid = [];
        const invalid = [];

        await Promise.all(
            allArtifacts.map(async (artifact) => {
                try {
                    if (!artifact.sync || !artifact.source) return;
                    console.log(`[Cron] 正在同步：${artifact.name}...`);

                    const output = await produceArtifact({
                        type: artifact.type,
                        name: artifact.source,
                        platform: artifact.platform,
                        produceOpts: {
                            'include-unsupported-proxy': artifact.includeUnsupportedProxy,
                            useMihomoExternal: artifact.platform === 'SurgeMac',
                            prettyYaml: artifact.prettyYaml,
                        },
                    });

                    files[encodeURIComponent(artifact.name)] = { content: output };
                    valid.push(artifact.name);
                } catch (e) {
                    console.error(`[Cron] 生成 ${artifact.name} 失败: ${e.message ?? e}`);
                    invalid.push(artifact.name);
                }
            }),
        );

        console.log(`[Cron] 成功 ${valid.length} 个，失败 ${invalid.length} 个`);

        if (valid.length === 0) {
            console.error('[Cron] 全部失败，跳过上传');
            return;
        }

        // 上传到 Gist
        const resp = await syncToGist(files);
        const body = JSON.parse(resp.body);

        // 更新 artifact URL
        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source && valid.includes(artifact.name)) {
                artifact.updated = new Date().getTime();
                let gistFiles = body.files;
                let isGitLab;
                if (Array.isArray(gistFiles)) {
                    isGitLab = true;
                    gistFiles = Object.fromEntries(gistFiles.map((item) => [item.path, item]));
                }
                const raw_url = gistFiles[encodeURIComponent(artifact.name)]?.raw_url;
                artifact.url = isGitLab ? raw_url : raw_url?.replace(/\/raw\/[^/]*\/(.*)/, '/raw/$1');
            }
        }

        $.write(allArtifacts, ARTIFACTS_KEY);

        // Gist 备份上传
        try {
            console.log('[Cron] 上传 Gist 备份...');
            await gistBackupAction('upload');
            console.log('[Cron] Gist 备份完成');
        } catch (e) {
            console.error(`[Cron] Gist 备份失败: ${e.message ?? e}`);
        }

        console.log('[Cron] 同步完成');
    } catch (e) {
        console.error(`[Cron] 同步失败: ${e.message ?? e}`);
        throw e;
    }
}
