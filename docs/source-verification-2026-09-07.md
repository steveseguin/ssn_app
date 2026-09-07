# Source verification - 2026-09-07

Read-only checks in SSApp 0.4.25, using the current local source checkout, isolated signed-out profiles and real IPC-created source windows. Standard/DOM capture was tested; this is not a WebSocket/API-mode certification. No messages, reactions, bids, purchases or sign-ins were submitted. Live samples lasted 60-75 seconds; initial directory/login checks lasted 30-60 seconds.

A page loading is not a capture pass. Counts below represent actual platform payloads received by SSN and passed to `sendToDestinations`, not synthetic chat. They do not certify every badge, donation, event, reconnect, hidden-window or long-session behavior. Sites with no new captured messages remain inconclusive rather than automatically broken.

## Confirmed capture

| Site | Tested page | Evidence |
| --- | --- | --- |
| Twitch | `https://www.twitch.tv/popout/lydiaviolet/chat?popout=` | 3 chat messages and 2 community-highlight events reached the output path in 60 seconds. |
| Bilibili.com | `https://live.bilibili.com/4894773` | 144 chat messages reached the output path in the final 60-second sample. Its payload type is `bilibili`. |
| Picarto | `https://picarto.tv/chatpopout/HuckleberryBleu/public` | 1 new chat message reached the output path in 75 seconds. |
| CHZZK | `https://chzzk.naver.com/live/4de764d9dad3b25602284be6db3ac647/chat` | 419 chat messages reached the output path in 75 seconds. |
| TikTok | `https://www.tiktok.com/@asmrnoa/live` | 16 chat messages and 3 event rows reached the output path in 75 seconds, without signing in. Standard mode only. |
| Mixcloud | `https://www.mixcloud.com/live/MissBlu6/chat/` | 3 chat messages reached the output path in 75 seconds. |
| TwitCasting | `https://twitcasting.tv/TJ_Ajianking` | 95 chat messages reached the output path in 75 seconds. Signing in is required to post, but not to capture these messages. |
| GoodGame | `https://goodgame.ru/Verloin/chat` | 3 chat messages reached the output path in 75 seconds. This is an existing Other-source integration, not a new sidebar button. |
| eBay Live | `https://www.ebay.com/ebaylive/events/cYo9vCy37w2Ow20E/chat` | 18 auction updates and 25 commerce updates reached the output path in the final 60-second sample. No new chat payloads occurred in this sample. Earlier eBay functional tests also verified seller selection, GraphQL listing details, switching/closing capture windows and persistence after restart. |

## Partial evidence / quiet samples

| Site | Tested page | Follow-up |
| --- | --- | --- |
| VK Video Live | `https://live.vkvideo.ru/highmyside/only-chat` | 2 real chat messages reached SSN's incoming-message handler in a separate 60-second probe. That probe did not instrument destinations. A later 75-second sample captured none. Route and chat UI confirmed; longer/repeated capture testing would strengthen the result. |
| Velora | `https://velora.tv/electriccyder` | 1 subscription event reached the output path. Ordinary new chat was not confirmed. Standard mode only; the app normally offers WebSocket mode too. |
| BIGO Live | `https://www.bigo.tv/1082331356`, `https://www.bigo.tv/170098804` | Correct broadcaster watch pages and chat containers, but only the welcome notice appeared. No capture confirmed as a guest. Retry with an active conversation and, if necessary, a signed-in session. |
| Loco | `https://loco.com/chat/streamers/archax13`, `https://loco.com/chat/streamers/tartazone` | Read-only chat pop-outs loaded, but showed only the welcome text. No captured messages. Verify with a known active conversation. |
| Kick | `https://kick.com/popout/asmongold/chat` | Chat and history loaded; no captured payloads during the 60-second Standard-mode sample. Not a WebSocket-mode test. |
| VPZONE | `https://vpzone.tv/watch/cuteavalanche` | Correct live kitten channel loaded; no captured messages in 75 seconds. Standard mode only. |
| SOOP | Input `https://play.sooplive.com/bigfishtv/` | Correctly resolved to `https://play.sooplive.com/bigfishtv/296940097?vtype=chat`. Chat-only UI loaded; no captured messages in 75 seconds. |
| Nimo | `https://www.nimo.tv/popout/chat/1563885463` | Correct MasonFreeman chat welcome message appeared. No captured messages in 75 seconds. |
| Beamstream | `https://beamstream.gg/spooky-boogy/chat` | Chat-only page and history loaded. No captured messages in 75 seconds. |
| Rumble | Input `https://rumble.com/v7f69pq-pikaboo-gaming.html` through the app's video-source activation | SSApp resolved it to `https://rumble.com/chat/popup/445094072`, titled Chat: PIKABOO GAMING. Chat loaded with a cookie banner; no captured messages in 75 seconds. |

## Requires access, a current stream link, or investigation

| Site | Observed result | Next check |
| --- | --- | --- |
| Discord | Continuing in Browser led to `https://discord.com/login?redirect_to=%2Fchannels%2F%40me`. | Sign in and test a channel the account can access. |
| Instagram | `https://www.instagram.com/instagram/live/` redirected to login. | Signed-in test with a currently live account. |
| X | `https://x.com/NASA/livechat` redirected to X's login onboarding. | Signed-in test; the final chat route was not verified beyond the login gate. |
| YouNow | `https://www.younow.com/FabbyFlorez99` identified a live broadcast but presented a sign-in overlay. | Signed-in capture test. |
| Facebook | `https://www.facebook.com/NASA/live` loaded the correct page with past live videos. | Test a currently live video and its comments; this offline sample cannot establish capture. |
| Bilibili.tv / Bstation | `https://www.bilibili.tv/en/live` returned the site's 404 page. No current international live-room URL was found. | Check whether international live streaming still exists at another route. The combined Bilibili chooser preserves this existing integration; its room-ID-to-URL mapping was tested, but international live capture was not. |
| DLive | `https://dlive.tv/` redirected to `/offline`, headed DLive Service Discontinued and stating it is no longer in operation. | No new sidebar option added. |
| Parti | The home page now presents prediction markets; no streamer/live-chat link was found in the inspected navigation. | Check current streaming URLs and compatibility of the existing integration. This does not prove every legacy stream URL is broken. |
| Arena Social | Public feed loaded; no live-stream link was found in the sampled navigation. | Supply a known active live link and account access if needed. |
| Piczel | `/` redirected to `/streams`; public directory loaded. | A live chat session was not sampled. Test a known channel's `/chat/<name>` URL. |
| Whatnot | `/` redirected to the `/en-GB` marketing/download landing page. | Test with an exact active `/live/<id>` URL and account access if required. No event capture was attempted from the marketing page. |
| Odysee | The exploratory `/$/livestreams` directory URL returned 404. | Locate a current active stream and use its supported `/$/popout/...` chat URL. This is a discovery failure, not proof the capture script is broken. |
| LinkedIn | The exploratory `/video/live/` URL returned Page not found. | Test with an exact active event/post URL, likely in a signed-in session. This is not evidence that all LinkedIn Live capture fails. |

### YouTube follow-up

The first Sky News chat ID returned YouTube's error page, and an old Lofi Girl ID returned SSApp's no-active-chat guidance. Opening `https://www.youtube.com/@LofiGirl/live` found current live recommendations. The current recommended stream's `https://www.youtube.com/live_chat?is_popout=1&v=JD-kMIpDfnY` correctly loaded a real chat with 27 existing message rows. Those rows/body length stayed unchanged throughout the 75-second sample, and no payloads were captured. URL/display validation passed; new-message capture remains inconclusive. Retry with a known busy current chat; do not interpret the stale IDs as proof YouTube is broken.

## Setup/UI validation

- New BIGO, Loco and VK Video Live dialogs generated the intended URLs and activated real source windows.
- The single Bilibili button correctly maps its China/international choices to their existing source types and scripts; wrong-site URLs are rejected.
- Add other source focuses the URL field immediately. Extra guidance and the supported-sites link are collapsed under Which URL should I use? The help link opened the actual guide successfully.
- Normal and compact dialogs, source ordering and screenshots were visually checked. Popular platforms remain at the top; eBay, VPZONE, Velora and Picarto sit lower; Add other source is at the bottom.
- eBay seller/event selection and process-restart persistence passed the checked-in real-app tests.
- No site-specific capture fixes were made during this audit. Failures and inconclusive cases are left for Steve to investigate, as requested.

## Repeating the audit

`tests/electron/source-live-audit.js` accepts `SSAPP_AUDIT_CASES`, the path to a JSON array of `{ "target": "...", "url": "https://..." }` records. Optional `sourceFile`, `countType`, `videoId` and `clickText` support source-name differences, normal video-source discovery and an observed read-only UI step. `SSAPP_AUDIT_SECONDS` sets each group's sample duration. It opens at most three capture windows per group in an isolated profile and saves screenshots and a detailed local report to `%TEMP%/ssapp-live-audit-*`.

The report covers 33 sites including the earlier DLive check; it is not an audit of every script in Social Stream. PeerTube instances, private meetings/workspaces, authenticated modes, sending messages, TTS, and long-running reconnect behavior were not tested here. Screenshot/raw-message artifacts remain local rather than being committed.

## Follow-up: pasted URLs, VK and RPLAY

- Fixed pasted channel/watch/chat URL handling for Velora, Picarto, Mixcloud, TwitCasting, YouNow, CHZZK, Nimo, SOOP, Beamstream, X/Twitter and Arena. Known routes are reduced to the channel handle before source creation; wrong-site URLs and home pages are rejected. Existing specialized parsers remain in place for other platforms. Individual recorded-video links are not inferred.
- VK Video Live setup now also accepts channel stream URLs ending in `/stream/sl_<number>` and opens the channel's `/only-chat` page. Existing VK Play host aliases still work.
- Real SSApp renderer tests created and inspected saved source rows for all eleven added URL parsers, checked invalid inputs and exercised the existing setup dialogs. These mapping checks do not claim live capture on all eleven sites.
- A separate real source-window run used pasted URLs through `newSource`, then activated the generated rows normally: TwitCasting delivered 131 messages, Mixcloud 3, and CHZZK 119 during approximately one minute. Screenshots were saved; Mixcloud displayed a login invitation while public chat capture continued.
- VK recheck: `brm/only-chat` and the old `live.vkplay.ru/highmyside/only-chat` URL loaded chat, with the latter redirecting to `live.vkvideo.ru`. Four new `vkvideo` messages reached both processing and destination dispatch across the two windows. Counts are aggregated by source type, not separately attributed to each channel. No VK capture-code change was necessary.
- The separate `vklive` adapter remains unverified: `https://vk.com/video` redirected to the public `https://vkvideo.ru/` directory, not a live chat. An actual affected live-video URL is needed to reproduce the reported problem with that adapter.
- RPLAY is not currently registered in the manifest and has no capture adapter. Both supplied URLs for `6a84d9e47b5ac2d8daac9e29` loaded in real SSApp source windows. The pop-out stayed on "Waiting for live chats..." for 45 seconds; the watch page showed the stream and a Live Chat section but no messages. This is a page-loading check only; no RPLAY capture support was added or claimed. A sample with incoming chat is needed to implement and validate it.

Follow-up artifacts: `%TEMP%/ssapp-source-setup-BVhCqT`, `%TEMP%/ssapp-live-audit-vxYhaY`, `%TEMP%/ssapp-live-audit-HSCpI6` and `%TEMP%/ssapp-live-audit-BeBsHo`. The live audit also accepts optional `input`, which exercises normal source creation from a pasted URL; `url` remains the expected generated URL. All follow-up test apps used isolated profiles and were closed after testing. No messages, logins, bids or reactions were sent.
