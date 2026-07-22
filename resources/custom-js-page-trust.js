'use strict';

const TRUSTED_SOCIAL_STREAM_HOSTNAMES = new Set([
	'127.0.0.1',
	'localhost',
	'socialstream.ninja',
	'cache.socialstream.ninja',
	'beta.socialstream.ninja'
]);

const STANDALONE_CUSTOM_JS_PAGE_PATTERN = /(?:^|\/)(dock|featured|bot)\.html$/i;

/**
 * Return the supported standalone page type only when the URL belongs to a
 * trusted Social Stream location.
 * @param {string|URL|object} locationValue URL string, URL, or Location-like object.
 * @returns {string} dock, featured, bot, or an empty string.
 */
function getTrustedStandaloneCustomJsPageType(locationValue) {
	let parsed;
	try {
		const href = typeof locationValue === 'string'
			? locationValue
			: locationValue && typeof locationValue.href === 'string'
				? locationValue.href
				: String(locationValue || '');
		parsed = new URL(href);
	} catch (_) {
		return '';
	}

	const protocol = String(parsed.protocol || '').toLowerCase();
	if (protocol !== 'file:') {
		if (protocol !== 'http:' && protocol !== 'https:') return '';
		const hostname = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
		if (!TRUSTED_SOCIAL_STREAM_HOSTNAMES.has(hostname)) return '';
	}

	const match = String(parsed.pathname || '').match(STANDALONE_CUSTOM_JS_PAGE_PATTERN);
	return match ? match[1].toLowerCase() : '';
}

module.exports = {
	getTrustedStandaloneCustomJsPageType
};
