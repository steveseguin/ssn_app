'use strict';

// Explicit HTTPS origins only: no wildcards, credentials, paths or implicit defaults.
function normalizeMissingOriginRule(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const parseOrigins = values => {
        if (!Array.isArray(values) || !values.length) return null;
        const origins = [];
        for (const entry of values) {
            if (typeof entry !== 'string') return null;
            try {
                const url = new URL(entry);
                if (url.protocol !== 'https:' || url.username || url.password
                    || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) return null;
                origins.push(url.origin);
            } catch (_) { return null; }
        }
        return origins;
    };
    const pageOrigins = parseOrigins(value.pageOrigins);
    const requestOrigins = parseOrigins(value.requestOrigins);
    if (!pageOrigins || !requestOrigins || !Array.isArray(value.methods) || !value.methods.length) return null;
    if (!value.methods.every(method => typeof method === 'string' && /^[A-Z]+$/.test(method))) return null;
    if (value.includePopups !== undefined && typeof value.includePopups !== 'boolean') return null;
    return { pageOrigins, requestOrigins, methods: [...value.methods], includePopups: value.includePopups === true };
}

function applyMissingOriginRule(headers, details, pageUrl, rule) {
    if (!rule || !rule.methods.includes(details.method)
        || Object.keys(headers).some(key => key.toLowerCase() === 'origin')) return;
    try {
        const pageOrigin = new URL(pageUrl).origin;
        const requestOrigin = new URL(details.url).origin;
        if (rule.pageOrigins.includes(pageOrigin) && rule.requestOrigins.includes(requestOrigin)) {
            headers.Origin = pageOrigin;
        }
    } catch (_) { }
}

module.exports = { normalizeMissingOriginRule, applyMissingOriginRule };
