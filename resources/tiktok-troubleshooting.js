'use strict';

// Shared by the TikTok connector and its UI. Reports use selected status fields,
// never a serialized source, settings object, signing payload or network log.
function sanitizeTikTokDiagnosticText(value, source = null) {
    let text = typeof value === 'string' ? value : '';
    const secrets = [];
    function collect(object, depth = 0) {
        if (!object || typeof object !== 'object' || depth > 5) return;
        for (const [key, item] of Object.entries(object)) {
            if (typeof item === 'string' && item && /token|cookie|session.?id|target.?idc|api.?key|jwt|password|secret|signature|authorization/i.test(key)) {
                secrets.push(item, encodeURIComponent(item));
            } else if (item && typeof item === 'object') {
                collect(item, depth + 1);
            }
        }
    }
    collect(source);
    for (const secret of secrets.sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[redacted]');
    }
    return text
        .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[URL removed]')
        .replace(/\b(cookie|set-cookie|authorization)\s*[:=][^\r\n]*/gi, '$1=[redacted]')
        .replace(/(["']?\b(?:api[_-]?key|jwt(?:key)?|session[_-]?id|tt[_-]?target[_-]?idc|msToken|token|password|secret|signature)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
        .replace(/\b(?:Bearer\s+\S+|euler_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, '[redacted]')
        .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
        .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n<>"']+/g, '[path removed]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim().slice(0, 600);
}

function describeTikTokDisconnect(code, reason = '', credentials = null) {
    const descriptions = {
        1000: 'TikTok connection closed.',
        1011: 'Euler reported an internal server error.',
        4005: 'The TikTok live stream ended.',
        4006: 'Euler closed the connection because no messages arrived.',
        4400: 'Euler rejected the username or connection options.',
        4401: 'Euler rejected the API key or JWT. Check the selected credentials.',
        4403: 'The Euler credentials do not grant access to this creator.',
        4404: 'Euler reports that this creator is not live.',
        4429: 'Euler connection or request limit reached.',
        4500: 'TikTok closed the upstream connection.',
        4555: 'The Euler connection reached its lifetime limit.',
        4556: 'Euler could not fetch TikTok webcast data.',
        4557: 'Euler could not fetch the TikTok room information.'
    };
    const detail = sanitizeTikTokDiagnosticText(reason, credentials);
    const description = descriptions[code] || (code ? `TikTok connection closed (code ${code}).` : 'TikTok connection lost.');
    return detail && !/^[A-Z_]+$/.test(detail) ? `${description} ${detail}` : description;
}

function isGenericTikTokFailure(value) {
    return typeof value !== 'string' || !value.trim() || /^(?:connection (?:lost|failed|error)|TikTok connection lost|unknown)[.!]?$/i.test(value.trim());
}

module.exports = { sanitizeTikTokDiagnosticText, describeTikTokDisconnect, isGenericTikTokFailure };
