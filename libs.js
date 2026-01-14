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
                const match = html.match(/video_id:\s*(\d+)/);
                if (match && match[1]) return match[1];
            }
        }
    } catch (e) {
        console.warn('nodefetch getRumbleVideoId failed, falling back to renderer fetch:', e?.message || e);
    }
    try {
        const res = await fetch(url, { headers, credentials: 'omit', cache: 'no-store' });
        const html = await res.text();
        const match = html.match(/video_id:\s*(\d+)/);
        if (match && match[1]) return match[1];
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
            const match = html.match(/video_id:\s*(\d+)/);
            if (match && match[1]) {
                console.log(`Found Rumble chat ID: ${match[1]} for video: ${videoId}`);
                return match[1];
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
        const match = html.match(/video_id:\s*(\d+)/);
        if (match && match[1]) {
            console.log(`Found Rumble chat ID: ${match[1]} for video: ${videoId}`);
            return match[1];
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
				if (!matches.includes(dom.js[0])) {
					matches.push(dom.js[0]);
				}
			}
		});
	});
	return matches;
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
	rumble: `
	<div class="tips-section">
	  <h3>You Must Be Live First</h3>
	  <p>Rumble chat only works when you are already streaming. <strong>Go live before activating</strong> this source.</p>
	</div>
	<div class="tips-section">
	  <h3>If Username Doesn't Work</h3>
	  <p>Adding by username requires a lookup that can sometimes fail. Try adding the chat URL directly instead:</p>
	  <ol>
		<li>Open your Rumble stream in a browser</li>
		<li>Find the chat popup URL (right-click on chat, look for popup option)</li>
		<li>Add a new source using <strong>"Other"</strong> and paste the chat URL</li>
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

function showTips(ele) {
	showTipsModal(ele.parentNode.dataset.target || ele.dataset.target || ele.parentNode.parentNode.dataset.target);
}
function showTipsModal(platform) {
	const modal = document.getElementById('tipsModal');
	const modalTitle = document.getElementById('tipsModalTitle');
	const modalContent = document.getElementById('tipsModalContent');
	const platformName = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'This Source';
	modalTitle.textContent = `Tips for ${platformName}`;
	modalContent.innerHTML = tipsContent[platform] || genericTipsContent;
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
			duration: 5000, // ms
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
				"userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
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
			baseConfig.global.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
	} else if (platform.includes('linux')) {
			baseConfig.global.userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
	} else { // Default to Windows NT 10
			baseConfig.global.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
	}
	return baseConfig;
}

async function loadWelcomeFrameContent(frame, url) {
	if (!frame) return;
	const resetToSrc = (targetUrl) => {
		try {
			frame.removeAttribute('srcdoc');
		} catch (_) {
			// Ignore if attribute is absent.
		}
		frame.src = targetUrl || '';
	};
	if (!url || url.startsWith('file://')) {
		resetToSrc(url || '');
		return;
	}
	const currentOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : null;
	const shouldInlineResponse = (response, resolvedUrl) => {
		const normalized = (value) => (value || '').trim().toLowerCase();
		const xFrameOptions = normalized(response.headers.get('x-frame-options'));
		if (xFrameOptions.includes('deny')) {
			return true;
		}
		if (xFrameOptions.includes('sameorigin')) {
			if (!resolvedUrl || !currentOrigin || resolvedUrl.origin !== currentOrigin) {
				return true;
			}
		}
		const csp = response.headers.get('content-security-policy');
		if (csp) {
			const frameAncestorsMatch = csp.toLowerCase().match(/frame-ancestors([^;]*)/);
			if (frameAncestorsMatch) {
				const directive = frameAncestorsMatch[1].trim();
				if (!directive || directive === "'none'" || directive === "none") {
					return true;
				}
				const tokens = directive
					.split(/\s+/)
					.filter(Boolean)
					.map((token) => token.replace(/^'+|'+$/g, '').toLowerCase());
				if (tokens.includes('*')) {
					return false;
				}
				if (tokens.includes('self')) {
					if (!resolvedUrl || !currentOrigin || resolvedUrl.origin !== currentOrigin) {
						return true;
					}
					return false;
				}
				if (!currentOrigin) {
					return true;
				}
				return !tokens.includes(currentOrigin.toLowerCase());
			}
		}
		return false;
	};
	try {
		const response = await fetch(url, { credentials: 'omit' });
		if (!response.ok) {
			throw new Error(`Unexpected status ${response.status}`);
		}
		const resolvedUrl = (() => {
			try {
				return new URL(response.url || url, window.location ? window.location.href : undefined);
			} catch (_) {
				return null;
			}
		})();
		const forceInline = shouldInlineResponse(response, resolvedUrl);
		if (!forceInline) {
			resetToSrc((resolvedUrl && resolvedUrl.href) || url);
			return;
		}
		let html = await response.text();
		html = html.replace(/allow="[^"]*"/gi, '');
		if (resolvedUrl) {
			const baseHref = `${resolvedUrl.origin}${resolvedUrl.pathname.replace(/[^/]*$/, '')}`;
			if (!/<base\s/i.test(html)) {
				html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
			}
		}
		frame.srcdoc = html;
	} catch (err) {
		console.warn('Failed to fetch welcome frame content; falling back to iframe src.', err);
		resetToSrc(url);
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
	  loadWelcomeFrameContent(welcomeFrame, welcomeURL);
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
