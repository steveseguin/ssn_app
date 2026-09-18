'use strict';

// Diagnostic for the unresolved 2.4.x compatibility issue. No real credentials
// or remote requests: the actual connector bootstrap stops at its provider route.
const assert = require('assert');
const connector = require('tiktok-live-connector');
const { createTikTokEnvironment } = require('../../tiktok/connection-manager');

async function run() {
	let localSignerCalls = 0;
	const environment = createTikTokEnvironment({
		connector, connectionStates: new Map(), getMainWindow: () => null,
		localSigner: { sign: async () => { localSignerCalls++; throw new Error('Fixture local signer reached'); } },
	});
	const manager = new environment.ConnectionManager('ssapp_fixture', 9981, 'fixture-session', 'useast1a', {
		signingProvider: 'local',
	});
	manager.initializeConnectionInstance();
	const connection = manager.connection;
	const before = await connection.webClient.cookieJar.getSessionBundle();
	manager.updateSessionCredentialsFromSigner({ sessionid: 'fixture-session', tt_target_idc: 'useast1a' });
	const after = await connection.webClient.cookieJar.getSessionBundle();
	assert.strictEqual(before, null, 'Update diagnostic if constructor credential handling is repaired');
	assert.strictEqual(after, null, 'Update diagnostic if signer credential handling is repaired');

	// Positive control proves the installed library does accept the same dummy
	// credentials when supplied using its current public session shape.
	const control = new connector.TikTokLiveConnection('ssapp_fixture', {
		session: { cookie: { type: 'cookie', value: { sessionId: 'fixture-session', ttTargetIdc: 'useast1a' } } },
	});
	assert.ok(await control.webClient.cookieJar.getSessionBundle());

	const originalRoute = connector.RouteConfig.fetchSignedWebSocketFromProvider;
	let providerCalls = 0;
	const stop = new Error('SSAPP_FIXTURE_STOP_BEFORE_NETWORK');
	connector.RouteConfig.fetchSignedWebSocketFromProvider = async () => { providerCalls++; throw stop; };
	try {
		// Explicit room ID avoids lookup; Local Signer already disables room/gift
		// preflight. This exercises the installed connect/_connect unchanged.
		await assert.rejects(connection.connect('123456'), error => error === stop);
		assert.strictEqual(localSignerCalls, 0);
		assert.strictEqual(providerCalls, 1);
		console.log(JSON.stringify({
			connectorVersion: require('tiktok-live-connector/package.json').version,
			outcome: 'REPRODUCED',
			managerHasCredentials: !!manager.sessionId && !!manager.ttTargetIdc,
			connectorHasCredentials: !!before,
			connectorHasCredentialsAfterSignerUpdate: !!after,
			currentSessionShapeWorks: true,
			localSignerCalls,
			defaultProviderCalls: providerCalls,
			remoteRequests: 0,
		}, null, 2));
	} finally {
		connector.RouteConfig.fetchSignedWebSocketFromProvider = originalRoute;
		manager.disconnect();
	}
}

run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
