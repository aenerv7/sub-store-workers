export function getBackendPath(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const path = value.trim();
    if (!path) return null;
    // Secrets are often entered as just the password. Normalize that form so
    // the Worker and the upstream share-link code use the same URL prefix.
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (normalized === '/' || normalized.endsWith('/') || normalized.includes('?') || normalized.includes('#')) {
        return null;
    }
    return normalized;
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

export function applyCors(response) {
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set(
        'Access-Control-Expose-Headers',
        'Content-Disposition, Profile-Web-Page-Url, Subscription-Userinfo',
    );
    return response;
}

export function preflightResponse(request) {
    const response = new Response(null, { status: 204 });
    response.headers.set('Access-Control-Allow-Origin', '*');
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
