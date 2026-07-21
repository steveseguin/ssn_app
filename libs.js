function log(msg) {
	if (devmode) { // only show log if in dev mode; else it will just spam the log and cause higher resource usage
		console.log(msg);
	}
}
const SSAPP_ACCEPT_LANGUAGE = window.SSAPP_ACCEPT_LANGUAGE || ((window.ssappLocale && window.ssappLocale.acceptLanguage) || 'en-US,en;q=0.9');
window.SSAPP_ACCEPT_LANGUAGE = SSAPP_ACCEPT_LANGUAGE;
window.onerror = function(message, source, lineno, colno, error) {
	console.error("Global error:", message, "at", source, ":", lineno);
	return true;
};
window.addEventListener('unhandledrejection', (event) => {
	console.error('Unhandled promise rejection:', event.reason);
});

function getOperatingSystem() {
	const platform = navigator.platform.toLowerCase();
	if (platform.includes('mac')) return 'mac';
	if (platform.includes('linux')) return 'linux';
	return 'windows'; // Default to Windows for other cases
}

function getConfigFileName(os) {
	switch (os) {
		case 'mac':
			return 'config_mac_0.json';
		case 'linux':
			return 'config_linux_0.json';
		default:
			return 'config_0.json';
	}
}

function compareVersions(version1, version2) {
	const parts1 = version1.split('.').map(Number);
	const parts2 = version2.split('.').map(Number);

	for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
		const num1 = parts1[i] || 0;
		const num2 = parts2[i] || 0;

		if (num1 > num2) return 1;
		if (num2 > num1) return -1;
	}

	return 0;
}
function extractRumbleIdentifiersFromHtml(html) {
    if (!html || typeof html !== 'string') {
        return {
            chatId: null,
            videoId: null,
            fullPath: null
        };
    }

    const buildVideoInfoFromCandidate = (candidate) => {
        if (!candidate || typeof candidate !== 'string') {
            return {
                videoId: null,
                fullPath: null
            };
        }

        try {
            const parsed = candidate.startsWith('http')
                ? new URL(candidate)
                : new URL(candidate, 'https://rumble.com');
            const pathname = (parsed.pathname || '').trim();
            const match = pathname.match(/\/((?:v|p)[a-zA-Z0-9]+[^\/]*\.html)/i);
            if (!match || !match[1]) {
                return {
                    videoId: null,
                    fullPath: null
                };
            }
            const fullPath = match[1];
            const idMatch = fullPath.match(/^((?:v|p)[a-zA-Z0-9]+)/i);
            return {
                videoId: idMatch && idMatch[1] ? idMatch[1] : null,
                fullPath
            };
        } catch (_) {
            return {
                videoId: null,
                fullPath: null
            };
        }
    };

    const directChatPatterns = [
        /chat\/popup\/(\d+)/i,
        /(?:^|[^a-z])video_id\s*[:=]\s*["']?(\d+)/i,
        /["']video_id["']\s*[:=]\s*["']?(\d+)/i,
        /["']chatId["']\s*[:=]\s*["']?(\d+)/i
    ];

    let chatId = null;
    for (const regex of directChatPatterns) {
        const match = html.match(regex);
        if (match && match[1] && /^\d+$/.test(match[1])) {
            chatId = match[1];
            break;
        }
    }

    const pageUrlPatterns = [
        /<link[^>]+rel=["']?canonical["']?[^>]*href=["']?([^"' >]+)/i,
        /<meta[^>]+property=["']?og:url["']?[^>]*content=["']?([^"' >]+)/i,
        /<meta[^>]+name=["']?twitter:url["']?[^>]*content=["']?([^"' >]+)/i,
        /<meta[^>]+itemprop=["']?url["']?[^>]*content=["']?([^"' >]+)/i
    ];

    for (const regex of pageUrlPatterns) {
        const match = html.match(regex);
        if (match && match[1]) {
            const info = buildVideoInfoFromCandidate(match[1]);
            if (info.videoId || info.fullPath) {
                return {
                    chatId,
                    videoId: info.videoId,
                    fullPath: info.fullPath
                };
            }
        }
    }

    const liveTilePatterns = [
        /<div[^>]+data-video-id=["'](\d+)["'][\s\S]{0,1800}?(?:thumbnail__thumb--live|videostream__footer--live)[\s\S]{0,1200}?href=["']\/([^"']+\.html)/i,
        /<div[^>]+data-video-id=["'](\d+)["'][\s\S]{0,1800}?(?:thumbnail__thumb--live|videostream__status--live|videostream__footer--live)/i
    ];

    for (const regex of liveTilePatterns) {
        const match = html.match(regex);
        if (!match || !match[1] || !/^\d+$/.test(match[1])) {
            continue;
        }

        const info = match[2]
            ? buildVideoInfoFromCandidate(match[2])
            : { videoId: null, fullPath: null };
        return {
            chatId: match[1],
            videoId: info.videoId,
            fullPath: info.fullPath
        };
    }

    return {
        chatId,
        videoId: null,
        fullPath: null
    };
}
async function getRumbleVideoId(url) {
    // Returns numeric chat ID extracted from the Rumble video page
    const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': SSAPP_ACCEPT_LANGUAGE,
        'Referer': 'https://rumble.com/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    try {
        // Prefer main-process fetch to avoid CORS/UA quirks
        if (typeof ipcRenderer !== 'undefined' && ipcRenderer) {
            const response = await ipcRenderer.invoke('nodefetch', {
                url,
                headers: { ...headers, 'User-Agent': (config?.global?.userAgent || 'Mozilla/5.0') },
                timeout: 15000
            });
            const html = response?.data || '';
            if (html) {
                const identifiers = extractRumbleIdentifiersFromHtml(html);
                if (identifiers.chatId) return identifiers.chatId;
            }
        }
    } catch (e) {
        console.warn('nodefetch getRumbleVideoId failed, falling back to renderer fetch:', e?.message || e);
    }
    try {
        const res = await fetch(url, { headers, credentials: 'omit', cache: 'no-store' });
        const html = await res.text();
        const identifiers = extractRumbleIdentifiersFromHtml(html);
        if (identifiers.chatId) return identifiers.chatId;
    } catch (e) {
        console.error('Error fetching Rumble video page:', e);
    }
    return "";
}

async function getRumbleChatId(videoId) {
    if (!videoId) return null;

    let target = typeof videoId === 'string' ? videoId.trim() : '';
    if (!target) return null;

    const popupMatch = target.match(/chat\/popup\/(\d+)/i);
    if (popupMatch && popupMatch[1]) {
        return popupMatch[1];
    }
    if (/^\d+$/.test(target)) {
        return target;
    }

    let url;
    if (target.startsWith('http')) {
        url = target;
    } else {
        target = target.replace(/^https?:\/\//i, '').replace(/^rumble\.com\/+/i, '');
        if (target.startsWith('/')) target = target.slice(1);

        let hash = '';
        const hashIndex = target.indexOf('#');
        if (hashIndex !== -1) {
            hash = target.slice(hashIndex);
            target = target.slice(0, hashIndex);
        }

        let query = '';
        const queryIndex = target.indexOf('?');
        if (queryIndex !== -1) {
            query = target.slice(queryIndex);
            target = target.slice(0, queryIndex);
        }

        if (target && !target.endsWith('.html')) {
            const hasExtension = /\.[a-z0-9]+$/i.test(target);
            if (!hasExtension) target += '.html';
        }

        url = `https://rumble.com/${target}${query}${hash}`;
    }

    const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': SSAPP_ACCEPT_LANGUAGE,
        'Referer': 'https://rumble.com/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    
    try {
        // Prefer main-process fetch
        if (typeof ipcRenderer !== 'undefined' && ipcRenderer) {
            const response = await ipcRenderer.invoke('nodefetch', {
                url,
                headers: { ...headers, 'User-Agent': (config?.global?.userAgent || 'Mozilla/5.0') },
                timeout: 15000
            });
            const html = response?.data || '';
            const identifiers = extractRumbleIdentifiersFromHtml(html);
            if (identifiers.chatId) {
                console.log(`Found Rumble chat ID: ${identifiers.chatId} for video: ${videoId}`);
                return identifiers.chatId;
            }
        }
    } catch (e) {
        console.warn('nodefetch getRumbleChatId failed, falling back to renderer fetch:', e?.message || e);
    }
    try {
        const res = await fetch(url, {
            headers,
            credentials: 'omit',
            cache: 'no-store'
        });
        const html = await res.text();
        const identifiers = extractRumbleIdentifiersFromHtml(html);
        if (identifiers.chatId) {
            console.log(`Found Rumble chat ID: ${identifiers.chatId} for video: ${videoId}`);
            return identifiers.chatId;
        }
    } catch (e) {
        console.error('Error fetching Rumble chat ID:', e);
    }
    console.warn(`Could not find chat ID for Rumble video: ${videoId}`);
    return null;
}
function matchRuleShort(str, rule) {
	var escapeRegex = (str) => str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
	return new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$").test(str);
}
function getPrimaryDomain(url) {
	try {
		url = url.trim();
		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			url = 'https://' + url;
		}
		const parsedUrl = new URL(url);
		const hostParts = parsedUrl.hostname.split('.');
		if (hostParts.length > 2 && hostParts[0] === 'www') {
			return hostParts.slice(-2).join('.');
		}
		return hostParts.slice(-2).join('.');
	} catch (error) {
		console.error('Invalid URL:', error);
		return null;
	}
}
function checkSupported(str) {
	var matches = [];
	manifest.content_scripts.forEach(dom => {
		dom.matches.forEach(dom2 => {
			if (matchRuleShort(str, dom2)) {
				log(dom2);
				(Array.isArray(dom.js) ? dom.js : []).forEach(scriptPath => {
					if (!matches.includes(scriptPath)) {
						matches.push(scriptPath);
					}
				});
			}
		});
	});
	return matches;
}

function mergeSavedSourceFilesWithManifest(str, sourceFiles) {
	var normalizeScriptPath = value => {
		if (!value || typeof value !== "string") return "";
		return value.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
	};
	var savedFiles = Array.isArray(sourceFiles)
		? sourceFiles.map(normalizeScriptPath).filter(Boolean)
		: [];
	if (!savedFiles.length) return savedFiles;

	var manifestFiles = checkSupported(str).map(normalizeScriptPath).filter(Boolean);
	return [...new Set([...manifestFiles, ...savedFiles])];
}

const tipsContent = {
	tiktok: `
	<div class="tips-section">
	  <h3>You Must Be Live</h3>
	  <p>TikTok chat only works when you are actively streaming. Click <strong>🔄 Reload</strong> after going live.</p>
	</div>
	<div class="tips-section">
	  <h3>Which Mode Should I Use?</h3>
	  <table style="width:100%; border-collapse: collapse; font-size: 0.9em; margin: 8px 0;">
		<tr style="border-bottom: 1px solid rgba(255,255,255,0.2);">
		  <th style="text-align:left; padding: 6px 8px;">Mode</th>
		  <th style="text-align:center; padding: 6px 8px;">Replies</th>
		  <th style="text-align:left; padding: 6px 8px;">Best For</th>
		</tr>
		<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
		  <td style="padding: 6px 8px;"><strong>TikTok WS</strong></td>
		  <td style="text-align:center; padding: 6px 8px;">⚙️</td>
		  <td style="padding: 6px 8px;">Recommended default — smooth + auto-fallback</td>
		</tr>
		<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
		  <td style="padding: 6px 8px;"><strong>Standard</strong></td>
		  <td style="text-align:center; padding: 6px 8px;">✅</td>
		  <td style="padding: 6px 8px;">Need to reply (requires sign-in)</td>
		</tr>
	<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
	  <td style="padding: 6px 8px;"><strong>Polling</strong></td>
	  <td style="text-align:center; padding: 6px 8px;">❌</td>
	  <td style="padding: 6px 8px;">Fallback only — messages arrive in batches</td>
	</tr>
	  </table>
	  <p style="font-size: 0.85em; opacity: 0.8;"><strong>TikTok WS</strong> with <strong>Auto</strong> is the default. It tries WebSocket first and falls back to Polling if needed. Reply support depends on the signing provider.</p>
	  <p style="font-size: 0.85em; opacity: 0.8;"><strong>Backup option:</strong> If TikTok modes keep failing or miss messages, use a <strong>TikFinity OBS Dock</strong> URL as an <strong>Other chat site</strong> in SSN. In TikFinity, go to <strong>Overlay -> OBS Docks</strong>, set one dock to chat, copy the URL, and keep TikFinity open.</p>
	</div>
	<div class="tips-section">
	  <h3>Troubleshooting</h3>
	  <p><strong>Standard mode not working?</strong></p>
	  <ul>
		<li>Click <strong>👁️ Show capture page</strong> to check for CAPTCHA or sign-in</li>
		<li>If nothing appears, try <strong>🔄 Reload</strong></li>
		<li>Clear cache via the ⚙️ settings menu</li>
	  </ul>
	  <p><strong>Getting blocked or throttled?</strong></p>
	  <ul>
		<li>Close other TikTok tabs/apps on this device</li>
		<li>Avoid viewing the same stream elsewhere</li>
		<li>Wait a few minutes, then try again</li>
	  </ul>
	  <p><strong>Still missing chat?</strong></p>
	  <ul>
		<li>Use a <strong>TikFinity OBS Dock</strong> URL as an <strong>Other chat site</strong> in SSN</li>
		<li>In TikFinity, go to <strong>Overlay -> OBS Docks</strong> and set a dock to chat</li>
		<li>Keep TikFinity open during the stream</li>
	  </ul>
	  <p><strong>Need to reply to chat?</strong></p>
	  <ul>
		<li>Use <strong>Standard</strong> mode with <strong>🔑 Sign-in</strong></li>
		<li>Or try <strong>TikTok WS</strong> with <strong>Local Signer</strong> (experimental)</li>
	  </ul>
	</div>
  `,
	youtube: `
	<div class="tips-section">
	  <h3>Important: You Must Be Live</h3>
	  <p>YouTube chat only works when you are actively streaming. If you're not live yet, there's no chat to capture.</p>
	  <p>When you go live, click the <strong>🔄 Reload</strong> button to start capturing chat.</p>
	</div>
	<div class="tips-section">
	  <h3>Connection Modes</h3>
	  <ul>
		<li><span class="tips-highlight">Standard Mode:</span> Uses a browser page to capture chat.</li>
		<li><span class="tips-highlight">WebSocket Mode:</span> Direct API connection with more event types (followers, memberships, Super Chats). Requires sign-in.</li>
	  </ul>
	  <p style="margin-top: 8px;">If Standard mode has issues, try <strong>WebSocket mode</strong> as an alternative.</p>
	</div>
	<div class="tips-section">
	  <h3>Finding Your Stream</h3>
	  <ul>
		<li><span class="tips-highlight">By Username/Channel:</span> Your stream must be <strong>Public</strong>. Unlisted or Private streams cannot be found this way.</li>
		<li><span class="tips-highlight">By Video ID:</span> If your stream is Unlisted, add it using the YouTube Video ID instead (the part after "v=" in the URL).</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <p>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version).</p>
	</div>
  `,
	twitch: `
	<div class="tips-section">
	  <h3>Twitch is Always Ready</h3>
	  <p>Unlike some platforms, Twitch chat is available even when you're not live. You can start capturing chat immediately.</p>
	</div>
	<div class="tips-section">
	  <h3>Connection Modes</h3>
	  <ul>
		<li><span class="tips-highlight">Standard Mode:</span> Uses a browser page to capture chat.</li>
		<li><span class="tips-highlight">WebSocket Mode:</span> Direct connection with more event types (followers, subs, raids, bits). Requires sign-in.</li>
	  </ul>
	  <p style="margin-top: 8px;">If Standard mode has issues, try <strong>WebSocket mode</strong> as an alternative.</p>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <p>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version).</p>
	</div>
  `,
	kick: `
	<div class="tips-section">
	  <h3>Kick is Always Ready</h3>
	  <p>Like Twitch, Kick chat is available even when you're not live. You can start capturing chat immediately.</p>
	</div>
	<div class="tips-section">
	  <h3>Connection Modes</h3>
	  <ul>
		<li><span class="tips-highlight">Standard Mode:</span> Uses a browser page to capture chat.</li>
		<li><span class="tips-highlight">WebSocket Mode:</span> Direct connection with more event types (followers, subs, etc.). Requires sign-in.</li>
	  </ul>
	  <p style="margin-top: 8px;">If Standard mode has issues, try <strong>WebSocket mode</strong> as an alternative.</p>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <ul>
		<li>Try signing in with <strong>email + password</strong> instead of Google/SSO — it often works better</li>
		<li>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version)</li>
		<li>If Standard mode sign-in fails, try <strong>WebSocket mode</strong> with the <strong>external sign-in</strong> option</li>
	  </ul>
	</div>
  `,
	velora: `
	<div class="tips-section">
	  <h3>Use WebSocket Mode First</h3>
	  <p>Velora works best in <strong>WebSocket mode</strong>. It uses the OAuth connection directly and is the default in SSApp.</p>
	</div>
	<div class="tips-section">
	  <h3>Connection Modes</h3>
	  <ul>
		<li><span class="tips-highlight">WebSocket Mode:</span> Uses the Velora OAuth/API connection. Best for stability and chat events.</li>
		<li><span class="tips-highlight">Standard Mode:</span> Uses the normal channel page at <code>velora.tv/USERNAME</code> as a fallback.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>If WebSocket Sign-in Fails</h3>
	  <ul>
		<li>Make sure your Velora app has the correct redirect URLs configured</li>
		<li>Try <strong>ðŸ”„ Reload</strong> after signing in</li>
		<li>Switch to <strong>Standard</strong> mode if you only need DOM capture temporarily</li>
	  </ul>
	</div>
  `,
	rumble: `
	<div class="tips-section">
	  <h3>You Must Be Live First</h3>
	  <p>Rumble chat only works when you are already streaming. <strong>Go live before activating</strong> this source.</p>
	</div>
	<div class="tips-section">
	  <h3>Paste The Normal Stream URL</h3>
	  <p>You do <strong>not</strong> need to find the popup chat URL manually. Paste the normal Rumble stream or video URL and SSApp will try to detect the popup chat automatically.</p>
	</div>
	<div class="tips-section">
	  <h3>If Rumble Shows A Challenge</h3>
	  <p>If Rumble or Cloudflare blocks the automatic lookup, SSApp may open the regular Rumble page instead. Complete the check there, then reload or reactivate the source.</p>
	  <p>Use <strong>👁️ Show capture page</strong> if you need to bring that page back into view.</p>
	</div>
	<div class="tips-section">
	  <h3>If Username Doesn't Work</h3>
	  <p>Adding by username still depends on Rumble lookup pages. If that fails, paste the full stream URL instead:</p>
	  <ol>
		<li>Open your Rumble stream in a browser</li>
		<li>Copy the page URL from the address bar</li>
		<li>Add a new source using <strong>Rumble Video</strong> or <strong>Other</strong> and paste that normal URL</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>Chat Visible But Not Capturing?</h3>
	  <p>Click <strong>👁️ Show capture page</strong> to check. If chat is visible but not capturing, try <strong>🔄 Reload</strong>.</p>
	</div>
  `,
	facebook: `
	<div class="tips-section">
	  <h3>You Must Be Live</h3>
	  <p>Facebook chat only works when the stream is actively live. There's no chat to capture otherwise.</p>
	</div>
	<div class="tips-section">
	  <h3>Getting Started</h3>
	  <ol>
		<li>Click <strong>👁️ Show capture page</strong> to open the browser window</li>
		<li>Sign in to Facebook if prompted</li>
		<li>Navigate to the page where the live chat is visible</li>
		<li>Once you can see the chat, it should start capturing</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>Streaming From Your Own Account?</h3>
	  <p>If you're signed into the same account you're streaming from, you may need to navigate to your <strong>Facebook Live Producer Studio</strong> instead of the normal watch page to see the chat.</p>
	  <p><span class="tips-highlight">Group streams:</span> Navigate to the group's live stream page. Once the chat is visible, it should work.</p>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <p>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version).</p>
	</div>
	<div class="tips-section">
	  <h3>Chat Visible But Not Capturing?</h3>
	  <p>If you can see the chat in the popup but it's not being captured, try clicking <strong>🔄 Reload</strong>.</p>
	  <p><span class="tips-highlight">Alternative:</span> The <strong>Chrome Extension</strong> may work better since you can navigate more easily in your regular browser.</p>
	</div>
  `,
	linkedin: `
	<div class="tips-section">
	  <h3>LinkedIn Requires Sign-in</h3>
	  <p>LinkedIn chat capture requires you to be signed in. Use the <strong>🔑 Sign-in</strong> button first.</p>
	</div>
	<div class="tips-section">
	  <h3>If Chat Isn't Working</h3>
	  <ol>
		<li>Click <strong>👁️ Reveal capture page</strong> to see the hidden browser</li>
		<li>Make sure the chat/comments are visible on the page</li>
		<li>Check that you're signed in properly</li>
	  </ol>
	  <p><span class="tips-highlight">Alternative:</span> Consider using the <strong>Chrome Extension</strong> instead. It often works better for LinkedIn since you can sign in and navigate more easily in your regular browser.</p>
	</div>
	<div class="tips-section">
	  <h3>Understanding the Capture Page</h3>
	  <p>Social Stream uses a hidden browser page to capture chat. The <strong>🔄 Reload</strong> button refreshes this page if needed.</p>
	</div>
  `,
	instagram: `
	<div class="tips-section">
	  <h3>You Must Be Live</h3>
	  <p>Instagram chat only works when the stream is actively live.</p>
	</div>
	<div class="tips-section">
	  <h3>Getting Started</h3>
	  <ol>
		<li>Click <strong>👁️ Show capture page</strong> to open the browser window</li>
		<li>Sign in to Instagram if prompted</li>
		<li>Navigate to the page where the live chat/comments are visible</li>
		<li>Once you can see the chat, it should start capturing</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>If You Are The Host</h3>
	  <p>Instagram may hide chat on your own public live page. Use the producer page instead: the Instagram page you are publishing from, where the <strong>Comments</strong> tab is visible.</p>
	  <p>In the standalone app, that producer page must be open inside SSN's capture page. If you started the live from a normal desktop browser tab, use the Chrome Extension instead, or sign in with a different Instagram account to watch the live.</p>
	  <p>If you started the live from the mobile app, use a second Instagram account to view the live and capture comments.</p>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <p>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version).</p>
	</div>
	<div class="tips-section">
	  <h3>Chat Visible But Not Capturing?</h3>
	  <p>If you can see the chat in the popup but it's not being captured, try clicking <strong>🔄 Reload</strong>.</p>
	  <p><span class="tips-highlight">Alternative:</span> The <strong>Chrome Extension</strong> may work better since you can navigate more easily in your regular browser.</p>
	</div>
  `,
	instagramlive: `
	<div class="tips-section">
	  <h3>You Must Be Live</h3>
	  <p>Instagram Live chat only works when the stream is actively live.</p>
	</div>
	<div class="tips-section">
	  <h3>Getting Started</h3>
	  <ol>
		<li>Click <strong>👁️ Show capture page</strong> to open the browser window</li>
		<li>Sign in to Instagram if prompted</li>
		<li>Navigate to the page where the live chat is visible</li>
		<li>Once you can see the chat, it should start capturing</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>If You Are The Host</h3>
	  <p>Instagram may hide chat on your own public live page. Use the producer page instead: the Instagram page you are publishing from, where the <strong>Comments</strong> tab is visible.</p>
	  <p>In the standalone app, that producer page must be open inside SSN's capture page. If you started the live from a normal desktop browser tab, use the Chrome Extension instead, or sign in with a different Instagram account to watch the live.</p>
	  <p>If you started the live from the mobile app, use a second Instagram account to view the live and capture comments.</p>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <p>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version).</p>
	</div>
	<div class="tips-section">
	  <h3>Chat Visible But Not Capturing?</h3>
	  <p>If you can see the chat in the popup but it's not being captured, try clicking <strong>🔄 Reload</strong>.</p>
	  <p><span class="tips-highlight">Alternative:</span> The <strong>Chrome Extension</strong> may work better since you can navigate more easily in your regular browser.</p>
	</div>
  `,
	zoom: `
	<div class="tips-section">
	  <h3>Zoom Requires Sign-in</h3>
	  <p>Zoom chat capture requires you to be signed in and in an active meeting.</p>
	</div>
	<div class="tips-section">
	  <h3>If Chat Isn't Working</h3>
	  <ol>
		<li>Click <strong>👁️ Reveal capture page</strong> to see the hidden browser</li>
		<li>Make sure the chat panel is open and visible</li>
		<li>Check that you're signed in and in an active meeting</li>
	  </ol>
	  <p><span class="tips-highlight">Alternative:</span> Consider using the <strong>Chrome Extension</strong> instead. It often works better for Zoom since you can sign in and navigate more easily in your regular browser.</p>
	</div>
	<div class="tips-section">
	  <h3>Understanding the Capture Page</h3>
	  <p>Social Stream uses a hidden browser page to capture chat. The <strong>🔄 Reload</strong> button refreshes this page if needed.</p>
	</div>
  `,
	slack: `
	<div class="tips-section">
	  <h3>Slack Requires Sign-in</h3>
	  <p>Slack chat capture requires you to be signed in to your workspace.</p>
	</div>
	<div class="tips-section">
	  <h3>If Chat Isn't Working</h3>
	  <ol>
		<li>Click <strong>👁️ Reveal capture page</strong> to see the hidden browser</li>
		<li>Make sure you're signed in and the channel is visible</li>
		<li>Check that messages are loading properly</li>
	  </ol>
	  <p><span class="tips-highlight">Alternative:</span> Consider using the <strong>Chrome Extension</strong> instead. It often works better for Slack since you can sign in and navigate more easily in your regular browser.</p>
	</div>
	<div class="tips-section">
	  <h3>Understanding the Capture Page</h3>
	  <p>Social Stream uses a hidden browser page to capture chat. The <strong>🔄 Reload</strong> button refreshes this page if needed.</p>
	</div>
  `,
	discord: `
	<div class="tips-section">
	  <h3>Discord Requires Sign-in</h3>
	  <p>Discord chat capture requires you to be signed in to your server.</p>
	</div>
	<div class="tips-section">
	  <h3>If Chat Isn't Working</h3>
	  <ol>
		<li>Click <strong>👁️ Reveal capture page</strong> to see the hidden browser</li>
		<li>Make sure you're signed in and the channel is visible</li>
		<li>Check that messages are loading properly</li>
	  </ol>
	  <p><span class="tips-highlight">Alternative:</span> Consider using the <strong>Chrome Extension</strong> instead. It often works better for Discord since you can sign in and navigate more easily in your regular browser.</p>
	</div>
	<div class="tips-section">
	  <h3>Understanding the Capture Page</h3>
	  <p>Social Stream uses a hidden browser page to capture chat. The <strong>🔄 Reload</strong> button refreshes this page if needed.</p>
	</div>
  `,
	x: `
	<div class="tips-section">
	  <h3>X.com Requires Sign-in</h3>
	  <p>X.com chat capture requires you to be signed in. Click <strong>👁️ Show capture page</strong> and sign in if needed.</p>
	</div>
	<div class="tips-section">
	  <h3>Trouble Signing In?</h3>
	  <ul>
		<li>Try signing in with <strong>email + password</strong> instead of Google or other SSO providers</li>
		<li>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu (try Firefox or a newer Chrome version)</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Chat Not Capturing?</h3>
	  <p>Make sure you're on a page where the live chat/Space is visible. If chat is visible but not capturing, try <strong>🔄 Reload</strong>.</p>
	</div>
  `
};

const genericTipsContent = `
	<div class="tips-section">
	  <h3>Getting Started</h3>
	  <ol>
		<li>Click <strong>▶️ Activate source</strong> to start capturing</li>
		<li>If sign-in is required, click <strong>🔑 Sign-in</strong> first</li>
		<li>Click <strong>👁️ Show capture page</strong> to see the browser window and verify chat is visible</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>Troubleshooting</h3>
	  <ul>
		<li>If chat isn't capturing, click <strong>🔄 Reload</strong></li>
		<li>If sign-in fails, try using <strong>email + password</strong> instead of Google/SSO</li>
		<li>If sign-in is rejected as "invalid browser", try changing the <strong>User Agent</strong> via the ⚙️ settings menu</li>
		<li>Clear cache via the ⚙️ settings menu if having persistent issues</li>
	  </ul>
	</div>
`;

const instagramHostCaptureGuideContent = `
	<div class="tips-section">
	  <h3>If You Are The Host</h3>
	  <p>Instagram may hide chat on your own public live page. Use the producer page instead: the Instagram page you are publishing from, where the <strong>Comments</strong> tab is visible.</p>
	  <p>In the standalone app, that producer page must be open inside SSN's capture page. If you started the live from a normal desktop browser tab, use the Chrome Extension instead, or sign in with a different Instagram account to watch the live.</p>
	  <p>If you started the live from the mobile app, use a second Instagram account to view the live and capture comments.</p>
	</div>
`;

const sourceGuideTipsContent = {
	en: {
		tiktok: `
	<div class="tips-section">
	  <h3>What To Enter</h3>
	  <p>Use the TikTok username, with or without <strong>@</strong>, or paste the live/profile URL. For example: <code>flaquita44552</code>, <code>@flaquita44552</code>, or <code>https://www.tiktok.com/@flaquita44552/live</code>.</p>
	</div>
	<div class="tips-section">
	  <h3>Connection Modes</h3>
	  <ul>
		<li><span class="tips-highlight">TikTok WS / Auto:</span> Best first choice. It tries WebSocket and can fall back to Polling.</li>
		<li><span class="tips-highlight">Standard:</span> Opens TikTok in the app browser. Use this when you need to sign in, solve a CAPTCHA, or reply to chat.</li>
		<li><span class="tips-highlight">Polling:</span> Backup mode. No replies, and messages can arrive in batches.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>If Chat Does Not Appear</h3>
	  <ol>
		<li>Make sure the TikTok stream is actually live.</li>
		<li>Click <strong>Show capture page</strong>.</li>
		<li>Sign in or complete any verification TikTok shows.</li>
		<li>Make sure the live chat is visible, then click <strong>Reload</strong> if needed.</li>
	  </ol>
	</div>
  `,
		youtube: `
	<div class="tips-section">
	  <h3>What To Enter</h3>
	  <p>Use a YouTube handle, channel URL, or Video ID. If the stream is unlisted, add it by <strong>YouTube Video URL / ID</strong>; username discovery only finds public live or upcoming streams.</p>
	</div>
	<div class="tips-section">
	  <h3>How It Works</h3>
	  <ul>
		<li><span class="tips-highlight">Standard:</span> Opens the popout live chat page and captures what is visible there.</li>
		<li><span class="tips-highlight">WebSocket:</span> Uses YouTube's chat API. Sign in if YouTube asks.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>If It Does Not Capture</h3>
	  <ol>
		<li>Confirm the stream is live and public, or use the Video ID for unlisted streams.</li>
		<li>Click <strong>Reload</strong> after going live.</li>
		<li>If sign-in is rejected, try a different User Agent from the settings menu.</li>
	  </ol>
	</div>
  `,
		kick: `
	<div class="tips-section">
	  <h3>What To Enter</h3>
	  <p>Paste the Kick channel URL or enter the URL slug only. Use the part from the URL, such as <code>kick.com/koos-kaap</code> -> <code>koos-kaap</code>.</p>
	</div>
	<div class="tips-section">
	  <h3>Connection Modes</h3>
	  <ul>
		<li><span class="tips-highlight">Standard:</span> Opens the Kick popout chat page and captures the chat it sees.</li>
		<li><span class="tips-highlight">WebSocket:</span> Direct chat connection. Try this if Standard pauses, stops, or needs frequent refreshes.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>If Kick Pauses Or Stops</h3>
	  <ol>
		<li>Use <strong>Show capture page</strong> and confirm the Kick chat is still visible.</li>
		<li>Click <strong>Reload</strong> once.</li>
		<li>If it keeps happening, switch that source to <strong>WebSocket</strong> mode.</li>
		<li>Slow channels can look idle; testing with an active chat is easier.</li>
	  </ol>
	</div>
  `,
		facebook: `
	<div class="tips-section">
	  <h3>Facebook Requires Sign-in</h3>
	  <p>Click <strong>Sign-in</strong> or <strong>Show capture page</strong> and log in. Facebook does not always auto-load your live chat for you.</p>
	</div>
	<div class="tips-section">
	  <h3>How To Capture</h3>
	  <ol>
		<li>Activate the source.</li>
		<li>Open the capture page.</li>
		<li>Navigate to your actual Facebook live stream or Live Producer page.</li>
		<li>Make sure live chat is visible on that page. SSN captures the chat it can see.</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>If It Still Does Not Work</h3>
	  <p>Reload the capture page after the live chat is visible. If Facebook blocks the app browser, try changing the User Agent or use the Chrome extension instead.</p>
	</div>
  `,
		instagram: `
	<div class="tips-section">
	  <h3>Instagram Requires Sign-in</h3>
	  <p>Instagram usually requires you to be logged in. Use your main account or a separate bot account.</p>
	</div>
	<div class="tips-section">
	  <h3>How To Capture</h3>
	  <ol>
		<li>Enter the Instagram username and activate the source.</li>
		<li>Click <strong>Show capture page</strong>.</li>
		<li>Sign in if Instagram asks.</li>
		<li>Navigate inside the SSN app browser until the live video and comments are visible.</li>
	  </ol>
	  <p>If you are using the browser extension instead, open the live page in your normal browser. For the standalone app, the live page must be open inside SSN.</p>
	</div>
	<div class="tips-section">
	  <h3>If Comments Are Missing</h3>
	  <p>Make sure the account is currently live and the comments are visible, then click <strong>Reload</strong>.</p>
	</div>
  `
	},
	es: {
		tiktok: `
	<div class="tips-section">
	  <h3>Qué escribir</h3>
	  <p>Usa el usuario de TikTok, con o sin <strong>@</strong>, o pega la URL del live/perfil. Ejemplo: <code>flaquita44552</code>, <code>@flaquita44552</code> o <code>https://www.tiktok.com/@flaquita44552/live</code>.</p>
	</div>
	<div class="tips-section">
	  <h3>Modos de conexión</h3>
	  <ul>
		<li><span class="tips-highlight">TikTok WS / Auto:</span> Mejor opción inicial. Prueba WebSocket y puede volver a Polling.</li>
		<li><span class="tips-highlight">Standard:</span> Abre TikTok en el navegador de la app. Úsalo para iniciar sesión, resolver CAPTCHA o responder al chat.</li>
		<li><span class="tips-highlight">Polling:</span> Modo de respaldo. No permite respuestas y los mensajes pueden llegar por lotes.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Si no aparece el chat</h3>
	  <ol>
		<li>Confirma que el live de TikTok esté activo.</li>
		<li>Haz clic en <strong>Mostrar página de captura</strong>.</li>
		<li>Inicia sesión o completa la verificación que muestre TikTok.</li>
		<li>Asegúrate de que el chat esté visible y usa <strong>Recargar</strong> si hace falta.</li>
	  </ol>
	</div>
  `,
		youtube: `
	<div class="tips-section">
	  <h3>Qué escribir</h3>
	  <p>Usa el handle de YouTube, la URL del canal o el ID del video. Si el stream no está listado, agrégalo con <strong>URL / ID de video de YouTube</strong>; la búsqueda por usuario solo encuentra lives públicos o programados.</p>
	</div>
	<div class="tips-section">
	  <h3>Cómo funciona</h3>
	  <ul>
		<li><span class="tips-highlight">Standard:</span> Abre el chat emergente del live y captura lo que se ve ahí.</li>
		<li><span class="tips-highlight">WebSocket:</span> Usa la API de chat de YouTube. Inicia sesión si YouTube lo pide.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Si no captura</h3>
	  <ol>
		<li>Confirma que el stream esté live y público, o usa el ID del video si no está listado.</li>
		<li>Haz clic en <strong>Recargar</strong> después de salir en vivo.</li>
		<li>Si el inicio de sesión falla, prueba otro User Agent desde el menú de ajustes.</li>
	  </ol>
	</div>
  `,
		kick: `
	<div class="tips-section">
	  <h3>Qué escribir</h3>
	  <p>Pega la URL del canal de Kick o escribe solo el slug de la URL. Usa la parte de la URL, por ejemplo <code>kick.com/koos-kaap</code> -> <code>koos-kaap</code>.</p>
	</div>
	<div class="tips-section">
	  <h3>Modos de conexión</h3>
	  <ul>
		<li><span class="tips-highlight">Standard:</span> Abre el chat emergente de Kick y captura el chat visible.</li>
		<li><span class="tips-highlight">WebSocket:</span> Conexión directa al chat. Pruébalo si Standard se pausa, se detiene o necesita recargas frecuentes.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Si Kick se pausa o se detiene</h3>
	  <ol>
		<li>Usa <strong>Mostrar página de captura</strong> y confirma que el chat de Kick siga visible.</li>
		<li>Haz clic en <strong>Recargar</strong> una vez.</li>
		<li>Si vuelve a pasar, cambia esa fuente a <strong>WebSocket</strong>.</li>
		<li>En canales lentos puede parecer inactivo; es más fácil probar con un chat activo.</li>
	  </ol>
	</div>
  `,
		facebook: `
	<div class="tips-section">
	  <h3>Facebook requiere inicio de sesión</h3>
	  <p>Haz clic en <strong>Iniciar sesión</strong> o <strong>Mostrar página de captura</strong> y entra a Facebook. Facebook no siempre carga automáticamente tu live chat.</p>
	</div>
	<div class="tips-section">
	  <h3>Cómo capturar</h3>
	  <ol>
		<li>Activa la fuente.</li>
		<li>Abre la página de captura.</li>
		<li>Navega a tu live real de Facebook o a Live Producer.</li>
		<li>Asegúrate de que el chat en vivo esté visible. SSN captura el chat que puede ver.</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>Si aún no funciona</h3>
	  <p>Recarga la página de captura cuando el chat ya esté visible. Si Facebook bloquea el navegador de la app, prueba cambiar el User Agent o usa la extensión de Chrome.</p>
	</div>
  `,
		instagram: `
	<div class="tips-section">
	  <h3>Instagram requiere inicio de sesión</h3>
	  <p>Instagram normalmente requiere que inicies sesión. Puedes usar tu cuenta principal o una cuenta bot separada.</p>
	</div>
	<div class="tips-section">
	  <h3>Cómo capturar</h3>
	  <ol>
		<li>Escribe el usuario de Instagram y activa la fuente.</li>
		<li>Haz clic en <strong>Mostrar página de captura</strong>.</li>
		<li>Inicia sesión si Instagram lo pide.</li>
		<li>Navega dentro del navegador de SSN hasta que el live y los comentarios estén visibles.</li>
	  </ol>
	  <p>Si usas la extensión del navegador, abre el live en tu navegador normal. En la app standalone, el live debe estar abierto dentro de SSN.</p>
	</div>
	<div class="tips-section">
	  <h3>Si faltan comentarios</h3>
	  <p>Asegúrate de que la cuenta esté en vivo y que los comentarios estén visibles; luego haz clic en <strong>Recargar</strong>.</p>
	</div>
  `
	},
	"pt-BR": {
		tiktok: `
	<div class="tips-section">
	  <h3>O que digitar</h3>
	  <p>Use o usuário do TikTok, com ou sem <strong>@</strong>, ou cole a URL da live/perfil. Exemplo: <code>flaquita44552</code>, <code>@flaquita44552</code> ou <code>https://www.tiktok.com/@flaquita44552/live</code>.</p>
	</div>
	<div class="tips-section">
	  <h3>Modos de conexão</h3>
	  <ul>
		<li><span class="tips-highlight">TikTok WS / Auto:</span> Melhor primeira opção. Tenta WebSocket e pode voltar para Polling.</li>
		<li><span class="tips-highlight">Standard:</span> Abre o TikTok no navegador do app. Use para entrar na conta, resolver CAPTCHA ou responder ao chat.</li>
		<li><span class="tips-highlight">Polling:</span> Modo reserva. Não permite respostas e as mensagens podem chegar em lotes.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Se o chat não aparecer</h3>
	  <ol>
		<li>Confirme que a live do TikTok está ativa.</li>
		<li>Clique em <strong>Mostrar página de captura</strong>.</li>
		<li>Entre na conta ou complete a verificação que o TikTok mostrar.</li>
		<li>Garanta que o chat esteja visível e clique em <strong>Recarregar</strong> se precisar.</li>
	  </ol>
	</div>
  `,
		youtube: `
	<div class="tips-section">
	  <h3>O que digitar</h3>
	  <p>Use o handle do YouTube, a URL do canal ou o ID do vídeo. Se a live não estiver listada, adicione por <strong>URL / ID do vídeo do YouTube</strong>; a busca por usuário só encontra lives públicas ou agendadas.</p>
	</div>
	<div class="tips-section">
	  <h3>Como funciona</h3>
	  <ul>
		<li><span class="tips-highlight">Standard:</span> Abre o chat popout da live e captura o que aparece ali.</li>
		<li><span class="tips-highlight">WebSocket:</span> Usa a API de chat do YouTube. Entre na conta se o YouTube pedir.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Se não capturar</h3>
	  <ol>
		<li>Confirme que a live está ao vivo e pública, ou use o ID do vídeo se ela não estiver listada.</li>
		<li>Clique em <strong>Recarregar</strong> depois de iniciar a live.</li>
		<li>Se o login falhar, teste outro User Agent no menu de ajustes.</li>
	  </ol>
	</div>
  `,
		kick: `
	<div class="tips-section">
	  <h3>O que digitar</h3>
	  <p>Cole a URL do canal da Kick ou digite apenas o slug da URL. Use a parte da URL, como <code>kick.com/koos-kaap</code> -> <code>koos-kaap</code>.</p>
	</div>
	<div class="tips-section">
	  <h3>Modos de conexão</h3>
	  <ul>
		<li><span class="tips-highlight">Standard:</span> Abre o chat popout da Kick e captura o chat visível.</li>
		<li><span class="tips-highlight">WebSocket:</span> Conexão direta com o chat. Tente se o Standard pausar, parar ou precisar de recargas frequentes.</li>
	  </ul>
	</div>
	<div class="tips-section">
	  <h3>Se a Kick pausar ou parar</h3>
	  <ol>
		<li>Use <strong>Mostrar página de captura</strong> e confirme que o chat da Kick ainda está visível.</li>
		<li>Clique em <strong>Recarregar</strong> uma vez.</li>
		<li>Se continuar acontecendo, mude a fonte para <strong>WebSocket</strong>.</li>
		<li>Canais lentos podem parecer parados; é mais fácil testar com um chat ativo.</li>
	  </ol>
	</div>
  `,
		facebook: `
	<div class="tips-section">
	  <h3>Facebook exige login</h3>
	  <p>Clique em <strong>Entrar</strong> ou <strong>Mostrar página de captura</strong> e faça login no Facebook. O Facebook nem sempre carrega o live chat automaticamente.</p>
	</div>
	<div class="tips-section">
	  <h3>Como capturar</h3>
	  <ol>
		<li>Ative a fonte.</li>
		<li>Abra a página de captura.</li>
		<li>Navegue até sua live real do Facebook ou até o Live Producer.</li>
		<li>Garanta que o chat ao vivo esteja visível. O SSN captura o chat que consegue ver.</li>
	  </ol>
	</div>
	<div class="tips-section">
	  <h3>Se ainda não funcionar</h3>
	  <p>Recarregue a página de captura depois que o chat estiver visível. Se o Facebook bloquear o navegador do app, tente mudar o User Agent ou use a extensão do Chrome.</p>
	</div>
  `,
		instagram: `
	<div class="tips-section">
	  <h3>Instagram exige login</h3>
	  <p>O Instagram normalmente exige login. Use sua conta principal ou uma conta bot separada.</p>
	</div>
	<div class="tips-section">
	  <h3>Como capturar</h3>
	  <ol>
		<li>Digite o usuário do Instagram e ative a fonte.</li>
		<li>Clique em <strong>Mostrar página de captura</strong>.</li>
		<li>Entre na conta se o Instagram pedir.</li>
		<li>Navegue dentro do navegador do SSN até a live e os comentários ficarem visíveis.</li>
	  </ol>
	  <p>Se estiver usando a extensão do navegador, abra a live no navegador normal. No app standalone, a live precisa estar aberta dentro do SSN.</p>
	</div>
	<div class="tips-section">
	  <h3>Se faltarem comentarios</h3>
	  <p>Confirme que a conta está ao vivo e que os comentários estão visíveis; depois clique em <strong>Recarregar</strong>.</p>
	</div>
  `
	}
};

sourceGuideTipsContent.en.instagramlive = sourceGuideTipsContent.en.instagram;
sourceGuideTipsContent.es.instagramlive = sourceGuideTipsContent.es.instagram;
sourceGuideTipsContent["pt-BR"].instagramlive = sourceGuideTipsContent["pt-BR"].instagram;

const sourceGuideTitlePrefixes = {
	en: "Guide for",
	cs: "Průvodce pro",
	fr: "Guide pour",
	de: "Anleitung für",
	it: "Guida per",
	ja: "ガイド:",
	"zh-CN": "指南:",
	"zh-TW": "指南:",
	ko: "가이드:",
	ru: "Руководство для",
	tr: "Kılavuz:",
	uk: "Посібник для",
	es: "Guía para",
	"pt-BR": "Guia para"
};

const sourceGuideCloseLabels = {
	en: "Close",
	cs: "Zavřít",
	fr: "Fermer",
	de: "Schließen",
	it: "Chiudi",
	ja: "閉じる",
	"zh-CN": "关闭",
	"zh-TW": "關閉",
	ko: "닫기",
	ru: "Закрыть",
	tr: "Kapat",
	uk: "Закрити",
	es: "Cerrar",
	"pt-BR": "Fechar"
};

const sourceGuideFallbackPlatformLabels = {
	en: "This Source",
	cs: "Tento zdroj",
	fr: "Cette source",
	de: "Diese Quelle",
	it: "Questa sorgente",
	ja: "このソース",
	"zh-CN": "此来源",
	"zh-TW": "此來源",
	ko: "이 소스",
	ru: "Этот источник",
	tr: "Bu kaynak",
	uk: "Це джерело",
	es: "Esta fuente",
	"pt-BR": "Esta fonte"
};

const sourceGuidePlatformLabels = {
	instagramlive: "Instagram Live",
	youtubeshorts: "YouTube Shorts"
};

const sourceGuideCompactContent = {
	cs: {
		tiktok: {
			heading: "TikTok",
			items: [
				"Zadejte uživatelské jméno TikTok s @ nebo bez něj, případně vložte URL profilu/live.",
				"Nejprve zkuste TikTok WS / Auto. Režim Standard otevře TikTok v prohlížeči aplikace pro přihlášení, ověření nebo odpovědi v chatu.",
				"Když chat chybí, zobrazte stránku zachytávání, přihlaste se nebo dokončete ověření a ověřte, že je live chat vidět."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Zadejte handle, URL kanálu nebo ID videa. U neveřejných streamů použijte přímo URL nebo ID videa.",
				"Standard zachytává viditelný popout chat. WebSocket používá chat API YouTube a může vyžadovat přihlášení.",
				"Pokud se nic nezachytává, ověřte, že je stream živý a veřejný, nebo po spuštění live klikněte na Reload."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Vložte URL kanálu Kick nebo jen slug z adresy, například koos-kaap z kick.com/koos-kaap.",
				"Standard zachytává viditelný popout chat. Pokud se zastavuje nebo často potřebuje obnovit, přepněte zdroj na WebSocket.",
				"U pomalého chatu může zdroj vypadat neaktivně; testujte raději s kanálem, kde chat právě běží."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook obvykle vyžaduje přihlášení. Otevřete stránku zachytávání a přihlaste se.",
				"Přejděte na skutečný live stream nebo Live Producer a ujistěte se, že je live chat na stránce vidět.",
				"SSN zachytí pouze chat, který prohlížeč aplikace vidí. Po zobrazení chatu zkuste Reload."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram obvykle vyžaduje přihlášení. Můžete použít hlavní účet nebo samostatný bot účet.",
				"Ve standalone aplikaci musí být live stránka otevřená uvnitř SSN, ne jen v běžném prohlížeči.",
				"Po přihlášení přejděte na live video, zkontrolujte viditelné komentáře a podle potřeby klikněte na Reload."
			]
		}
	},
	fr: {
		tiktok: {
			heading: "TikTok",
			items: [
				"Saisissez le nom d'utilisateur TikTok avec ou sans @, ou collez l'URL du profil/live.",
				"Essayez d'abord TikTok WS / Auto. Le mode Standard ouvre TikTok dans le navigateur de l'app pour se connecter, valider un contrôle ou répondre au chat.",
				"Si le chat n'apparaît pas, affichez la page de capture, connectez-vous ou terminez la vérification, puis vérifiez que le live chat est visible."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Utilisez un handle, une URL de chaîne ou l'ID de la vidéo. Pour un stream non répertorié, ajoutez directement l'URL ou l'ID vidéo.",
				"Standard capture le chat popout visible. WebSocket utilise l'API de chat YouTube et peut demander une connexion.",
				"Si rien n'est capturé, confirmez que le stream est en direct et public, ou cliquez sur Reload après le début du live."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Collez l'URL de la chaîne Kick ou seulement le slug de l'URL, par exemple koos-kaap depuis kick.com/koos-kaap.",
				"Standard capture le chat popout visible. Si le chat se met en pause ou demande souvent un rafraîchissement, passez la source en WebSocket.",
				"Un chat lent peut sembler inactif; testez avec une chaîne dont le chat bouge."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook demande généralement une connexion. Ouvrez la page de capture et connectez-vous.",
				"Allez sur votre vrai live Facebook ou dans Live Producer, puis assurez-vous que le live chat est visible.",
				"SSN capture uniquement le chat visible dans le navigateur de l'app. Une fois le chat visible, essayez Reload."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram demande généralement une connexion. Utilisez votre compte principal ou un compte bot séparé.",
				"Dans l'app standalone, la page live doit être ouverte dans SSN, pas seulement dans votre navigateur habituel.",
				"Après connexion, ouvrez la vidéo live, vérifiez que les commentaires sont visibles, puis utilisez Reload si nécessaire."
			]
		}
	},
	de: {
		tiktok: {
			heading: "TikTok",
			items: [
				"Gib den TikTok-Benutzernamen mit oder ohne @ ein, oder füge die Profil-/Live-URL ein.",
				"Versuche zuerst TikTok WS / Auto. Standard öffnet TikTok im App-Browser, damit du dich anmelden, eine Prüfung abschließen oder im Chat antworten kannst.",
				"Wenn kein Chat erscheint, zeige die Capture-Seite, melde dich an oder schließe die Prüfung ab und stelle sicher, dass der Live-Chat sichtbar ist."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Verwende einen Handle, eine Kanal-URL oder die Video-ID. Für nicht gelistete Streams nutze direkt die Video-URL oder ID.",
				"Standard erfasst den sichtbaren Popout-Chat. WebSocket nutzt die YouTube-Chat-API und kann eine Anmeldung benötigen.",
				"Wenn nichts erfasst wird, prüfe, ob der Stream live und öffentlich ist, oder klicke nach dem Start auf Reload."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Füge die Kick-Kanal-URL ein oder nur den URL-Slug, zum Beispiel koos-kaap aus kick.com/koos-kaap.",
				"Standard erfasst den sichtbaren Popout-Chat. Wenn er pausiert oder oft neu geladen werden muss, stelle die Quelle auf WebSocket um.",
				"Langsame Chats können inaktiv wirken; teste am besten mit einem Kanal, in dem gerade geschrieben wird."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook erfordert meistens eine Anmeldung. Öffne die Capture-Seite und melde dich an.",
				"Gehe zu deinem tatsächlichen Facebook-Live-Stream oder Live Producer und stelle sicher, dass der Live-Chat sichtbar ist.",
				"SSN erfasst nur den Chat, den der App-Browser sehen kann. Sobald der Chat sichtbar ist, versuche Reload."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram erfordert meistens eine Anmeldung. Nutze dein Hauptkonto oder ein separates Bot-Konto.",
				"In der Standalone-App muss die Live-Seite innerhalb von SSN geöffnet sein, nicht nur im normalen Browser.",
				"Öffne nach der Anmeldung das Live-Video, prüfe sichtbare Kommentare und klicke bei Bedarf auf Reload."
			]
		}
	},
	it: {
		tiktok: {
			heading: "TikTok",
			items: [
				"Inserisci il nome utente TikTok con o senza @, oppure incolla l'URL del profilo/live.",
				"Prova prima TikTok WS / Auto. Standard apre TikTok nel browser dell'app per accedere, completare verifiche o rispondere in chat.",
				"Se la chat non appare, mostra la pagina di cattura, accedi o completa la verifica e controlla che la live chat sia visibile."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Usa un handle, l'URL del canale o l'ID del video. Per stream non in elenco, usa direttamente URL o ID del video.",
				"Standard cattura la chat popout visibile. WebSocket usa l'API chat di YouTube e può richiedere l'accesso.",
				"Se non cattura nulla, verifica che lo stream sia live e pubblico, oppure clicca Reload dopo l'avvio della live."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Incolla l'URL del canale Kick o solo lo slug, ad esempio koos-kaap da kick.com/koos-kaap.",
				"Standard cattura la chat popout visibile. Se si ferma o richiede spesso refresh, passa la sorgente a WebSocket.",
				"Una chat lenta può sembrare inattiva; è più semplice testare con un canale dove la chat è attiva."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook di solito richiede l'accesso. Apri la pagina di cattura e accedi.",
				"Vai al tuo vero live Facebook o a Live Producer e assicurati che la live chat sia visibile.",
				"SSN cattura solo la chat visibile nel browser dell'app. Quando la chat è visibile, prova Reload."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram di solito richiede l'accesso. Puoi usare l'account principale o un account bot separato.",
				"Nell'app standalone la pagina live deve essere aperta dentro SSN, non solo nel browser normale.",
				"Dopo l'accesso, apri il video live, verifica che i commenti siano visibili e usa Reload se necessario."
			]
		}
	},
	ja: {
		tiktok: {
			heading: "TikTok",
			items: [
				"TikTok のユーザー名を @ あり/なしで入力するか、プロフィールまたはライブの URL を貼り付けます。",
				"最初は TikTok WS / Auto を試してください。Standard はアプリ内ブラウザーで TikTok を開き、ログイン、認証、チャット返信に使えます。",
				"チャットが出ない場合はキャプチャページを表示し、ログインまたは認証を完了して、ライブチャットが見えていることを確認します。"
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"ハンドル、チャンネル URL、または動画 ID を入力します。限定公開の配信は動画 URL または ID で追加します。",
				"Standard は表示されているポップアウトチャットを取得します。WebSocket は YouTube のチャット API を使い、ログインが必要な場合があります。",
				"取得できない場合は、配信がライブかつ公開中か確認し、開始後に Reload を押します。"
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Kick チャンネル URL、または kick.com/koos-kaap の koos-kaap のような URL スラッグだけを入力します。",
				"Standard は表示されているポップアウトチャットを取得します。停止や頻繁な再読み込みが起きる場合は WebSocket に切り替えます。",
				"流れが遅いチャットは停止して見えることがあります。動きのあるチャットでテストすると確認しやすいです。"
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook は通常ログインが必要です。キャプチャページを開いてログインしてください。",
				"実際の Facebook ライブまたは Live Producer に移動し、ライブチャットがページに表示されていることを確認します。",
				"SSN はアプリ内ブラウザーに見えているチャットだけを取得します。チャット表示後に Reload を試してください。"
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram は通常ログインが必要です。メインアカウントまたは別の bot アカウントを使えます。",
				"スタンドアロンアプリでは、通常のブラウザーではなく SSN 内でライブページを開く必要があります。",
				"ログイン後にライブ動画を開き、コメントが表示されていることを確認して、必要なら Reload を押します。"
			]
		}
	},
	"zh-CN": {
		tiktok: {
			heading: "TikTok",
			items: [
				"输入 TikTok 用户名，可以带 @ 或不带 @，也可以粘贴个人主页或直播 URL。",
				"建议先试 TikTok WS / Auto。Standard 会在应用内浏览器打开 TikTok，方便登录、完成验证或回复聊天。",
				"如果没有聊天，显示采集页面，登录或完成验证，并确认直播聊天在页面中可见。"
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"输入 handle、频道 URL 或视频 ID。未公开直播请直接使用视频 URL 或 ID 添加。",
				"Standard 采集可见的弹出聊天页。WebSocket 使用 YouTube 聊天 API，可能需要登录。",
				"如果没有采集到内容，请确认直播已开始且公开，或开播后点击 Reload。"
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"粘贴 Kick 频道 URL，或只输入 URL slug，例如 kick.com/koos-kaap 中的 koos-kaap。",
				"Standard 采集可见的弹出聊天。如果它暂停、停止或经常需要刷新，请把该来源切换到 WebSocket。",
				"慢速频道可能看起来像停止了；用聊天活跃的频道测试更容易判断。"
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook 通常需要登录。打开采集页面并登录。",
				"进入你的实际 Facebook 直播或 Live Producer，并确认直播聊天在页面中可见。",
				"SSN 只能采集应用内浏览器能看到的聊天。聊天可见后可以尝试 Reload。"
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram 通常需要登录。可以使用主账号或单独的 bot 账号。",
				"在独立应用中，直播页面必须在 SSN 内打开，而不是只在普通浏览器中打开。",
				"登录后进入直播视频，确认评论可见，必要时点击 Reload。"
			]
		}
	},
	"zh-TW": {
		tiktok: {
			heading: "TikTok",
			items: [
				"輸入 TikTok 使用者名稱，可包含 @ 或不包含 @，也可以貼上個人頁面或直播 URL。",
				"建議先試 TikTok WS / Auto。Standard 會在應用程式內瀏覽器開啟 TikTok，方便登入、完成驗證或回覆聊天室。",
				"如果沒有聊天室，請顯示擷取頁面、登入或完成驗證，並確認直播聊天室已顯示。"
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"輸入 handle、頻道 URL 或影片 ID。未公開直播請直接用影片 URL 或 ID 加入。",
				"Standard 擷取可見的彈出聊天室。WebSocket 使用 YouTube 聊天 API，可能需要登入。",
				"如果沒有擷取到內容，請確認直播已開始且公開，或開播後按 Reload。"
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"貼上 Kick 頻道 URL，或只輸入 URL slug，例如 kick.com/koos-kaap 裡的 koos-kaap。",
				"Standard 擷取可見的彈出聊天室。如果暫停、停止或常要重新整理，請把來源切到 WebSocket。",
				"慢速聊天室可能看起來像停止；用聊天室活躍的頻道測試較容易判斷。"
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook 通常需要登入。開啟擷取頁面並登入。",
				"前往實際的 Facebook 直播或 Live Producer，並確認直播聊天室在頁面中可見。",
				"SSN 只能擷取應用程式內瀏覽器看得到的聊天。聊天室顯示後可試 Reload。"
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram 通常需要登入。可以使用主帳號或單獨的 bot 帳號。",
				"在 standalone app 中，直播頁面必須在 SSN 內開啟，不能只在一般瀏覽器中開啟。",
				"登入後進入直播影片，確認留言可見，必要時按 Reload。"
			]
		}
	},
	ko: {
		tiktok: {
			heading: "TikTok",
			items: [
				"TikTok 사용자 이름을 @ 포함 또는 제외로 입력하거나 프로필/라이브 URL을 붙여넣으세요.",
				"먼저 TikTok WS / Auto를 사용해 보세요. Standard는 앱 브라우저에서 TikTok을 열어 로그인, 인증, 채팅 답장을 할 수 있게 합니다.",
				"채팅이 보이지 않으면 캡처 페이지를 표시하고 로그인 또는 인증을 완료한 뒤 라이브 채팅이 보이는지 확인하세요."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"핸들, 채널 URL 또는 영상 ID를 입력하세요. 일부 공개 스트림은 영상 URL 또는 ID로 직접 추가하세요.",
				"Standard는 보이는 팝아웃 채팅을 캡처합니다. WebSocket은 YouTube 채팅 API를 사용하며 로그인이 필요할 수 있습니다.",
				"캡처되지 않으면 스트림이 라이브이고 공개인지 확인하거나, 라이브 시작 후 Reload를 클릭하세요."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Kick 채널 URL을 붙여넣거나 kick.com/koos-kaap의 koos-kaap처럼 URL slug만 입력하세요.",
				"Standard는 보이는 팝아웃 채팅을 캡처합니다. 멈추거나 자주 새로고침해야 하면 소스를 WebSocket으로 바꾸세요.",
				"느린 채널은 멈춘 것처럼 보일 수 있습니다. 채팅이 활발한 채널로 테스트하면 더 쉽습니다."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook은 보통 로그인이 필요합니다. 캡처 페이지를 열고 로그인하세요.",
				"실제 Facebook 라이브 또는 Live Producer로 이동한 뒤 라이브 채팅이 페이지에 보이는지 확인하세요.",
				"SSN은 앱 브라우저에 보이는 채팅만 캡처합니다. 채팅이 보이면 Reload를 시도하세요."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram은 보통 로그인이 필요합니다. 기본 계정이나 별도 bot 계정을 사용할 수 있습니다.",
				"Standalone 앱에서는 라이브 페이지가 일반 브라우저가 아니라 SSN 안에서 열려 있어야 합니다.",
				"로그인 후 라이브 영상을 열고 댓글이 보이는지 확인한 다음 필요하면 Reload를 누르세요."
			]
		}
	},
	ru: {
		tiktok: {
			heading: "TikTok",
			items: [
				"Введите имя пользователя TikTok с @ или без него либо вставьте URL профиля/live.",
				"Сначала попробуйте TikTok WS / Auto. Standard открывает TikTok во встроенном браузере для входа, проверки или ответа в чате.",
				"Если чат не появился, покажите страницу захвата, войдите или завершите проверку и убедитесь, что live-чат виден."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Введите handle, URL канала или ID видео. Для стрима по ссылке используйте URL или ID видео напрямую.",
				"Standard захватывает видимый popout-чат. WebSocket использует API чата YouTube и может потребовать вход.",
				"Если захвата нет, проверьте, что стрим идет live и публичный, или нажмите Reload после начала трансляции."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Вставьте URL канала Kick или только slug из URL, например koos-kaap из kick.com/koos-kaap.",
				"Standard захватывает видимый popout-чат. Если он останавливается или часто требует обновления, переключите источник на WebSocket.",
				"Медленный чат может выглядеть неактивным; проще тестировать на канале с активным чатом."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook обычно требует вход. Откройте страницу захвата и войдите.",
				"Перейдите к настоящей Facebook-трансляции или Live Producer и убедитесь, что live-чат виден на странице.",
				"SSN захватывает только чат, который видит встроенный браузер. Когда чат виден, попробуйте Reload."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram обычно требует вход. Можно использовать основной аккаунт или отдельный bot-аккаунт.",
				"В standalone-приложении страница live должна быть открыта внутри SSN, а не только в обычном браузере.",
				"После входа откройте live-видео, проверьте, что комментарии видны, и при необходимости нажмите Reload."
			]
		}
	},
	tr: {
		tiktok: {
			heading: "TikTok",
			items: [
				"TikTok kullanıcı adını @ ile veya @ olmadan girin ya da profil/live URL'sini yapıştırın.",
				"Önce TikTok WS / Auto deneyin. Standard, giriş yapmak, doğrulamayı tamamlamak veya sohbete yanıt vermek için TikTok'u uygulama tarayıcısında açar.",
				"Sohbet görünmüyorsa yakalama sayfasını gösterin, giriş yapın veya doğrulamayı tamamlayın ve live chat'in görünür olduğundan emin olun."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Handle, kanal URL'si veya video ID girin. Liste dışı yayınlar için video URL'sini veya ID'yi doğrudan kullanın.",
				"Standard görünen popout sohbeti yakalar. WebSocket YouTube chat API'sini kullanır ve giriş isteyebilir.",
				"Yakalama yoksa yayının canlı ve herkese açık olduğunu kontrol edin veya canlı başladıktan sonra Reload'a tıklayın."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Kick kanal URL'sini yapıştırın veya kick.com/koos-kaap içindeki koos-kaap gibi sadece URL slug'ını girin.",
				"Standard görünen popout sohbeti yakalar. Duruyor ya da sık yenileme istiyorsa kaynağı WebSocket'e alın.",
				"Yavaş sohbetler duruyormuş gibi görünebilir; aktif sohbetli bir kanalla test etmek daha kolaydır."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook genellikle giriş ister. Yakalama sayfasını açıp giriş yapın.",
				"Gerçek Facebook live yayınına veya Live Producer'a gidin ve live chat'in sayfada göründüğünden emin olun.",
				"SSN yalnızca uygulama tarayıcısının gördüğü sohbeti yakalar. Sohbet göründükten sonra Reload deneyin."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram genellikle giriş ister. Ana hesabınızı veya ayrı bir bot hesabını kullanabilirsiniz.",
				"Standalone uygulamada live sayfası normal tarayıcıda değil, SSN içinde açık olmalıdır.",
				"Girişten sonra live videoyu açın, yorumların göründüğünü kontrol edin ve gerekirse Reload'a basın."
			]
		}
	},
	uk: {
		tiktok: {
			heading: "TikTok",
			items: [
				"Введіть ім'я користувача TikTok з @ або без нього, або вставте URL профілю/live.",
				"Спершу спробуйте TikTok WS / Auto. Standard відкриває TikTok у браузері програми для входу, перевірки або відповіді в чаті.",
				"Якщо чат не з'явився, покажіть сторінку захоплення, увійдіть або завершіть перевірку й переконайтеся, що live-чат видимий."
			]
		},
		youtube: {
			heading: "YouTube",
			items: [
				"Введіть handle, URL каналу або ID відео. Для непублічних трансляцій використовуйте URL або ID відео напряму.",
				"Standard захоплює видимий popout-чат. WebSocket використовує API чату YouTube і може вимагати входу.",
				"Якщо захоплення немає, перевірте, що трансляція live і публічна, або натисніть Reload після старту ефіру."
			]
		},
		kick: {
			heading: "Kick",
			items: [
				"Вставте URL каналу Kick або лише slug з URL, наприклад koos-kaap з kick.com/koos-kaap.",
				"Standard захоплює видимий popout-чат. Якщо він зупиняється або часто потребує оновлення, перемкніть джерело на WebSocket.",
				"Повільний чат може виглядати неактивним; простіше тестувати на каналі з активним чатом."
			]
		},
		facebook: {
			heading: "Facebook",
			items: [
				"Facebook зазвичай вимагає входу. Відкрийте сторінку захоплення та увійдіть.",
				"Перейдіть до реальної Facebook-трансляції або Live Producer і переконайтеся, що live-чат видимий на сторінці.",
				"SSN захоплює лише чат, який бачить браузер програми. Коли чат видимий, спробуйте Reload."
			]
		},
		instagram: {
			heading: "Instagram",
			items: [
				"Instagram зазвичай вимагає входу. Можна використати основний акаунт або окремий bot-акаунт.",
				"У standalone app live-сторінка має бути відкрита всередині SSN, а не лише у звичайному браузері.",
				"Після входу відкрийте live-відео, перевірте, що коментарі видимі, і за потреби натисніть Reload."
			]
		}
	}
};

function normalizeSourceGuideLanguage(lang) {
	const value = String(lang || "").trim().toLowerCase();
	if (value.startsWith("pt")) return "pt-BR";
	if (value.startsWith("es")) return "es";
	if (value.startsWith("zh-tw") || value.startsWith("zh-hant") || value === "zh_tw") return "zh-TW";
	if (value.startsWith("zh")) return "zh-CN";
	if (value.startsWith("cs")) return "cs";
	if (value.startsWith("fr")) return "fr";
	if (value.startsWith("de")) return "de";
	if (value.startsWith("it")) return "it";
	if (value.startsWith("ja")) return "ja";
	if (value.startsWith("ko")) return "ko";
	if (value.startsWith("ru")) return "ru";
	if (value.startsWith("tr")) return "tr";
	if (value.startsWith("uk")) return "uk";
	return "en";
}

function getSourceGuideLanguage() {
	try {
		return normalizeSourceGuideLanguage(localStorage.getItem("language") || navigator.language || "en");
	} catch (_) {
		return "en";
	}
}

function renderSourceGuideCompactContent(guide) {
	if (!guide || !Array.isArray(guide.items)) return "";
	return `
	<div class="tips-section">
	  <h3>${guide.heading}</h3>
	  <ul>
		${guide.items.map((item) => `<li>${item}</li>`).join("")}
	  </ul>
	</div>
  `;
}

function getSourceGuidePlatformLabel(platform, lang = "en") {
	if (!platform) return sourceGuideFallbackPlatformLabels[lang] || sourceGuideFallbackPlatformLabels.en;
	return sourceGuidePlatformLabels[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
}

function getSourceGuideContent(platform, lang) {
	const contentKey = platform === "instagramlive" ? "instagram" : platform;
	const compactContent = sourceGuideCompactContent[lang]?.[contentKey];
	let content = "";
	if (compactContent) {
		content = renderSourceGuideCompactContent(compactContent);
	} else {
		const languageContent = sourceGuideTipsContent[lang] || sourceGuideTipsContent.en;
		content = languageContent[platform]
			|| languageContent[contentKey]
			|| sourceGuideTipsContent.en[platform]
			|| sourceGuideTipsContent.en[contentKey]
			|| tipsContent[platform]
			|| genericTipsContent;
	}
	if (contentKey === "instagram" && !content.includes("If You Are The Host")) {
		content += instagramHostCaptureGuideContent;
	}
	return content;
}

function showTips(ele) {
	showTipsModal(ele.parentNode.dataset.target || ele.dataset.target || ele.parentNode.parentNode.dataset.target);
}
function showTipsModal(platform) {
	const modal = document.getElementById('tipsModal');
	const modalTitle = document.getElementById('tipsModalTitle');
	const modalContent = document.getElementById('tipsModalContent');
	const lang = getSourceGuideLanguage();
	const platformName = getSourceGuidePlatformLabel(platform, lang);
	modalTitle.textContent = `${sourceGuideTitlePrefixes[lang] || sourceGuideTitlePrefixes.en} ${platformName}`;
	modalContent.innerHTML = getSourceGuideContent(platform, lang);
	const closeButton = modal.querySelector('[onclick="closeTipsModal()"]');
	if (closeButton) {
		closeButton.textContent = sourceGuideCloseLabels[lang] || sourceGuideCloseLabels.en;
	}
	modal.classList.remove('hidden');
}
function closeTipsModal() {
	document.getElementById('tipsModal').classList.add('hidden');
}
window.closeTipsModal = closeTipsModal;
	
const Toast = {
	container: null,

	init() {
		this.container = document.getElementById('toastContainer');
		if (!this.container) {
			this.container = document.createElement('div');
			this.container.id = 'toastContainer';
			this.container.className = 'toast-container';
			document.body.appendChild(this.container);
		}
	},

	show(options) {
		this.init();

		// Handle when show is called with just strings
		if (typeof options === 'string') {
			options = {
				message: options
			};
		}

		const defaults = {
			title: '',
			message: '',
			type: 'info', // info, success, warning, error
			duration: 12000, // ms
			showProgress: true,
			onClose: null
		};

		const settings = {
			...defaults,
			...options
		};

		// Create toast element
		const toast = document.createElement('div');
		toast.className = `toast toast-${settings.type}`;

		// Create content
		let iconClass = '';
		switch (settings.type) {
			case 'success':
				iconClass = 'la-check-circle';
				break;
			case 'warning':
				iconClass = 'la-exclamation-triangle';
				break;
			case 'error':
				iconClass = 'la-exclamation-circle';
				break;
			default:
				iconClass = 'la-info-circle';
		}

		// Debug
		console.log("Creating toast with:", {
			title: settings.title,
			message: settings.message,
			type: settings.type
		});

		toast.innerHTML = `
	  <div class="toast-icon">
		<i class="las ${iconClass}"></i>
	  </div>
	  <div class="toast-content">
		${settings.title ? `<div class="toast-title">${settings.title}</div>` : ''}
		<p class="toast-message">${String(settings.message)}</p>
	  </div>
	  <button class="toast-close">
		<i class="las la-times"></i>
	  </button>
	  ${settings.showProgress ? '<div class="toast-progress"><div class="toast-progress-bar"></div></div>' : ''}
	`;

		// Add to container
		this.container.appendChild(toast);

		// Animate progress bar
		const progressBar = toast.querySelector('.toast-progress-bar');
		if (progressBar && settings.showProgress && settings.duration > 0) {
			progressBar.style.animation = `progress ${settings.duration / 1000}s linear forwards`;
		}

		// Show toast with slight delay to trigger animation
		setTimeout(() => {
			toast.classList.add('show');
		}, 10);

		// Set up close button
		const closeBtn = toast.querySelector('.toast-close');
		if (closeBtn) {
			closeBtn.addEventListener('click', () => {
				this.hide(toast);
				if (typeof settings.onClose === 'function') {
					settings.onClose();
				}
			});
		}

		// Auto-close after duration
		if (settings.duration > 0) {
			setTimeout(() => {
				if (toast.parentNode) {
					this.hide(toast);
					if (typeof settings.onClose === 'function') {
						settings.onClose();
					}
				}
			}, settings.duration);
		}

		return toast;
	},

	hide(toast) {
		toast.classList.remove('show');

		// Remove element after animation
		setTimeout(() => {
			if (toast.parentNode) {
				toast.parentNode.removeChild(toast);
			}
		}, 300);
	},

	success(message, title = '', options = {}) {
		if (typeof title === 'object') {
			options = title;
			title = '';
		}
		return this.show({
			...options,
			title,
			message,
			type: 'success'
		});
	},

	info(message, title = '', options = {}) {
		if (typeof title === 'object') {
			options = title;
			title = '';
		}
		return this.show({
			...options,
			title,
			message,
			type: 'info'
		});
	},

	warning(message, title = '', options = {}) {
		if (typeof title === 'object') {
			options = title;
			title = '';
		}
		return this.show({
			...options,
			title,
			message,
			type: 'warning'
		});
	},

	error(message, title = '', options = {}) {
		if (typeof title === 'object') {
			options = title;
			title = '';
		}
		return this.show({
			...options,
			title,
			message,
			type: 'error'
		});
	}
};
function getDefaultConfig() {
	const platform = navigator.platform.toLowerCase();
	const baseConfig = {
		"global": {
				"userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
			"size": {
				"width": 600,
				"height": 450
			},
			"signin": {
				"userAgent": "Chrome",
				"size": {
					"width": 600,
					"height": 600
				},
				"enforceSigninCSP": true
			}
		}
	};
	if (platform.includes('mac')) {
			baseConfig.global.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
	} else if (platform.includes('linux')) {
			baseConfig.global.userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
	} else { // Default to Windows NT 10
			baseConfig.global.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
	}
	return baseConfig;
}

const WELCOME_GUIDE_URL = "https://www.youtube.com/watch?v=VpD2pnZVYF0";
const WELCOME_FRAME_SCROLLBAR_STYLE = `
html,
body {
	scrollbar-width: thin;
	scrollbar-color: #ffffff40 #00000080;
}

::-webkit-scrollbar {
	width: 6px;
	height: 6px;
	background-color: #00000080;
	-webkit-border-radius: 100px;
}

::-webkit-scrollbar:hover {
	background-color: #00000080;
}

::-webkit-scrollbar-thumb {
	background-color: #ffffff40;
	-webkit-border-radius: 100px;
}

::-webkit-scrollbar-thumb:active {
	background-color: #ffffff80;
}

::-webkit-scrollbar-thumb:vertical {
	min-height: 10px;
}

::-webkit-scrollbar-thumb:horizontal {
	min-width: 10px;
}
`;

function normalizeWelcomeFrameUrl(url) {
	if (typeof url !== "string") return "";
	if (/^[a-zA-Z]:[\\/]/.test(url)) {
		try {
			const { pathToFileURL } = require("url");
			return pathToFileURL(url).href;
		} catch (_) {
			return `file:///${url.replace(/\\/g, "/")}`;
		}
	}
	return url;
}

function getWelcomeFrameLanguageCode() {
	try {
		if (typeof getSocialStreamLanguageCode === "function") {
			return getSocialStreamLanguageCode();
		}
	} catch (_) { }
	try {
		if (typeof normalizeLanguage === "function") {
			return normalizeLanguage(localStorage.getItem("language") || navigator.language || "en-us");
		}
	} catch (_) { }
	return "en-us";
}

function addWelcomeFrameLanguageParam(url, langCode) {
	if (!url || typeof url !== "string" || !langCode) return url;
	try {
		if (typeof setUrlQueryParamPreservingFlags === "function") {
			return setUrlQueryParamPreservingFlags(url, "ln", langCode);
		}
	} catch (_) { }
	try {
		const parsed = new URL(url, window.location ? window.location.href : undefined);
		parsed.searchParams.set("ln", langCode);
		return parsed.toString();
	} catch (_) {
		const separator = url.includes("?") ? "&" : "?";
		return `${url}${separator}ln=${encodeURIComponent(langCode)}`;
	}
}

function addWelcomeFrameBaseHref(html, resolvedUrl) {
	if (!html || !resolvedUrl) return html;
	if (/<base\s/i.test(html)) return html;
	const baseHref = resolvedUrl.href.replace(/[^/?#]*([?#].*)?$/, "");
	return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
}

function addWelcomeFrameLanguageScript(html, langCode) {
	if (!html || typeof html !== "string" || html.includes('__ssapp-welcome-language')) return html;
	const languageScript = `<script id="__ssapp-welcome-language">window.SSAPP_WELCOME_LANGUAGE=${JSON.stringify(langCode || "en-us")};<\/script>`;
	if (/<\/head>/i.test(html)) {
		return html.replace(/<\/head>/i, `${languageScript}</head>`);
	}
	return `${languageScript}${html}`;
}

function addWelcomeFrameScrollbarStyles(html) {
	if (!html || typeof html !== "string") return html;
	if (html.includes("__ssapp-welcome-scrollbars")) return html;
	const styleTag = `<style id="__ssapp-welcome-scrollbars">${WELCOME_FRAME_SCROLLBAR_STYLE}</style>`;
	if (/<\/head>/i.test(html)) {
		return html.replace(/<\/head>/i, `${styleTag}</head>`);
	}
	return `${styleTag}${html}`;
}

function patchWelcomeFrameHtml(html, options = {}) {
	if (!html || typeof html !== "string") return html;
	let patchedHtml = html.replace(/allow="([^"]*)"/gi, (match, value) => {
		const filteredTokens = value
			.split(";")
			.map((token) => token.trim())
			.filter(Boolean)
			.filter((token) => token.toLowerCase() !== "web-share");
		return `allow="${filteredTokens.join("; ")}"`;
	});
	if (options.useVideoFallback) {
		if (!patchedHtml.includes(".video-fallback-link")) {
			const fallbackStyles = `
        .video-fallback-link {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            overflow: hidden;
            border-radius: 8px;
            text-decoration: none;
            background: linear-gradient(135deg, #1f2937, #111827);
            border: 1px solid rgba(255, 255, 255, 0.14);
        }
        .video-fallback-label {
            padding: 12px 18px;
            border-radius: 999px;
            background: rgba(0, 0, 0, 0.72);
            color: #fff;
            font-weight: bold;
            letter-spacing: 0.01em;
        }
        `;
			patchedHtml = patchedHtml.replace(/<\/style>/i, `${fallbackStyles}</style>`);
		}
        const fallbackMarkup = `
        <div class="video-container">
            <a class="video-fallback-link" href="${WELCOME_GUIDE_URL}" target="_blank" rel="noopener noreferrer">
                <span class="video-fallback-label" data-i18n-html="video.fallback">Watch the walkthrough on YouTube</span>
            </a>
        </div>`;
		patchedHtml = patchedHtml.replace(
			/<div class="video-container">\s*<iframe[\s\S]*?src="https:\/\/www\.youtube\.com\/embed\/VpD2pnZVYF0"[\s\S]*?<\/iframe>\s*<\/div>/i,
			fallbackMarkup
		);
	}
	return patchedHtml;
}

async function readWelcomeFrameFileContent(fileUrl) {
	const fs = require("fs").promises;
	const parsedUrl = new URL(fileUrl);
	let filePath = decodeURIComponent(parsedUrl.pathname || "");
	const isWindows = typeof process !== "undefined" && process.platform === "win32";
	if (isWindows) {
		filePath = filePath.replace(/\//g, "\\");
		if (/^\\[a-zA-Z]:\\/.test(filePath)) {
			filePath = filePath.slice(1);
		}
		if (parsedUrl.hostname) {
			filePath = `\\\\${parsedUrl.hostname}${filePath}`;
		}
	}
	return fs.readFile(filePath, "utf8");
}

async function loadWelcomeFrameContent(frame, url, options = {}) {
	if (!frame) return;
	const langCode = options.language || getWelcomeFrameLanguageCode();
	const normalizedUrl = addWelcomeFrameLanguageParam(normalizeWelcomeFrameUrl(url), langCode);
	frame.dataset.welcomeLanguage = langCode;
	const resetToSrc = (targetUrl) => {
		try {
			frame.removeAttribute('srcdoc');
		} catch (_) {
			// Ignore if attribute is absent.
		}
		frame.src = targetUrl || '';
	};
	if (!normalizedUrl) {
		resetToSrc('');
		return;
	}
	if (normalizedUrl.startsWith('file://')) {
		try {
			const resolvedUrl = new URL(normalizedUrl, window.location ? window.location.href : undefined);
			let html = await readWelcomeFrameFileContent(normalizedUrl);
			html = patchWelcomeFrameHtml(html, { useVideoFallback: true });
			html = addWelcomeFrameBaseHref(html, resolvedUrl);
			html = addWelcomeFrameLanguageScript(html, langCode);
			html = addWelcomeFrameScrollbarStyles(html);
			frame.srcdoc = html;
			return;
		} catch (err) {
			console.warn('Failed to inline local welcome frame content; falling back to iframe src.', err);
			resetToSrc(normalizedUrl);
			return;
		}
	}
	try {
		const response = await fetch(normalizedUrl, { credentials: 'omit' });
		if (!response.ok) {
			throw new Error(`Unexpected status ${response.status}`);
		}
		const resolvedUrl = (() => {
			try {
				return new URL(response.url || normalizedUrl, window.location ? window.location.href : undefined);
			} catch (_) {
				return null;
			}
		})();
		let html = await response.text();
		html = patchWelcomeFrameHtml(html, { useVideoFallback: true });
		html = addWelcomeFrameBaseHref(html, resolvedUrl);
		html = addWelcomeFrameLanguageScript(html, langCode);
		html = addWelcomeFrameScrollbarStyles(html);
		frame.srcdoc = html;
	} catch (err) {
		console.warn('Failed to fetch welcome frame content; falling back to iframe src.', err);
		resetToSrc(normalizedUrl);
	}
}

function manageWelcomePage() {
  const hasEntries = document.querySelectorAll('#sources .entry:not(#sourceTemplate)').length > 0;
  let welcomeFrame = document.getElementById('welcomeFrame');
  if (!hasEntries) {
	if (!welcomeFrame) {
	  welcomeFrame = document.createElement('iframe');
	  welcomeFrame.style.cssText = 'width: 100%; height: calc(100vh - 130px); border: none; margin-top: 15px;';
	  welcomeFrame.id = 'welcomeFrame';
		  welcomeFrame.setAttribute("allowtransparency", "true");
	  const welcomeURL =
			sourcemode ?
			`${sourcemode}/docs/ssapp.html` : devmode ?
			`file:///C:/Users/steve/Code/social_stream/docs/ssapp.html` :
			isBetaMode ?
			`https://socialstream.ninja/beta/docs/ssapp.html` :
			`https://socialstream.ninja/docs/ssapp.html`;
	  welcomeFrame.dataset.welcomeBaseUrl = welcomeURL;
	  loadWelcomeFrameContent(welcomeFrame, welcomeURL, { language: getWelcomeFrameLanguageCode() });
	  welcomeFrame.onerror = ()=>{
		  welcomeFrame.style.display = "none";
	  }
	  const insertAfter = document.querySelector('#sources p');
	  if (insertAfter && insertAfter.nextSibling) {
		insertAfter.parentNode.insertBefore(welcomeFrame, insertAfter.nextSibling);
	  } else if (document.getElementById('sources')) { // Ensure #sources exists
		document.getElementById('sources').appendChild(welcomeFrame);
	  }
	}
  } else if (welcomeFrame) {
	welcomeFrame.remove();
  }
}
