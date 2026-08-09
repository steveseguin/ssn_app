import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createTestEnv(overrides = {}) {
  const values = new Map();
  return {
    STATE_ENCRYPTION_SECRET: "local-test-secret-at-least-16-characters",
    TWITCH_CLIENT_ID: "test-client",
    TWITCH_CLIENT_SECRET: "test-secret",
    ALLOWED_RETURN_ORIGINS: "http://localhost:8181,https://socialstream.ninja",
    TWITCH_APP_TOKEN_CACHE: {
      async get(key) {
        return values.get(key) || null;
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
    ...overrides,
  };
}

test("Twitch OAuth requests chat-send permission", async () => {
  const config = fs.readFileSync(path.join(projectDir, "wrangler.toml"), "utf8");
  const configuredScopes = config.match(/^TWITCH_SCOPES\s*=\s*"([^"]+)"/m)?.[1] || "";
  assert.ok(configuredScopes.split(/\s+/).includes("user:write:chat"));

  const response = await worker.fetch(
    new Request(
      "https://sso.socialstream.ninja/auth/twitch/start" +
        "?return_to=http%3A%2F%2Flocalhost%3A8181%2Fsources%2Fwebsocket%2Ftwitch.html%3Fssapp%3D1"
    ),
    {
      STATE_ENCRYPTION_SECRET: "local-test-secret-at-least-16-characters",
      TWITCH_CLIENT_ID: "test-client",
      TWITCH_SCOPES: configuredScopes,
      ALLOWED_RETURN_ORIGINS: "http://localhost:8181",
    }
  );

  assert.equal(response.status, 302);
  const authUrl = new URL(response.headers.get("location"));
  assert.equal(authUrl.hostname, "id.twitch.tv");
  assert.ok((authUrl.searchParams.get("scope") || "").split(" ").includes("user:write:chat"));
  assert.ok((authUrl.searchParams.get("scope") || "").split(" ").includes("channel:bot"));
  assert.equal(authUrl.searchParams.has("force_verify"), false);
});

test("Twitch bot OAuth is separate, minimal, and forces reauthorization", async () => {
  const response = await worker.fetch(
    new Request(
      "https://sso.socialstream.ninja/auth/twitch/start" +
        "?purpose=bot&return_to=http%3A%2F%2Flocalhost%3A8181%2Fsources%2Fwebsocket%2Ftwitch.html%3Fssapp%3D1"
    ),
    createTestEnv()
  );

  assert.equal(response.status, 302);
  const authUrl = new URL(response.headers.get("location"));
  assert.deepEqual((authUrl.searchParams.get("scope") || "").split(" "), ["user:write:chat", "user:bot"]);
  assert.equal(authUrl.searchParams.get("force_verify"), "true");
});

test("Twitch OAuth callback works when the browser does not return the session cookie", async () => {
  const env = createTestEnv();
  const response = await worker.fetch(
    new Request(
      "https://sso.socialstream.ninja/auth/twitch/start" +
        "?purpose=bot&return_to=http%3A%2F%2Flocalhost%3A8181%2Fsources%2Fwebsocket%2Ftwitch.html%3Fssapp%3D1"
    ),
    env
  );

  const authUrl = new URL(response.headers.get("location"));
  const state = authUrl.searchParams.get("state");
  assert.ok(state);
  assert.match(state, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const callbackUrl = new URL("https://sso.socialstream.ninja/auth/twitch/callback");
  callbackUrl.searchParams.set("state", state);
  callbackUrl.searchParams.set("error", "access_denied");
  callbackUrl.searchParams.set("error_description", "Cancelled in the callback test");

  const callbackResponse = await worker.fetch(new Request(callbackUrl), env);
  assert.equal(callbackResponse.status, 302);

  const returnUrl = new URL(callbackResponse.headers.get("location"));
  assert.equal(returnUrl.origin, "http://localhost:8181");
  assert.equal(returnUrl.pathname, "/sources/websocket/twitch.html");
  const errorPayload = JSON.parse(Buffer.from(
    new URLSearchParams(returnUrl.hash.slice(1)).get("twitch_auth_error"),
    "base64url"
  ).toString("utf8"));
  assert.equal(errorPayload.type, "ssn-twitch-auth-error");
  assert.equal(errorPayload.purpose, "bot");
  assert.equal(errorPayload.message, "Cancelled in the callback test");
});

test("Twitch bot sending uses the validated bot identity and source-only delivery", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/oauth2/validate")) {
      return Response.json({
        client_id: "test-client",
        login: "ssnhelperbot",
        user_id: "222",
        scopes: ["user:write:chat", "user:bot"],
      });
    }
    if (url.includes("/oauth2/token")) {
      return Response.json({ access_token: "app-token", expires_in: 3600, token_type: "bearer" });
    }
    if (url.includes("/helix/chat/messages")) {
      return Response.json({ data: [{ message_id: "message-1", is_sent: true }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = createTestEnv();
    const createSendRequest = (message) => new Request("https://sso.socialstream.ninja/auth/twitch/chat/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer bot-user-token",
          "Content-Type": "application/json",
          Origin: "https://socialstream.ninja",
        },
        body: JSON.stringify({
          broadcaster_id: "111",
          sender_id: "untrusted-value",
          message,
          for_source_only: false,
        }),
      });
    const response = await worker.fetch(createSendRequest("Hello from the bot"), env);
    const secondResponse = await worker.fetch(createSendRequest("Hello again"), env);

    assert.equal(response.status, 200);
    assert.equal(secondResponse.status, 200);
    const sendCall = calls.find((call) => call.url.includes("/helix/chat/messages"));
    assert.ok(sendCall);
    assert.equal(sendCall.init.headers.Authorization, "Bearer app-token");
    assert.deepEqual(JSON.parse(sendCall.init.body), {
      broadcaster_id: "111",
      sender_id: "222",
      message: "Hello from the bot",
      for_source_only: true,
    });
    assert.equal(calls.filter((call) => call.url.includes("/oauth2/token")).length, 1, "App token was not reused from KV");
    assert.equal(calls.filter((call) => call.url.includes("/helix/chat/messages")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Twitch bot sending rejects tokens without official bot scopes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    client_id: "test-client",
    login: "regular-user",
    user_id: "222",
    scopes: ["user:write:chat"],
  });

  try {
    const response = await worker.fetch(
      new Request("https://sso.socialstream.ninja/auth/twitch/chat/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer user-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ broadcaster_id: "111", message: "Hello" }),
      }),
      createTestEnv()
    );
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /user:bot/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
