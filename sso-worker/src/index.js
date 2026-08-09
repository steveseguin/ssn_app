const DEFAULT_VELORA_AUTH_URL = "https://velora.tv/oauth/authorize";
const DEFAULT_VELORA_TOKEN_URL = "https://api.velora.tv/api/developer/oauth/token";
const DEFAULT_VELORA_SCOPES = "user:read chat:read chat:write";
const DEFAULT_TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2/authorize";
const DEFAULT_TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const DEFAULT_TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const DEFAULT_TWITCH_CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";
const DEFAULT_TWITCH_BOT_SCOPES = ["user:write:chat", "user:bot"].join(" ");
const DEFAULT_TWITCH_SCOPES = [
  "chat:read",
  "chat:edit",
  "user:write:chat",
  "channel:bot",
  "bits:read",
  "moderator:read:followers",
  "moderator:read:chatters",
  "channel:read:subscriptions",
  "channel:read:hype_train",
  "channel:moderate",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
  "channel:manage:broadcast",
  "channel:read:ads",
  "channel:manage:ads",
  "channel:read:redemptions",
].join(" ");
const DEFAULT_YOUTUBE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_YOUTUBE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_YOUTUBE_CLIENT_ID = "689627108309-isbjas8fmbc7sucmbm7gkqjapk7btbsi.apps.googleusercontent.com";
const DEFAULT_YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.channel-memberships.creator",
  "https://www.googleapis.com/auth/youtube.force-ssl",
].join(" ");
const DEFAULT_YOUTUBE_LEGACY_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];
const DEFAULT_FACEBOOK_API_VERSION = "v25.0";
const DEFAULT_FACEBOOK_CLIENT_ID = "544418900508414";
const DEFAULT_FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
].join(" ");
const VELORA_AUTH_RESULT_KEY = "velora_auth_result";
const VELORA_AUTH_ERROR_KEY = "velora_auth_error";
const VELORA_AUTH_MESSAGE_SUCCESS = "ssn-velora-auth-success";
const VELORA_AUTH_MESSAGE_ERROR = "ssn-velora-auth-error";
const VELORA_OAUTH_COOKIE = "__ssn_velora_oauth";
const TWITCH_AUTH_RESULT_KEY = "twitch_auth_result";
const TWITCH_AUTH_ERROR_KEY = "twitch_auth_error";
const TWITCH_AUTH_MESSAGE_SUCCESS = "ssn-twitch-auth-success";
const TWITCH_AUTH_MESSAGE_ERROR = "ssn-twitch-auth-error";
const TWITCH_OAUTH_COOKIE = "__ssn_twitch_oauth";
const TWITCH_APP_TOKEN_CACHE_KEY_PREFIX = "twitch-app-token:";
const TWITCH_CHAT_MESSAGE_MAX_CODEPOINTS = 500;
const TWITCH_CHAT_REQUEST_MAX_BYTES = 4096;
const YOUTUBE_AUTH_RESULT_KEY = "youtube_auth_result";
const YOUTUBE_AUTH_ERROR_KEY = "youtube_auth_error";
const YOUTUBE_AUTH_MESSAGE_SUCCESS = "ssn-youtube-auth-success";
const YOUTUBE_AUTH_MESSAGE_ERROR = "ssn-youtube-auth-error";
const YOUTUBE_OAUTH_COOKIE = "__ssn_youtube_oauth";
const FACEBOOK_AUTH_RESULT_KEY = "facebook_auth_result";
const FACEBOOK_AUTH_ERROR_KEY = "facebook_auth_error";
const FACEBOOK_AUTH_MESSAGE_SUCCESS = "ssn-facebook-auth-success";
const FACEBOOK_AUTH_MESSAGE_ERROR = "ssn-facebook-auth-error";
const FACEBOOK_OAUTH_COOKIE = "__ssn_facebook_oauth";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      return jsonResponse(request, env, { error: error.message || "Internal server error" }, status);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (path === "/" || path === "/health") {
    return jsonResponse(request, env, {
      ok: true,
      service: "socialstream-sso",
      providers: ["velora", "twitch", "youtube", "facebook"],
    });
  }

  if (request.method === "GET" && (path === "/auth" || isRoute(path, "youtube", "auth"))) {
    return startYouTubeBridgeAuth(request, env);
  }

  if (request.method === "POST" && (path === "/token" || isRoute(path, "youtube", "token"))) {
    return handleYouTubeToken(request, env);
  }

  if (request.method === "POST" && (path === "/refresh" || isRoute(path, "youtube", "refresh"))) {
    return handleYouTubeRefresh(request, env);
  }

  if (request.method === "GET" && isRoute(path, "velora", "start")) {
    return startVeloraAuth(request, env);
  }

  if (request.method === "GET" && isRoute(path, "velora", "callback")) {
    return handleVeloraCallback(request, env);
  }

  if (request.method === "POST" && isRoute(path, "velora", "exchange")) {
    return handleVeloraExchange(request, env);
  }

  if (request.method === "POST" && isRoute(path, "velora", "refresh")) {
    return handleVeloraRefresh(request, env);
  }

  if (request.method === "GET" && isRoute(path, "twitch", "start")) {
    return startTwitchAuth(request, env);
  }

  if (request.method === "GET" && isRoute(path, "twitch", "callback")) {
    return handleTwitchCallback(request, env);
  }

  if (request.method === "POST" && isRoute(path, "twitch", "refresh")) {
    return handleTwitchRefresh(request, env);
  }

  if (request.method === "POST" && isRoute(path, "twitch", "chat/messages")) {
    return handleTwitchChatMessage(request, env);
  }

  if (request.method === "GET" && isRoute(path, "youtube", "start")) {
    return startYouTubeAuth(request, env);
  }

  if (request.method === "GET" && isRoute(path, "youtube", "callback")) {
    return handleYouTubeCallback(request, env);
  }

  if (request.method === "GET" && isRoute(path, "facebook", "start")) {
    return startFacebookAuth(request, env);
  }

  if (request.method === "GET" && isRoute(path, "facebook", "callback")) {
    return handleFacebookCallback(request, env);
  }

  if (request.method === "POST" && isRoute(path, "facebook", "exchange")) {
    return handleFacebookExchange(request, env);
  }

  if (request.method === "POST" && isRoute(path, "facebook", "deauthorize")) {
    return handleFacebookDeauthorize(request, env);
  }

  if (request.method === "POST" && isRoute(path, "facebook", "data-deletion")) {
    return handleFacebookDataDeletion(request, env);
  }

  if (request.method === "GET" && path === "/auth/facebook/data-deletion/status") {
    return handleFacebookDataDeletionStatus(request);
  }

  return jsonResponse(request, env, { error: "Not found" }, 404);
}

function normalizePath(pathname) {
  const normalized = String(pathname || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isRoute(path, provider, action) {
  return path === `/auth/${provider}/${action}` || path === `/${provider}/${action}`;
}

async function startVeloraAuth(request, env) {
  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get("return_to"), env);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const redirectUri = getVeloraRedirectUri(request, env);
  const nonce = randomBase64Url(16);
  const cookieValue = await encryptState(
    {
      provider: "velora",
      returnTo: returnTo.toString(),
      redirectUri,
      codeVerifier,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      nonce,
    },
    env
  );

  const authUrl = new URL(env.VELORA_AUTH_URL || DEFAULT_VELORA_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", getVeloraClientId(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", env.VELORA_SCOPES || DEFAULT_VELORA_SCOPES);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", nonce);

  return redirectResponse(authUrl, {
    "Set-Cookie": buildOAuthCookie(cookieValue, "velora"),
  });
}

async function handleVeloraCallback(request, env) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    throw new HttpError(400, "Missing OAuth state.");
  }

  const cookieValue = getCookie(request, VELORA_OAUTH_COOKIE);
  if (!cookieValue) {
    throw new HttpError(400, "Missing OAuth session cookie.");
  }

  const state = await decryptState(cookieValue, env);
  if (!state || state.provider !== "velora") {
    throw new HttpError(400, "Invalid OAuth state.");
  }
  if (state.nonce !== stateParam) {
    throw new HttpError(400, "OAuth state mismatch.");
  }
  if (!Number.isFinite(state.expiresAt) || Date.now() > state.expiresAt) {
    throw new HttpError(400, "Expired OAuth state.");
  }

  const returnTo = validateReturnTo(state.returnTo, env);
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirectWithPayload(returnTo, VELORA_AUTH_ERROR_KEY, {
      type: VELORA_AUTH_MESSAGE_ERROR,
      message: url.searchParams.get("error_description") || providerError,
    }, clearOAuthCookieHeaders("velora"));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return redirectWithPayload(returnTo, VELORA_AUTH_ERROR_KEY, {
      type: VELORA_AUTH_MESSAGE_ERROR,
      message: "Velora did not return an authorization code.",
    }, clearOAuthCookieHeaders("velora"));
  }

  let tokens;
  try {
    tokens = await exchangeVeloraCode(env, {
      code,
      codeVerifier: state.codeVerifier,
      redirectUri: state.redirectUri,
    });
  } catch (error) {
    return redirectWithPayload(returnTo, VELORA_AUTH_ERROR_KEY, {
      type: VELORA_AUTH_MESSAGE_ERROR,
      message: `Velora token exchange failed: ${error.message || "Unknown error"}`,
    }, clearOAuthCookieHeaders("velora"));
  }

  return redirectWithPayload(returnTo, VELORA_AUTH_RESULT_KEY, {
    type: VELORA_AUTH_MESSAGE_SUCCESS,
    tokens,
  }, clearOAuthCookieHeaders("velora"));
}

async function handleVeloraExchange(request, env) {
  const payload = await readJson(request);
  const code = stringValue(payload.code);
  const codeVerifier = stringValue(payload.code_verifier || payload.codeVerifier);
  const redirectUri = stringValue(payload.redirect_uri || payload.redirectUri || getVeloraRedirectUri(request, env));

  if (!code || !codeVerifier) {
    throw new HttpError(400, "Missing code or code_verifier.");
  }

  const tokens = await exchangeVeloraCode(env, { code, codeVerifier, redirectUri });
  return jsonResponse(request, env, tokens);
}

async function handleVeloraRefresh(request, env) {
  const payload = await readJson(request);
  const refreshToken = stringValue(payload.refresh_token || payload.refreshToken);
  if (!refreshToken) {
    throw new HttpError(400, "Missing refresh_token.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", getVeloraClientId(env));
  maybeSetClientSecret(body, env);
  body.set("refresh_token", refreshToken);

  const tokens = await postVeloraTokenRequest(env, body);
  return jsonResponse(request, env, tokens);
}

async function exchangeVeloraCode(env, options) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", getVeloraClientId(env));
  maybeSetClientSecret(body, env);
  body.set("code", options.code);
  body.set("code_verifier", options.codeVerifier);
  body.set("redirect_uri", options.redirectUri);
  return postVeloraTokenRequest(env, body);
}

async function startTwitchAuth(request, env) {
  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get("return_to"), env, "twitch");
  const redirectUri = getTwitchRedirectUri(request, env);
  const purpose = normalizeTwitchAuthPurpose(url.searchParams.get("purpose"));
  const nonce = randomBase64Url(16);
  const stateValue = await encryptState(
    {
      provider: "twitch",
      returnTo: returnTo.toString(),
      redirectUri,
      purpose,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      nonce,
    },
    env
  );

  const authUrl = new URL(env.TWITCH_AUTH_URL || DEFAULT_TWITCH_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", getTwitchClientId(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set(
    "scope",
    purpose === "bot" ? DEFAULT_TWITCH_BOT_SCOPES : env.TWITCH_SCOPES || DEFAULT_TWITCH_SCOPES
  );
  authUrl.searchParams.set("state", stateValue);
  if (purpose === "bot") {
    authUrl.searchParams.set("force_verify", "true");
  }

  return redirectResponse(authUrl, {
    "Set-Cookie": buildOAuthCookie(stateValue, "twitch"),
  });
}

async function handleTwitchCallback(request, env) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    throw new HttpError(400, "Missing OAuth state.");
  }

  const state = await readTwitchOAuthState(request, stateParam, env);
  if (!Number.isFinite(state.expiresAt) || Date.now() > state.expiresAt) {
    throw new HttpError(400, "Expired OAuth state.");
  }

  const returnTo = validateReturnTo(state.returnTo, env, "twitch");
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirectWithPayload(returnTo, TWITCH_AUTH_ERROR_KEY, {
      type: TWITCH_AUTH_MESSAGE_ERROR,
      purpose: state.purpose || "main",
      message: url.searchParams.get("error_description") || providerError,
    }, clearOAuthCookieHeaders("twitch"));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return redirectWithPayload(returnTo, TWITCH_AUTH_ERROR_KEY, {
      type: TWITCH_AUTH_MESSAGE_ERROR,
      purpose: state.purpose || "main",
      message: "Twitch did not return an authorization code.",
    }, clearOAuthCookieHeaders("twitch"));
  }

  let tokens;
  try {
    tokens = await exchangeTwitchCode(env, {
      code,
      redirectUri: state.redirectUri,
    });
  } catch (error) {
    return redirectWithPayload(returnTo, TWITCH_AUTH_ERROR_KEY, {
      type: TWITCH_AUTH_MESSAGE_ERROR,
      purpose: state.purpose || "main",
      message: `Twitch token exchange failed: ${error.message || "Unknown error"}`,
    }, clearOAuthCookieHeaders("twitch"));
  }

  return redirectWithPayload(returnTo, TWITCH_AUTH_RESULT_KEY, {
    type: TWITCH_AUTH_MESSAGE_SUCCESS,
    purpose: state.purpose || "main",
    tokens,
  }, clearOAuthCookieHeaders("twitch"));
}

async function readTwitchOAuthState(request, stateParam, env) {
  const embeddedState = await tryDecryptState(stateParam, env);
  if (embeddedState) {
    if (embeddedState.provider !== "twitch") {
      throw new HttpError(400, "Invalid OAuth state.");
    }
    return embeddedState;
  }

  // Keep accepting OAuth requests started by the previous Worker version,
  // where Twitch returned a nonce and the encrypted state lived in a cookie.
  const cookieValue = getCookie(request, TWITCH_OAUTH_COOKIE);
  if (!cookieValue) {
    throw new HttpError(400, "Missing OAuth session cookie.");
  }

  const cookieState = await tryDecryptState(cookieValue, env);
  if (!cookieState || cookieState.provider !== "twitch") {
    throw new HttpError(400, "Invalid OAuth state.");
  }
  if (cookieState.nonce !== stateParam) {
    throw new HttpError(400, "OAuth state mismatch.");
  }
  return cookieState;
}

async function handleTwitchRefresh(request, env) {
  const payload = await readJson(request);
  const refreshToken = stringValue(payload.refresh_token || payload.refreshToken);
  if (!refreshToken) {
    throw new HttpError(400, "Missing refresh_token.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", getTwitchClientId(env));
  maybeSetClientSecret(body, env, "twitch");
  body.set("refresh_token", refreshToken);

  const tokens = await postTwitchTokenRequest(env, body);
  return jsonResponse(request, env, tokens);
}

async function handleTwitchChatMessage(request, env) {
  const botUserToken = getBearerToken(request);
  if (!botUserToken) {
    throw new HttpError(401, "Missing Twitch bot authorization.");
  }

  const payload = await readJsonWithLimit(request, TWITCH_CHAT_REQUEST_MAX_BYTES);
  const broadcasterId = stringValue(payload.broadcaster_id || payload.broadcasterId);
  const message = typeof payload.message === "string" ? payload.message : "";

  if (!/^\d+$/.test(broadcasterId)) {
    throw new HttpError(400, "Missing or invalid broadcaster_id.");
  }
  if (!message.trim()) {
    throw new HttpError(400, "Message cannot be empty.");
  }
  if (Array.from(message).length > TWITCH_CHAT_MESSAGE_MAX_CODEPOINTS) {
    throw new HttpError(400, `Message exceeds ${TWITCH_CHAT_MESSAGE_MAX_CODEPOINTS} characters.`);
  }

  const botIdentity = await validateTwitchBotUserToken(botUserToken, env);
  let appToken = await getTwitchAppAccessToken(env);
  let twitchResult = await postTwitchChatMessage(env, appToken, {
    broadcasterId,
    senderId: botIdentity.user_id,
    message,
  });

  if (twitchResult.response.status === 401) {
    appToken = await getTwitchAppAccessToken(env, { forceRefresh: true });
    twitchResult = await postTwitchChatMessage(env, appToken, {
      broadcasterId,
      senderId: botIdentity.user_id,
      message,
    });
  }

  return jsonResponse(request, env, twitchResult.data, twitchResult.response.status);
}

async function validateTwitchBotUserToken(token, env) {
  const response = await fetch(env.TWITCH_VALIDATE_URL || DEFAULT_TWITCH_VALIDATE_URL, {
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw new HttpError(status, data.message || "Unable to validate the Twitch bot account.");
  }

  if (stringValue(data.client_id) !== getTwitchClientId(env)) {
    throw new HttpError(403, "The Twitch bot account was authorized for a different application.");
  }
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  const missingScopes = splitScopes(DEFAULT_TWITCH_BOT_SCOPES).filter((scope) => !scopes.includes(scope));
  if (missingScopes.length) {
    throw new HttpError(403, `The Twitch bot account is missing: ${missingScopes.join(", ")}.`);
  }
  if (!/^\d+$/.test(stringValue(data.user_id))) {
    throw new HttpError(403, "The Twitch bot authorization does not identify a user account.");
  }
  return data;
}

async function getTwitchAppAccessToken(env, options = {}) {
  const cache = env.TWITCH_APP_TOKEN_CACHE;
  if (!cache || typeof cache.get !== "function" || typeof cache.put !== "function") {
    throw new HttpError(503, "Twitch bot sending is not configured.");
  }

  const clientId = getTwitchClientId(env);
  const cacheKey = TWITCH_APP_TOKEN_CACHE_KEY_PREFIX + clientId;
  if (!options.forceRefresh) {
    try {
      const encrypted = await cache.get(cacheKey);
      if (encrypted) {
        const cached = await decryptState(encrypted, env);
        if (cached?.accessToken && Number(cached.expiresAt) > Date.now() + 60 * 1000) {
          return cached.accessToken;
        }
      }
    } catch (_) {
      // A missing or stale cache entry is safe to replace with a fresh app token.
    }
  }

  const clientSecret = stringValue(env.TWITCH_CLIENT_SECRET);
  if (!clientSecret) {
    throw new HttpError(503, "TWITCH_CLIENT_SECRET is not configured.");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  const tokenData = await postTwitchTokenRequest(env, body);
  const expiresIn = Math.max(60, Number(tokenData.expires_in) || 0);
  const expiresAt = Date.now() + expiresIn * 1000;
  const encrypted = await encryptState({ accessToken: tokenData.access_token, expiresAt }, env);
  try {
    await cache.put(cacheKey, encrypted, {
      expirationTtl: Math.max(60, Math.floor(expiresIn - 60)),
    });
  } catch (error) {
    console.warn("[Twitch bot] Unable to cache the app access token; this request will continue.", error?.message || error);
  }
  return tokenData.access_token;
}

async function postTwitchChatMessage(env, appToken, options) {
  const response = await fetch(env.TWITCH_CHAT_MESSAGES_URL || DEFAULT_TWITCH_CHAT_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Client-Id": getTwitchClientId(env),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: options.broadcasterId,
      sender_id: options.senderId,
      message: options.message,
      for_source_only: true,
    }),
  });
  const data = await response.json().catch(() => ({
    error: response.statusText || `Twitch chat send failed (HTTP ${response.status}).`,
  }));
  return { response, data };
}

async function exchangeTwitchCode(env, options) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", getTwitchClientId(env));
  maybeSetClientSecret(body, env, "twitch");
  body.set("code", options.code);
  body.set("redirect_uri", options.redirectUri);
  return postTwitchTokenRequest(env, body);
}

function startYouTubeBridgeAuth(request, env) {
  const url = new URL(request.url);
  const redirectUri = stringValue(url.searchParams.get("redirect_uri"));
  const state = stringValue(url.searchParams.get("state"));
  if (!redirectUri) {
    throw new HttpError(400, "Missing redirect_uri.");
  }

  const authUrl = new URL(env.YOUTUBE_AUTH_URL || DEFAULT_YOUTUBE_AUTH_URL);
  authUrl.searchParams.set("client_id", getYouTubeClientId(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", getYouTubeLegacyScopes(url.searchParams.get("scope")).join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  if (state) {
    authUrl.searchParams.set("state", state);
  }

  return redirectResponse(authUrl);
}

async function startYouTubeAuth(request, env) {
  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get("return_to"), env, "youtube");
  const redirectUri = getYouTubeRedirectUri(request, env);
  const nonce = randomBase64Url(16);
  const requestedScope = stringValue(url.searchParams.get("scope"));
  const cookieValue = await encryptState(
    {
      provider: "youtube",
      returnTo: returnTo.toString(),
      redirectUri,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      nonce,
      scope: requestedScope || null,
    },
    env
  );

  const authUrl = new URL(env.YOUTUBE_AUTH_URL || DEFAULT_YOUTUBE_AUTH_URL);
  authUrl.searchParams.set("client_id", getYouTubeClientId(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", getYouTubeScopes(env, requestedScope).join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", nonce);

  return redirectResponse(authUrl, {
    "Set-Cookie": buildOAuthCookie(cookieValue, "youtube"),
  });
}

async function handleYouTubeCallback(request, env) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    throw new HttpError(400, "Missing OAuth state.");
  }

  const cookieValue = getCookie(request, YOUTUBE_OAUTH_COOKIE);
  if (!cookieValue) {
    throw new HttpError(400, "Missing OAuth session cookie.");
  }

  const state = await decryptState(cookieValue, env);
  if (!state || state.provider !== "youtube") {
    throw new HttpError(400, "Invalid OAuth state.");
  }
  if (state.nonce !== stateParam) {
    throw new HttpError(400, "OAuth state mismatch.");
  }
  if (!Number.isFinite(state.expiresAt) || Date.now() > state.expiresAt) {
    throw new HttpError(400, "Expired OAuth state.");
  }

  const returnTo = validateReturnTo(state.returnTo, env, "youtube");
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirectWithPayload(returnTo, YOUTUBE_AUTH_ERROR_KEY, {
      type: YOUTUBE_AUTH_MESSAGE_ERROR,
      message: url.searchParams.get("error_description") || providerError,
    }, clearOAuthCookieHeaders("youtube"));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return redirectWithPayload(returnTo, YOUTUBE_AUTH_ERROR_KEY, {
      type: YOUTUBE_AUTH_MESSAGE_ERROR,
      message: "YouTube did not return an authorization code.",
    }, clearOAuthCookieHeaders("youtube"));
  }

  let tokens;
  try {
    tokens = await exchangeYouTubeCode(request, env, {
      code,
      redirectUri: state.redirectUri,
    });
  } catch (error) {
    return redirectWithPayload(returnTo, YOUTUBE_AUTH_ERROR_KEY, {
      type: YOUTUBE_AUTH_MESSAGE_ERROR,
      message: `YouTube token exchange failed: ${error.message || "Unknown error"}`,
    }, clearOAuthCookieHeaders("youtube"));
  }

  return redirectWithPayload(returnTo, YOUTUBE_AUTH_RESULT_KEY, {
    type: YOUTUBE_AUTH_MESSAGE_SUCCESS,
    tokens,
  }, clearOAuthCookieHeaders("youtube"));
}

async function handleYouTubeToken(request, env) {
  const payload = await readJson(request);
  const code = stringValue(payload.code);
  const redirectUri = stringValue(payload.redirect_uri || payload.redirectUri);

  if (!code || !redirectUri) {
    throw new HttpError(400, "Missing code or redirect_uri.");
  }

  const tokens = await exchangeYouTubeCode(request, env, { code, redirectUri });
  return jsonResponse(request, env, tokens);
}

async function handleYouTubeRefresh(request, env) {
  const payload = await readJson(request);
  const refreshToken = stringValue(payload.refresh_token || payload.refreshToken);
  if (!refreshToken) {
    throw new HttpError(400, "Missing refresh_token.");
  }

  const tokens = await refreshYouTubeToken(request, env, refreshToken);
  if (!tokens.refresh_token) {
    tokens.refresh_token = refreshToken;
  }
  return jsonResponse(request, env, tokens);
}

async function exchangeYouTubeCode(request, env, options) {
  if (!stringValue(options.code) || !stringValue(options.redirectUri)) {
    throw new HttpError(400, "Missing code or redirect_uri.");
  }

  const clientSecret = stringValue(env.YOUTUBE_CLIENT_SECRET);
  if (!clientSecret) {
    throw new HttpError(503, "YOUTUBE_CLIENT_SECRET is not configured.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", getYouTubeClientId(env));
  body.set("client_secret", clientSecret);
  body.set("code", options.code);
  body.set("redirect_uri", options.redirectUri);
  return postYouTubeTokenRequest(env, body);
}

async function refreshYouTubeToken(request, env, refreshToken) {
  const clientSecret = stringValue(env.YOUTUBE_CLIENT_SECRET);
  if (!clientSecret) {
    throw new HttpError(503, "YOUTUBE_CLIENT_SECRET is not configured.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", getYouTubeClientId(env));
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  return postYouTubeTokenRequest(env, body);
}

async function postVeloraTokenRequest(env, body) {
  const response = await fetch(env.VELORA_TOKEN_URL || DEFAULT_VELORA_TOKEN_URL, {
    method: "POST",
    headers: veloraTokenHeaders(env),
    body,
  });

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const message = data.error_description || data.error || text || `Velora token request failed with HTTP ${response.status}.`;
    throw new HttpError(response.status, message);
  }
  if (!data.access_token) {
    throw new HttpError(502, "Velora token response did not include an access token.");
  }
  return data;
}

async function postTwitchTokenRequest(env, body) {
  const response = await fetch(env.TWITCH_TOKEN_URL || DEFAULT_TWITCH_TOKEN_URL, {
    method: "POST",
    headers: twitchTokenHeaders(),
    body,
  });

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const message = data.error_description || data.error || data.message || text || `Twitch token request failed with HTTP ${response.status}.`;
    throw new HttpError(response.status, message);
  }
  if (!data.access_token) {
    throw new HttpError(502, "Twitch token response did not include an access token.");
  }
  data.client_id = getTwitchClientId(env);
  return data;
}

async function postYouTubeTokenRequest(env, body) {
  const response = await fetch(env.YOUTUBE_TOKEN_URL || DEFAULT_YOUTUBE_TOKEN_URL, {
    method: "POST",
    headers: youtubeTokenHeaders(),
    body,
  });

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const message = data.error_description || data.error || text || `YouTube token request failed with HTTP ${response.status}.`;
    throw new HttpError(response.status, message);
  }
  if (!data.access_token) {
    throw new HttpError(502, "YouTube token response did not include an access token.");
  }
  return data;
}

async function startFacebookAuth(request, env) {
  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get("return_to"), env, "facebook");
  const redirectUri = getFacebookRedirectUri(request, env);
  const nonce = randomBase64Url(16);
  const cookieValue = await encryptState(
    {
      provider: "facebook",
      returnTo: returnTo.toString(),
      redirectUri,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      nonce,
    },
    env
  );

  const authUrl = new URL(getFacebookAuthUrl(env));
  authUrl.searchParams.set("client_id", getFacebookClientId(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", env.FACEBOOK_SCOPES || DEFAULT_FACEBOOK_SCOPES);
  authUrl.searchParams.set("state", nonce);
  authUrl.searchParams.set("auth_type", "rerequest");

  return redirectResponse(authUrl, {
    "Set-Cookie": buildOAuthCookie(cookieValue, "facebook"),
  });
}

async function handleFacebookCallback(request, env) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    throw new HttpError(400, "Missing OAuth state.");
  }

  const cookieValue = getCookie(request, FACEBOOK_OAUTH_COOKIE);
  if (!cookieValue) {
    throw new HttpError(400, "Missing OAuth session cookie.");
  }

  const state = await decryptState(cookieValue, env);
  if (!state || state.provider !== "facebook") {
    throw new HttpError(400, "Invalid OAuth state.");
  }
  if (state.nonce !== stateParam) {
    throw new HttpError(400, "OAuth state mismatch.");
  }
  if (!Number.isFinite(state.expiresAt) || Date.now() > state.expiresAt) {
    throw new HttpError(400, "Expired OAuth state.");
  }

  const returnTo = validateReturnTo(state.returnTo, env, "facebook");
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirectWithPayload(returnTo, FACEBOOK_AUTH_ERROR_KEY, {
      type: FACEBOOK_AUTH_MESSAGE_ERROR,
      message: url.searchParams.get("error_description") || providerError,
    }, clearOAuthCookieHeaders("facebook"));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return redirectWithPayload(returnTo, FACEBOOK_AUTH_ERROR_KEY, {
      type: FACEBOOK_AUTH_MESSAGE_ERROR,
      message: "Facebook did not return an authorization code.",
    }, clearOAuthCookieHeaders("facebook"));
  }

  try {
    const payload = await createFacebookAuthPayload(env, code, state.redirectUri);
    return redirectWithPayload(returnTo, FACEBOOK_AUTH_RESULT_KEY, payload, clearOAuthCookieHeaders("facebook"));
  } catch (error) {
    return redirectWithPayload(returnTo, FACEBOOK_AUTH_ERROR_KEY, {
      type: FACEBOOK_AUTH_MESSAGE_ERROR,
      message: `Facebook sign-in failed: ${error.message || "Unknown error"}`,
    }, clearOAuthCookieHeaders("facebook"));
  }
}

async function handleFacebookExchange(request, env) {
  const payload = await readJson(request);
  const code = stringValue(payload.code);
  const redirectUriValue = stringValue(payload.redirectUri || payload.redirect_uri);
  if (!code) {
    throw new HttpError(400, "Missing authorization code.");
  }

  const redirectUri = validateReturnTo(redirectUriValue, env, "facebook").toString();
  const result = await createFacebookAuthPayload(env, code, redirectUri);
  return jsonResponse(request, env, result);
}

async function handleFacebookDeauthorize(request, env) {
  await readFacebookSignedRequest(request, env);
  return jsonResponse(request, env, { success: true });
}

async function handleFacebookDataDeletion(request, env) {
  const payload = await readFacebookSignedRequest(request, env);
  const userId = stringValue(payload.user_id);
  if (!userId) {
    throw new HttpError(400, "Facebook signed request did not include a user ID.");
  }

  const confirmationCode = `fbdel_${bytesToBase64Url(
    (await hmacSha256(`delete:${userId}`, getFacebookClientSecret(env))).slice(0, 12)
  )}`;
  const base = env.SSO_ORIGIN || new URL(request.url).origin;
  const statusUrl = new URL("/auth/facebook/data-deletion/status", base);
  statusUrl.searchParams.set("code", confirmationCode);

  return jsonResponse(request, env, {
    url: statusUrl.toString(),
    confirmation_code: confirmationCode,
  });
}

function handleFacebookDataDeletionStatus(request) {
  const code = stringValue(new URL(request.url).searchParams.get("code"));
  const safeCode = code.replace(/[^A-Za-z0-9_-]/g, "");
  const html = "<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Facebook data deletion</title><body><main><h1>Facebook data deletion complete</h1><p>Social Stream Ninja does not retain Facebook access tokens or Facebook profile data on its servers. Any local sign-in data can be removed from the Facebook source by choosing Clear Facebook sign-in.</p><p>Confirmation code: <strong>" + safeCode + "</strong></p></main></body></html>";

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readFacebookSignedRequest(request, env) {
  const form = await request.formData();
  const signedRequest = stringValue(form.get("signed_request"));
  const parts = signedRequest.split(".");
  if (parts.length !== 2) {
    throw new HttpError(400, "Missing or invalid Facebook signed request.");
  }

  let signature;
  let payloadBytes;
  try {
    signature = base64UrlToBytes(parts[0]);
    payloadBytes = base64UrlToBytes(parts[1]);
  } catch (_) {
    throw new HttpError(400, "Invalid Facebook signed request encoding.");
  }

  const expected = await hmacSha256(parts[1], getFacebookClientSecret(env));
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(400, "Invalid Facebook signed request signature.");
  }

  const payload = parseJson(new TextDecoder().decode(payloadBytes));
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "Invalid Facebook signed request payload.");
  }
  return payload;
}

async function hmacSha256(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  );
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left[i] ^ right[i];
  }
  return difference === 0;
}

async function createFacebookAuthPayload(env, code, redirectUri) {
  const shortLivedToken = await exchangeFacebookCode(env, code, redirectUri);
  const accessToken = await exchangeFacebookLongLivedToken(env, shortLivedToken);
  const apiBase = getFacebookGraphBase(env);
  const userUrl = new URL(`${apiBase}/me`);
  userUrl.searchParams.set("fields", "id,name");
  userUrl.searchParams.set("access_token", accessToken);
  const pagesUrl = new URL(`${apiBase}/me/accounts`);
  pagesUrl.searchParams.set("fields", "id,name,access_token,category,tasks");
  pagesUrl.searchParams.set("limit", "200");
  pagesUrl.searchParams.set("access_token", accessToken);

  const results = await Promise.all([
    fetchFacebookJson(userUrl, "Facebook user lookup failed"),
    fetchFacebookJson(pagesUrl, "Facebook Page lookup failed"),
  ]);
  const user = results[0] || {};
  const pagesData = results[1] && Array.isArray(results[1].data) ? results[1].data : [];

  return {
    type: FACEBOOK_AUTH_MESSAGE_SUCCESS,
    user: {
      id: stringValue(user.id),
      name: stringValue(user.name),
    },
    pages: pagesData.map((page) => ({
      id: stringValue(page.id),
      name: stringValue(page.name),
      accessToken: stringValue(page.access_token),
      category: stringValue(page.category),
      tasks: Array.isArray(page.tasks) ? page.tasks : [],
    })).filter((page) => page.id && page.accessToken),
  };
}

async function exchangeFacebookCode(env, code, redirectUri) {
  const tokenUrl = new URL(`${getFacebookGraphBase(env)}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", getFacebookClientId(env));
  tokenUrl.searchParams.set("client_secret", getFacebookClientSecret(env));
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const data = await fetchFacebookJson(tokenUrl, "Facebook token exchange failed");
  const accessToken = stringValue(data.access_token);
  if (!accessToken) {
    throw new HttpError(502, "Facebook token exchange returned no access token.");
  }
  return accessToken;
}

async function exchangeFacebookLongLivedToken(env, accessToken) {
  const tokenUrl = new URL(`${getFacebookGraphBase(env)}/oauth/access_token`);
  tokenUrl.searchParams.set("grant_type", "fb_exchange_token");
  tokenUrl.searchParams.set("client_id", getFacebookClientId(env));
  tokenUrl.searchParams.set("client_secret", getFacebookClientSecret(env));
  tokenUrl.searchParams.set("fb_exchange_token", accessToken);

  const data = await fetchFacebookJson(tokenUrl, "Facebook long-lived token exchange failed");
  return stringValue(data.access_token) || accessToken;
}

async function fetchFacebookJson(url, errorPrefix) {
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok || data.error) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
    throw new HttpError(502, `${errorPrefix}: ${detail}`);
  }
  return data;
}

function getFacebookApiVersion(env) {
  return stringValue(env.FACEBOOK_API_VERSION) || DEFAULT_FACEBOOK_API_VERSION;
}

function getFacebookAuthUrl(env) {
  return stringValue(env.FACEBOOK_AUTH_URL) || `https://www.facebook.com/${getFacebookApiVersion(env)}/dialog/oauth`;
}

function getFacebookGraphBase(env) {
  return (stringValue(env.FACEBOOK_GRAPH_URL) || `https://graph.facebook.com/${getFacebookApiVersion(env)}`).replace(/\/+$/, "");
}

function getFacebookRedirectUri(request, env) {
  if (env.FACEBOOK_REDIRECT_URI) {
    return env.FACEBOOK_REDIRECT_URI;
  }
  const base = env.SSO_ORIGIN || new URL(request.url).origin;
  return new URL("/auth/facebook/callback", base).toString();
}

function getFacebookClientId(env) {
  const clientId = stringValue(env.FACEBOOK_CLIENT_ID) || DEFAULT_FACEBOOK_CLIENT_ID;
  if (!clientId) {
    throw new HttpError(500, "FACEBOOK_CLIENT_ID is not configured.");
  }
  return clientId;
}

function getFacebookClientSecret(env) {
  const clientSecret = stringValue(env.FACEBOOK_CLIENT_SECRET);
  if (!clientSecret) {
    throw new HttpError(500, "FACEBOOK_CLIENT_SECRET is not configured.");
  }
  return clientSecret;
}

function validateReturnTo(value, env, provider = "velora") {
  if (!value) {
    throw new HttpError(400, "Missing return_to.");
  }

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new HttpError(400, "Invalid return_to.");
  }

  const allowedOrigins = csv(env.ALLOWED_RETURN_ORIGINS);
  if (!allowedOrigins.includes(url.origin)) {
    throw new HttpError(400, "return_to origin is not allowed.");
  }

  if (!getAllowedReturnPaths(provider).includes(normalizePath(url.pathname))) {
    throw new HttpError(400, "return_to path is not allowed.");
  }

  return url;
}

function getAllowedReturnPaths(provider) {
  if (provider === "twitch") {
    return [
      "/sources/websocket/twitch.html",
      "/sources/websocket/twitch",
      "/beta/sources/websocket/twitch.html",
      "/beta/sources/websocket/twitch",
    ];
  }
  if (provider === "facebook") {
    return [
      "/sources/websocket/facebook.html",
      "/sources/websocket/facebook",
      "/beta/sources/websocket/facebook.html",
      "/beta/sources/websocket/facebook",
    ];
  }
  if (provider === "youtube") {
    return [
      "/sources/websocket/youtube.html",
      "/sources/websocket/youtube",
      "/beta/sources/websocket/youtube.html",
      "/beta/sources/websocket/youtube",
      "/sources/websocket/youtube_streaming.html",
      "/sources/websocket/youtube_streaming",
      "/beta/sources/websocket/youtube_streaming.html",
      "/beta/sources/websocket/youtube_streaming",
      "/lite/index.html",
      "/lite",
      "/beta/lite/index.html",
      "/beta/lite",
    ];
  }
  return ["/sources/websocket/velora.html"];
}

function getVeloraRedirectUri(request, env) {
  if (env.VELORA_REDIRECT_URI) {
    return env.VELORA_REDIRECT_URI;
  }
  const base = env.SSO_ORIGIN || new URL(request.url).origin;
  return new URL("/auth/velora/callback", base).toString();
}

function getVeloraClientId(env) {
  const clientId = stringValue(env.VELORA_CLIENT_ID);
  if (!clientId) {
    throw new HttpError(500, "VELORA_CLIENT_ID is not configured.");
  }
  return clientId;
}

function getTwitchRedirectUri(request, env) {
  if (env.TWITCH_REDIRECT_URI) {
    return env.TWITCH_REDIRECT_URI;
  }
  const base = env.SSO_ORIGIN || new URL(request.url).origin;
  return new URL("/auth/twitch/callback", base).toString();
}

function getTwitchClientId(env) {
  const clientId = stringValue(env.TWITCH_CLIENT_ID);
  if (!clientId) {
    throw new HttpError(500, "TWITCH_CLIENT_ID is not configured.");
  }
  return clientId;
}

function normalizeTwitchAuthPurpose(value) {
  return stringValue(value).toLowerCase() === "bot" ? "bot" : "main";
}

function getYouTubeRedirectUri(request, env) {
  if (env.YOUTUBE_REDIRECT_URI) {
    return env.YOUTUBE_REDIRECT_URI;
  }
  const base = env.SSO_ORIGIN || new URL(request.url).origin;
  return new URL("/auth/youtube/callback", base).toString();
}

function getYouTubeClientId(env) {
  const clientId = stringValue(env.YOUTUBE_CLIENT_ID) || DEFAULT_YOUTUBE_CLIENT_ID;
  if (!clientId) {
    throw new HttpError(500, "YOUTUBE_CLIENT_ID is not configured.");
  }
  return clientId;
}

function getYouTubeScopes(env, requestedScope = "") {
  const scopeText = stringValue(requestedScope) || stringValue(env.YOUTUBE_SCOPES) || DEFAULT_YOUTUBE_SCOPES;
  return splitScopes(scopeText);
}

function getYouTubeLegacyScopes(requestedScope = "") {
  return uniqueList(DEFAULT_YOUTUBE_LEGACY_SCOPES.concat(splitScopes(requestedScope)));
}

function maybeSetClientSecret(body, env, provider = "velora") {
  const clientSecret = provider === "twitch"
    ? stringValue(env.TWITCH_CLIENT_SECRET)
    : stringValue(env.VELORA_CLIENT_SECRET);
  const authMethod = provider === "twitch"
    ? stringValue(env.TWITCH_CLIENT_AUTH_METHOD) || "post"
    : stringValue(env.VELORA_CLIENT_AUTH_METHOD) || "post";
  if (clientSecret && authMethod === "post") {
    body.set("client_secret", clientSecret);
  }
}

function veloraTokenHeaders(env) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const clientSecret = stringValue(env.VELORA_CLIENT_SECRET);
  const authMethod = stringValue(env.VELORA_CLIENT_AUTH_METHOD) || "post";
  if (clientSecret && authMethod !== "post") {
    headers.Authorization = `Basic ${btoa(`${getVeloraClientId(env)}:${clientSecret}`)}`;
  }
  return headers;
}

function twitchTokenHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function youtubeTokenHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function encryptState(payload, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getStateKey(env);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function decryptState(value, env) {
  const parts = String(value || "").split(".");
  if (parts.length !== 2) {
    return null;
  }

  const iv = base64UrlToBytes(parts[0]);
  const encrypted = base64UrlToBytes(parts[1]);
  const key = await getStateKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return parseJson(new TextDecoder().decode(plain));
}

async function tryDecryptState(value, env) {
  try {
    return await decryptState(value, env);
  } catch (_) {
    return null;
  }
}

async function getStateKey(env) {
  const secret = stringValue(env.STATE_ENCRYPTION_SECRET);
  if (secret.length < 16) {
    throw new HttpError(500, "STATE_ENCRYPTION_SECRET must be at least 16 characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

function redirectWithPayload(returnTo, key, payload, headers = {}) {
  const url = new URL(returnTo.toString());
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  hash.set(key, jsonToBase64Url(payload));
  url.hash = hash.toString();
  return redirectResponse(url, headers);
}

function redirectResponse(url, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      Location: url.toString(),
      "Cache-Control": "no-store",
    },
  });
}

function buildOAuthCookie(value, provider = "velora") {
  const name = getOAuthCookieName(provider);
  return `${name}=${value}; Max-Age=600; Path=${getOAuthCallbackPath(provider)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearOAuthCookieHeaders(provider = "velora") {
  const name = getOAuthCookieName(provider);
  return {
    "Set-Cookie": `${name}=; Max-Age=0; Path=${getOAuthCallbackPath(provider)}; HttpOnly; Secure; SameSite=Lax`,
  };
}

function getOAuthCookieName(provider) {
  if (provider === "twitch") {
    return TWITCH_OAUTH_COOKIE;
  }
  if (provider === "youtube") {
    return YOUTUBE_OAUTH_COOKIE;
  }
  if (provider === "facebook") {
    return FACEBOOK_OAUTH_COOKIE;
  }
  return VELORA_OAUTH_COOKIE;
}

function getOAuthCallbackPath(provider) {
  if (provider === "twitch") {
    return "/auth/twitch/callback";
  }
  if (provider === "youtube") {
    return "/auth/youtube/callback";
  }
  if (provider === "facebook") {
    return "/auth/facebook/callback";
  }
  return "/auth/velora/callback";
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return "";
}

function jsonResponse(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
    "Vary": "Origin",
  };

  if (origin && isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function isAllowedOrigin(origin, env) {
  try {
    return csv(env.ALLOWED_RETURN_ORIGINS).includes(new URL(origin).origin);
  } catch (_) {
    return false;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

async function readJsonWithLimit(request, maxBytes) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    throw new HttpError(400, "Invalid JSON body.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : "";
}

function parseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  return Array.from(new Set(items.map((item) => String(item || "").trim()).filter(Boolean)));
}

function splitScopes(value) {
  return uniqueList(String(value || "").split(/[,\s]+/));
}

function jsonToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
