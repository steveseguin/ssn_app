'use strict';

const vm = require('node:vm');
const { getSocialStreamSourceUrls } = require('./social-stream-source-mirrors');

/** Fetch complete, parseable classic scripts before allowing any execution. */
async function fetchBackgroundScript(urlValue, fetchFn) {
    const url = new URL(urlValue);
    const hosts = ['cache.socialstream.ninja', 'socialstream.ninja', 'beta.socialstream.ninja'];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password
        || !url.pathname.endsWith('.js') || /%2f|%5c|%2e/i.test(url.pathname)) {
        throw new Error('Unsupported background script URL');
    }
    const beta = url.hostname === 'beta.socialstream.ninja' || url.pathname.startsWith('/beta/');
    const relative = url.pathname.replace(/^\/(?:beta\/)?/, '');
    const candidates = getSocialStreamSourceUrls(`https://raw.githubusercontent.com/steveseguin/social_stream/${beta ? 'beta' : 'main'}/${relative}${url.search}`);
    const failures = [];
    for (const candidate of candidates) {
        const controller = new AbortController();
        let timer;
        try {
            const text = await Promise.race([
                (async () => {
                    const response = await fetchFn(candidate, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const body = await response.text();
                    if (!body.trim() || body.length > 8 * 1024 * 1024 || /^\s*</.test(body)
                        || /^\s*[\[{]/.test(body)) throw new Error('Empty, oversized, or non-JavaScript response');
                    // MIME labels and redirected filename extensions are not proof
                    // of executable content. Parse the actual complete response.
                    new vm.Script(body, { filename: candidate });
                    return body;
                })(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new Error('Script download timed out after 12 seconds'));
                    }, 12000);
                })
            ]);
            return { text, url: candidate, failures };
        } catch (error) {
            failures.push({ url: candidate, error: error.message });
            console.warn('[Background scripts]', candidate, error.message);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`Unable to load ${relative}: ${failures.map(item => item.error).join('; ')}`);
}

module.exports = { fetchBackgroundScript };
