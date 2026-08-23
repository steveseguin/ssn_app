#!/usr/bin/env node

'use strict';

const assert = require('node:assert');
const diagnostics = require('../../resources/llm-request-diagnostics');

function run() {
	diagnostics.resetForTesting();
	assert.strictEqual(diagnostics.begin({ url: 'https://example.com/' }), null);

	const apiKey = 'sk-proj-ssapp-diagnostic-secret-that-must-not-leak';
	const prompt = 'private prompt that must not be captured';
	const pathSecret = 'sk-proj-path-secret-that-must-not-leak';
	const userInfoSecret = 'userinfo-secret-that-must-not-leak';
	const handle = diagnostics.begin({
		url: `https://diagnostic-user:${userInfoSecret}@llm.example/${pathSecret}/v1/chat/completions?private=query-value#fragment-secret`,
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}` },
		body: {
			model: 'gpt-5.4-mini',
			messages: [{ role: 'user', content: prompt }],
			stream: false,
		},
		diagnostics: { kind: 'llm', provider: 'chatgpt', model: 'gpt-5.4-mini' },
	});
	assert.ok(handle);
	assert.match(handle.entry.clientRequestId, /^[0-9a-f-]{36}$/i);

	diagnostics.complete(handle, {
		status: 401,
		headers: {
			'X-Request-Id': 'req_ssapp_diagnostic',
			'OpenAI-Organization': 'org_ssapp_diagnostic',
			'OpenAI-Project': 'proj_ssapp_diagnostic',
			Authorization: `Bearer ${apiKey}`,
			'Set-Cookie': 'private-cookie',
		},
		body: JSON.stringify({
			error: {
				message: `Missing scope: model.request. ${prompt} ${apiKey}`,
				type: 'invalid_request_error',
				code: 'missing_scope',
			},
		}),
	});

	const recent = diagnostics.getRecent();
	assert.strictEqual(recent.length, 1);
	assert.strictEqual(recent[0].provider, 'chatgpt');
	assert.strictEqual(recent[0].model, 'gpt-5.4-mini');
	assert.strictEqual(recent[0].endpoint, 'https://llm.example');
	assert.strictEqual(recent[0].credential.type, 'project-api-key');
	assert.strictEqual(recent[0].credential.fingerprint.length, 12);
	assert.strictEqual(recent[0].status, 401);
	assert.strictEqual(recent[0].responseHeaders['x-request-id'], 'req_ssapp_diagnostic');
	assert.strictEqual(recent[0].responseHeaders['openai-organization'], 'org_ssapp_diagnostic');
	assert.strictEqual(recent[0].responseHeaders['openai-project'], 'proj_ssapp_diagnostic');
	assert.strictEqual(Object.prototype.hasOwnProperty.call(recent[0].responseHeaders, 'set-cookie'), false);
	assert.deepStrictEqual(recent[0].error, {
		code: 'missing_scope',
		type: 'invalid_request_error',
		param: null,
		missingScope: 'model.request',
	});

	const serialized = JSON.stringify(recent);
	assert.strictEqual(serialized.includes(apiKey), false);
	assert.strictEqual(serialized.includes(prompt), false);
	assert.strictEqual(serialized.includes(pathSecret), false);
	assert.strictEqual(serialized.includes(userInfoSecret), false);
	assert.strictEqual(serialized.includes('query-value'), false);
	assert.strictEqual(serialized.includes('fragment-secret'), false);
	assert.strictEqual(serialized.includes('private-cookie'), false);

	const cancelled = diagnostics.begin({
		url: 'https://llm.example/v1/chat/completions',
		method: 'POST',
		body: { model: 'cancelled-model', stream: true },
		diagnostics: { kind: 'llm', provider: 'custom' },
	});
	diagnostics.cancel(cancelled);
	assert.strictEqual(
		diagnostics.getRecent().some(entry => entry.model === 'cancelled-model'),
		false,
		'user-cancelled streams must not consume a recent diagnostic slot'
	);

	for (let index = 0; index < 12; index += 1) {
		diagnostics.begin({
			url: 'http://127.0.0.1/llm',
			method: 'POST',
			body: { model: `model-${index}`, stream: true },
			diagnostics: { kind: 'llm', provider: 'custom' },
		});
	}
	assert.strictEqual(diagnostics.getRecent().length, 10);

	console.log('LLM request diagnostic privacy and coverage checks passed.');
}

try {
	run();
} catch (error) {
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
}
