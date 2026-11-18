'use strict';

// A private, short-lived result from this source's temporary signing browser.
function createBrowserBootstrap(channel, bootstrap) {
    const invalid = () => new Error('TikTok browser setup is invalid or expired. Open the browser again.');
    const fresh = () => Number.isSafeInteger(bootstrap?.capturedAt) &&
        Date.now() - bootstrap.capturedAt >= -5000 && Date.now() - bootstrap.capturedAt <= 60000;
    let payload;
    try {
        const source = bootstrap?.payload;
        if (bootstrap?.channel !== channel || !fresh() || source?.identity !== 'audience' ||
            typeof source.room_id !== 'string' || !/^\d{1,30}$/.test(source.room_id)) throw invalid();
        const referer = 'https://www.tiktok.com/@' + channel + '/live';
        if (source.referer !== referer || (source.activeUrl !== undefined && source.activeUrl !== referer)) throw invalid();
        if (typeof source.userAgent !== 'string' || !source.userAgent || source.userAgent.length > 1024 ||
            /[\r\n\0]/.test(source.userAgent) || typeof source.allCookies !== 'string' ||
            source.allCookies.length > 16384 || /[\r\n\0]/.test(source.allCookies)) throw invalid();
        const body = source.fetchResult?.bodyBase64;
        if (source.fetchResult?.status !== 200 || typeof body !== 'string' || !body || body.length > 2796204 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw invalid();
        const bytes = Buffer.from(body, 'base64');
        if (bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== body) throw invalid();
        const response = require('tiktok-live-connector').ProtoMessageFetchResult.decode(bytes);
        const socket = new URL(response.pushServer);
        if (socket.protocol !== 'wss:' || socket.username || socket.password || socket.hash ||
            (socket.port && socket.port !== '443') ||
            !/^webcast-ws[a-z0-9-]*\.(tiktok\.com|tiktokv\.com)$/.test(socket.hostname) ||
            !socket.pathname.startsWith('/webcast/im/') || !response.cursor || !response.internalExt) throw invalid();
        payload = { room_id: source.room_id, identity: 'audience', referer, activeUrl: referer,
            userAgent: source.userAgent, allCookies: source.allCookies,
            fetchResult: { ok: true, status: 200, bodyBase64: body } };
    } catch (_) { throw invalid(); }
    // Do not retain the caller's object or allow it to extend the lifetime.
    const capturedAt = bootstrap.capturedAt;
    bootstrap = { capturedAt };
    return {
        async sign(url, options) {
            if (!payload || !fresh() || options?.uniqueId !== channel || options.performFetch !== true ||
                url !== 'https://webcast.tiktok.com/webcast/im/fetch/?identity=audience') throw invalid();
            const result = payload;
            payload = null;
            return result;
        },
        clear() { payload = null; }
    };
}

module.exports = { createBrowserBootstrap };
