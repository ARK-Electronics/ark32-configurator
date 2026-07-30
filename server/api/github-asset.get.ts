/**
 * Proxy GitHub release assets so the browser can fetch firmware without CORS issues.
 * Only allows github.com / objects.githubusercontent.com / release-assets.githubusercontent.com
 */
const ALLOWED_HOSTS = new Set([
    'github.com',
    'www.github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com'
]);

export default defineEventHandler(async (event) => {
    const query = getQuery(event);
    const raw = query.url?.toString();

    if (!raw) {
        throw createError({
            statusCode: 400,
            statusMessage: 'url query parameter required'
        });
    }

    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        throw createError({
            statusCode: 400,
            statusMessage: 'invalid url'
        });
    }

    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
        throw createError({
            statusCode: 400,
            statusMessage: 'url host not allowed'
        });
    }

    const headers: Record<string, string> = {
        'User-Agent': 'am32-configurator',
        Accept: 'application/octet-stream'
    };

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token && target.hostname.includes('github')) {
        headers.Authorization = `Bearer ${token}`;
    }

    const upstream = await fetch(target.toString(), {
        headers,
        redirect: 'follow'
    });

    if (!upstream.ok) {
        throw createError({
            statusCode: upstream.status === 404 ? 404 : 502,
            statusMessage: `upstream failed: ${upstream.status}`
        });
    }

    const contentType =
        upstream.headers.get('content-type') || 'application/octet-stream';
    const disposition = upstream.headers.get('content-disposition');
    const body = Buffer.from(await upstream.arrayBuffer());

    setResponseHeader(event, 'Content-Type', contentType);
    setResponseHeader(event, 'Content-Length', body.byteLength);
    if (disposition) {
        setResponseHeader(event, 'Content-Disposition', disposition);
    }
    // Short cache — firmware assets are immutable per URL
    setResponseHeader(event, 'Cache-Control', 'public, max-age=3600');

    return body;
});
