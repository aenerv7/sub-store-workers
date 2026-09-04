import { version as substoreVersion } from '../../../Sub-Store/backend/package.json';
import { ENV } from '@/vendor/open-api';
import { getPublicWorkerEnv } from '@/utils/public-env';

const {
    isNode,
    isQX,
    isLoon,
    isSurge,
    isStash,
    isShadowRocket,
    isLanceX,
    isEgern,
    isGUIforCores,
    isWorker,
} = ENV();

let backend = 'Workers';

let meta = {
    worker: {
        runtime: 'Cloudflare Workers',
    },
};
let feature = {};

const envObj = {
    backend,
    version: substoreVersion,
    feature,
    meta,
    isNode,
    isQX,
    isLoon,
    isSurge,
    isStash,
    isShadowRocket,
    isLanceX,
    isEgern,
    isGUIforCores,
    isWorker,
};

// 只向前端暴露显示用途的变量，路径密码和推送 URL 必须留在 Worker 内部。
Object.defineProperty(meta, 'worker', {
    get() {
        const workerEnv = globalThis.__workerEnv || {};
        return {
            runtime: 'Cloudflare Workers',
            env: getPublicWorkerEnv(workerEnv),
        };
    },
    enumerable: true,
    configurable: true,
});

export default envObj;
