'use strict';

function createStrategyResult(strategy, connected, latestStatus, initializeError) {
	const status = latestStatus && latestStatus.status ? latestStatus.status : null;
	const statusError = latestStatus && latestStatus.error
		? latestStatus.error.message || String(latestStatus.error)
		: null;
	const everConnected = Boolean(connected);
	const remainedConnected = everConnected && status === 'connected';
	return {
		strategy,
		connected: remainedConnected,
		everConnected,
		status,
		error: initializeError
			? initializeError.message || String(initializeError)
			: statusError || (!remainedConnected
				? (status ? `Connection ended with status: ${status}` : 'No connected status received')
				: null),
	};
}

function exitCodeForResults(results) {
	return Array.isArray(results) && results.length > 0 && results.every(result => result.connected) ? 0 : 1;
}

module.exports = {
	createStrategyResult,
	exitCodeForResults,
};
