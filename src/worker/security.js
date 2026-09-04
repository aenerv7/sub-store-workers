const DEFAULT_ALLOWED_ORIGINS = [
    'https://sub-store.vercel.app',
    'http://substore.stash',
    'https://substore.stash',
];

export function getBackendPath(value) {
    if (
        typeof value !== 'string' ||
        value.length < 2 ||
        !value.startsWith('/') ||
        value.endsWith('/')
    ) {
        return null;
    }
    return value;
}

export function routeRequest(request, configuredBackendPath) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const backendPath = getBackendPath(configuredBackendPath);
    const isProtected = /^\/(api|download)(\/|$)/.test(pathname);
    const isPublic =
        pathname === '/' ||
        pathname === '/_health' ||
        /^\/share(\/|$)/.test(pathname);

    if (backendPath && pathname === backendPath) {
        return {
            response: new Response(null, {
                status: 302,
                headers: { Location: new URL(`${backendPath}/`, url).toString() },
            }),
        };
    }

    if (backendPath && pathname.startsWith(`${backendPath}/`)) {
        url.pathname = pathname.slice(backendPath.length) || '/';
        if (url.pathname.startsWith('/api/')) {
            url.searchParams.set('share', 'true');
        }
        return {
            request: new Request(url.toString(), request),
            pathname: url.pathname,
        };
    }

    if (isPublic || !isProtected) {
        return { request, pathname };
    }

    if (!backendPath) {
        return {
            response: jsonResponse(503, {
                status: 'failed',
                message: 'SUB_STORE_FRONTEND_BACKEND_PATH is missing or invalid',
            }),
        };
    }

    return {
        response: jsonResponse(401, {
            status: 'failed',
            message: 'Unauthorized',
        }),
    };
}

export function isOriginAllowed(request, env) {
    const origin = request.headers.get('Origin');
    if (!origin) return true;
    return getAllowedOrigins(env).has(origin);
}

export function applyCors(response, request, env) {
    const origin = request.headers.get('Origin');
    if (origin && getAllowedOrigins(env).has(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        appendVary(response.headers, 'Origin');
    }
    response.headers.set(
        'Access-Control-Expose-Headers',
        'Content-Disposition, Profile-Web-Page-Url, Subscription-Userinfo',
    );
    return response;
}

export function preflightResponse(request, env) {
    if (!isOriginAllowed(request, env)) {
        return jsonResponse(403, {
            status: 'failed',
            message: 'CORS origin not allowed',
        });
    }
    const response = new Response(null, { status: 204 });
    const origin = request.headers.get('Origin');
    if (origin) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        appendVary(response.headers, 'Origin');
    }
    response.headers.set(
        'Access-Control-Allow-Methods',
        'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT',
    );
    response.headers.set(
        'Access-Control-Allow-Headers',
        request.headers.get('Access-Control-Request-Headers') || 'Content-Type',
    );
    response.headers.set('Access-Control-Max-Age', '86400');
    return response;
}

export function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
}

function getAllowedOrigins(env) {
    const configured = env.SUB_STORE_CORS_ALLOWED_ORIGINS;
    const origins = configured
        ? configured.split(',').map((value) => value.trim()).filter(Boolean)
        : DEFAULT_ALLOWED_ORIGINS;
    return new Set(origins.filter((origin) => origin !== '*'));
}

function appendVary(headers, value) {
    const current = headers.get('Vary');
    const values = new Set(
        (current || '').split(',').map((item) => item.trim()).filter(Boolean),
    );
    values.add(value);
    headers.set('Vary', [...values].join(', '));
}
