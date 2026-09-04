const PUBLIC_SUB_STORE_ENV_KEYS = new Set([
    'SUB_STORE_BACKEND_CUSTOM_ICON',
    'SUB_STORE_BACKEND_CUSTOM_NAME',
]);

export function getPublicWorkerEnv(workerEnv = {}) {
    const exposed = {};
    for (const key of PUBLIC_SUB_STORE_ENV_KEYS) {
        if (typeof workerEnv[key] === 'string') {
            exposed[key] = workerEnv[key];
        }
    }
    return exposed;
}
