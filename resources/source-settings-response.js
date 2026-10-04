'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

const APP_HOSTS = new Set(['socialstream.ninja', 'beta.socialstream.ninja', 'cache.socialstream.ninja']);

// Settings consumed by the capture scripts. Keep application credentials,
// webhook URLs and unrelated integration configuration out of page JavaScript.
const CAPTURE_SETTINGS = new Set([
    'allmemberchat', 'bttv', 'captureevents', 'capturejoinedevent', 'captureliketotals',
    'captureyoutubelikes', 'collecttwitchpoints',
    'customDonationThankYou', 'customdiscordchannel', 'customkickstate', 'customlivespaceaccount',
    'customlivespacestate', 'customriversidestate', 'customtiktokaccount', 'customtiktokstate',
    'customtwitchaccount', 'customtwitchstate', 'customyoutubeaccount', 'customyoutubestate',
    'dedupeKeepMs', 'dedupeMax', 'dedupeWindowMs', 'delaykick', 'delaytwitch', 'delayyoutube',
    'detweet', 'disableAutoLiveYoutube', 'disableYoutubeAutoScroll', 'disableYoutubeStaleReload',
    'discord', 'discordmemberships', 'excludeReplyingTo', 'facebook_username', 'ffz', 'flipYoutube',
    'groupSubscriberAlerts', 'hideMetrics', 'hidePaidPromotion', 'hidecertainbadges', 'hideevents', 'hostnamesext', 'hypemode',
    'ignorealternatives', 'ignorepartibacklog', 'kickchatroomscout', 'limitedtwitchmemberchat',
    'limitedyoutubememberchat', 'memberchatonly', 'myname', 'mynameext', 'nosubcolor',
    'notiktokdonations', 'pluralmind', 'seventv', 'sharestreamid', 'showsubscount',
    'showtwitchwatchstreaks', 'showviewercount', 'storeBSky', 'syncBlockUsers', 'syncDeleteMessages',
    'subscriberAlertMessages', 'textonlymode', 'tiktokdonations', 'translation', 'twichadannounce', 'twichadmute',
    'vdoninjadiscord', 'xcapture', 'youtubeAudioPicker', 'youtubeLargerFont'
]);

function parseUrl(value) {
    try { return new URL(String(value || '')); } catch (_) { return null; }
}

function isTrustedSettingsPage(value, localRoots = []) {
    const url = parseUrl(value);
    if (!url || url.username || url.password) return false;
    if (url.protocol === 'https:' && !url.port && APP_HOSTS.has(url.hostname)) return true;
    if (url.protocol !== 'file:') return false;
    try {
        const file = fileURLToPath(url);
        return localRoots.some(root => {
            if (!root) return false;
            const resolvedRoot = String(root).startsWith('file:') ? fileURLToPath(root) : root;
            const relative = path.relative(path.resolve(resolvedRoot), path.resolve(file));
            return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
        });
    } catch (_) { return false; }
}

function captureSettingsPayload(snapshot = {}, sourceUrl = '') {
    const settings = {};
    const source = snapshot.settings && typeof snapshot.settings === 'object' ? snapshot.settings : {};
    for (const key of CAPTURE_SETTINGS) {
        if (Object.prototype.hasOwnProperty.call(source, key)) settings[key] = source[key];
    }
    const url = parseUrl(sourceUrl);
    // Rumble's API fallback needs its own configured endpoint, not other sites'.
    if (url && url.protocol === 'https:' && (url.hostname === 'rumble.com' || url.hostname.endsWith('.rumble.com'))) {
        for (const key of ['rumble_api_url', 'rumble_stream_id']) {
            if (Object.prototype.hasOwnProperty.call(source, key)) settings[key] = source[key];
        }
    }
    const result = { settings, state: snapshot.state !== undefined ? snapshot.state : true };
    const shareId = source.sharestreamid === true || source.sharestreamid?.setting === true;
    if (shareId && url?.origin === 'https://maestro-launcher.vercel.app' && url.pathname === '/') {
        result.streamID = snapshot.streamID;
    }
    return result;
}

function filterSourceSettingsMessage(message, sourceUrl = '', trusted = false) {
    if (trusted || !message || typeof message !== 'object' || Array.isArray(message)) return message;
    const result = { ...message };
    delete result.password;
    delete result.streamID;
    if (Object.prototype.hasOwnProperty.call(message, 'settings')) {
        result.settings = captureSettingsPayload(message, sourceUrl).settings;
    }
    return result;
}

// Only source capture commands may cross from a page into the app controller.
// New controller commands must not become available to capture pages by default.
const CAPTURE_COMMANDS = new Set([
    'getSettings', 'getOnOffState', 'claimInstagramInboxPoller', 'filterInstagramInboxStories',
    'ebaySellerStats', 'resolveRumblePopupUrl', 'joystickFetchJson', 'vpzoneFetchJson',
    'rumbleFetchHtml', 'rumbleFetchJson', 'rumbleFetchSseBatch'
]);

function isCaptureCommandAllowed(message) {
    if (!message || typeof message !== 'object') return true;
    const request = message.type === 'toBackground' && message.data ? message.data : message;
    return !request.cmd || CAPTURE_COMMANDS.has(request.cmd);
}

module.exports = { captureSettingsPayload, filterSourceSettingsMessage, isTrustedSettingsPage, isCaptureCommandAllowed };
