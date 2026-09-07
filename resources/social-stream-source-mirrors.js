'use strict';

// Only mirror canonical project assets. Custom source URLs keep their own origin.
function getSocialStreamSourceUrls(remoteUrl) {
    let url;
    try { url = new URL(remoteUrl); } catch (_) { return [remoteUrl]; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return [remoteUrl];
    const match = url.hostname === 'raw.githubusercontent.com'
        && url.pathname.match(/^\/steveseguin\/social_stream\/(main|beta)\/(.+)$/);
    if (!match) return [remoteUrl];
    const [, branch, asset] = match;
    const suffix = `${asset}${url.search}`;
    return [
        `https://cache.socialstream.ninja/${branch === 'beta' ? 'beta/' : ''}${suffix}`,
        `https://${branch === 'beta' ? 'beta.' : ''}socialstream.ninja/${suffix}`,
        remoteUrl,
    ];
}

module.exports = { getSocialStreamSourceUrls };
