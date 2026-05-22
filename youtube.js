// Force a consistent language so our scrape keyword checks (LIVE/UPCOMING/etc.) behave the same across locales.
const YT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const YOUTUBE_STREAM_DISCOVERY_CACHE_TTL_MS = 60000;
const youtubeStreamDiscoveryCache = new Map();
const youtubeStreamDiscoveryInflight = new Map();
const MANUAL_YOUTUBE_DISCOVERY_CACHE_TTL_MS = 5000;
const manualYouTubeDiscoveryCache = new Map();
const manualYouTubeDiscoveryInflight = new Map();

function cloneYouTubeStreams(streams) {
    if (!Array.isArray(streams)) return [];
    return streams.map(stream => (stream && typeof stream === 'object') ? { ...stream } : stream);
}

function getYouTubeStreamDiscoveryCacheKey(identifier, options = {}) {
    return JSON.stringify({
        identifier: String(identifier || '').trim(),
        isChannelOnly: !!options.isChannelOnly,
        isUsernameOnly: !!options.isUsernameOnly,
        isShortDefault: !!options.isShortDefault
    });
}

function getYouTubeStreamSortTimestamp(stream) {
    if (!stream || typeof stream !== 'object') return Number.MAX_SAFE_INTEGER;
    let value = stream.actualStartTime || stream.scheduledStartTime || stream.publishedAt || 0;
    if (typeof value === 'string') {
        const parsedDate = Date.parse(value);
        if (!Number.isNaN(parsedDate)) {
            return parsedDate;
        }
        value = Number(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1e12 ? value * 1000 : value;
    }
    return Number.MAX_SAFE_INTEGER;
}

function sortYouTubeStreams(streams) {
    const sorted = cloneYouTubeStreams(streams);
    sorted.sort((a, b) => {
        const statusA = a && typeof a.status === 'string' ? a.status : '';
        const statusB = b && typeof b.status === 'string' ? b.status : '';
        const rank = (status) => {
            if (status === 'live') return 0;
            if (status === 'upcoming') return 1;
            if (status === 'ended') return 2;
            return 3;
        };
        const rankDiff = rank(statusA) - rank(statusB);
        if (rankDiff) return rankDiff;
        return getYouTubeStreamSortTimestamp(a) - getYouTubeStreamSortTimestamp(b);
    });
    return sorted;
}

function isYouTubeTransientNetworkError(value) {
    const text = [
        value?.error,
        value?.message,
        value?.code,
        value?.errno,
        value?.type,
        typeof value === 'string' ? value : ''
    ].filter(Boolean).join(' ').toLowerCase();

    if (!text) return false;
    return [
        'err_name_not_resolved',
        'enotfound',
        'eai_again',
        'etimedout',
        'econnreset',
        'econnrefused',
        'network timeout',
        'socket hang up'
    ].some(token => text.includes(token));
}

function createYouTubeDiscoveryNetworkError(fetchUrl, response) {
    const message = response?.error || response?.message || 'Unable to reach YouTube';
    const error = new Error(`YouTube network/DNS error while fetching ${fetchUrl}: ${message}`);
    error.code = 'SSAPP_YOUTUBE_DISCOVERY_NETWORK';
    error.fetchUrl = fetchUrl;
    error.response = response || null;
    return error;
}

function isYouTubeDiscoveryNetworkError(error) {
    return error && error.code === 'SSAPP_YOUTUBE_DISCOVERY_NETWORK';
}

function mergeYouTubeStreams(primaryStreams = [], fallbackStreams = [], isShortDefault = false) {
    const combined = [];
    const seenVideoIds = new Set();

    const appendStream = (stream) => {
        if (!stream || !stream.videoId || seenVideoIds.has(stream.videoId)) return;
        const normalized = { ...stream };
        if (typeof normalized.isShort !== 'boolean') {
            normalized.isShort = isShortDefault;
        }
        combined.push(normalized);
        seenVideoIds.add(normalized.videoId);
    };

    primaryStreams.forEach(appendStream);
    fallbackStreams.forEach(appendStream);

    return sortYouTubeStreams(combined);
}

async function fetchYouTubeLiveStreamsFromApi(identifier, options = {}) {
  try {
	const { isChannelOnly = false, isUsernameOnly = false } = options;
	let apiUrl = `https://api.socialstream.ninja/youtube/streams?username=${encodeURIComponent(identifier)}`;
	if (isChannelOnly) {
	  apiUrl += '&channelsonly';
	} else if (isUsernameOnly) {
	  apiUrl += '&usernameonly';
	}
	const response = await fetch(apiUrl);
    if (!response.ok) {
        console.error(`API Error for ${identifier}: ${response.status} ${response.statusText}`);
        const errorBody = await response.text();
        console.error("API Error Body:", errorBody);
        return [];
    }
	const data = await response.json();
	if (!data.success || !Array.isArray(data.data)) {
      console.warn(`API call for ${identifier} not successful or data is not an array:`, data);
	  return [];
	}
	const live = [];
	const upcoming = [];
	data.data.forEach(video => {
      if (video && typeof video.status === 'string') {
        if (video.status === 'live') {
          live.push(video);
        } else if (video.status === 'upcoming') {
          upcoming.push(video);
        }
      } else {
          console.warn("Skipping video due to missing or invalid status:", video);
      }
	});
	live.sort((a, b) => new Date(a.actualStartTime) - new Date(b.actualStartTime));
	upcoming.sort((a, b) => new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime));
	return [...live, ...upcoming];
  } catch (error) {
	console.error(`General Error fetching YouTube Live Streams for ${identifier}:`, error);
	return [];
  }
}

async function discoverYouTubeStreamsForManualAction(username, isShortDefault = false, isChannelName = false) {
    const cacheKey = getYouTubeStreamDiscoveryCacheKey(username, {
        isChannelOnly: isChannelName,
        isUsernameOnly: !isChannelName && !username.startsWith("UC"),
        isShortDefault
    });
    const cached = manualYouTubeDiscoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cloneYouTubeStreams(cached.streams);
    }

    if (manualYouTubeDiscoveryInflight.has(cacheKey)) {
        const pending = await manualYouTubeDiscoveryInflight.get(cacheKey);
        return cloneYouTubeStreams(pending);
    }

    const request = (async () => {
        const streamsFromApi = await fetchYouTubeLiveStreamsFromApi(username, {
            isChannelOnly: isChannelName,
            isUsernameOnly: !isChannelName && !username.startsWith("UC")
        });
        let streamsFromScrape = [];

        if (!streamsFromApi || streamsFromApi.length === 0) {
            streamsFromScrape = await fetchYoutube(username, false, { forceSearch: isChannelName });
            if (!Array.isArray(streamsFromScrape) || !streamsFromScrape.length) {
                streamsFromScrape = await fetchYoutube(username, true, { forceSearch: isChannelName }) || [];
            }
        }

        const combinedStreams = [...streamsFromApi];
        streamsFromScrape.forEach(scrapedStream => {
            if (!combinedStreams.some(apiStream => apiStream.videoId === scrapedStream.videoId)) {
                if (typeof scrapedStream.isShort !== 'boolean') {
                    scrapedStream.isShort = isShortDefault;
                }
                combinedStreams.push(scrapedStream);
            }
        });

        return combinedStreams;
    })().finally(() => {
        manualYouTubeDiscoveryInflight.delete(cacheKey);
    });

    manualYouTubeDiscoveryInflight.set(cacheKey, request);
    const streams = await request;
    manualYouTubeDiscoveryCache.set(cacheKey, {
        expiresAt: Date.now() + MANUAL_YOUTUBE_DISCOVERY_CACHE_TTL_MS,
        streams: cloneYouTubeStreams(streams)
    });

    return cloneYouTubeStreams(streams);
}

class YouTubeStreamSelector {
    constructor() {
        console.log("YouTubeStreamSelector constructor called");
        this.modal = document.getElementById('ytStreamModal');
        this.streamList = document.getElementById('ytStreamList');
        this.closeButton = document.querySelector('.yt-stream-close');
        this.cancelButton = document.getElementById('ytCancelButton');
        this.activateButton = document.getElementById('ytActivateButton');
        console.log("Modal elements:", {
            modal: this.modal,
            streamList: this.streamList,
            closeButton: this.closeButton,
            cancelButton: this.cancelButton,
            activateButton: this.activateButton
        });
        this.selectedStreams = new Set();
        this.streams = [];
        this.currentUsernameForGroup = null; 
        this.currentIsShortDefault = false;  

        if (this.closeButton) this.closeButton.addEventListener('click', () => this.hide());
        if (this.cancelButton) this.cancelButton.addEventListener('click', () => this.hide());
        if (this.activateButton) {
            console.log("Activate button found:", this.activateButton);
            this.activateButton.addEventListener('click', () => {
                console.log("Activate button clicked!");
                this.handleActivation();
            });
        } else {
            console.error("Activate button not found!");
        }
    }

    async show(streams, username, isShortDefault = false, autoActivate = false) { 
        this.currentUsernameForGroup = username;
        this.currentIsShortDefault = isShortDefault;

        if (autoActivate) {
            return streams
                .filter(stream => !stateManager.isVideoIdAdded(stream.videoId)) 
                .map(stream => ({ 
                    videoId: stream.videoId,
                    title: stream.title,
                    isShort: stream.isShort 
                }));
        }
        return new Promise((resolve, reject) => {
            try {
                console.log("Setting up promise in show()");
                this.resolvePromise = resolve;
                this.rejectPromise = reject;
                this.streams = [...streams];
                this.selectedStreams.clear();
                this.streamList.innerHTML = '';

                this.createStreamElements(streams, username).then(() => {
                    console.log("Stream elements created, showing modal");
                    if (this.modal) this.modal.style.display = 'block';
                }).catch(error => {
                    console.error("Error creating stream elements in modal:", error);
                    this.hide();
                    reject(error);
                });
            } catch (error) {
                console.error("Error in YouTubeStreamSelector show method:", error);
                reject(error);
            }
        });
    }

    getVideoStatus(status, viewers) { 
        if (status === 'live') return 'live';
        if (status === 'upcoming') return 'upcoming';
        if (status === 'ended') return 'ended';
        if (viewers && viewers > 0) return 'live'; 
        return 'upcoming'; 
    }
    formatViewers(count) { 
        try {
            if (typeof count !== 'number') return "?";
            if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
            if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
            return `${count}`;
        } catch (e) {
            return "?";
        }
    }
    formatScheduledTime(timeString) {
         try {
            if (!timeString) return "";
            const date = new Date(timeString);
            if (isNaN(date.getTime())) return ""; 

            const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
            const now = new Date();
            const diffMs = date - now;
            const diffMins = Math.floor(diffMs / (1000 * 60));

            let relativeTime = "";
            if (diffMins < -60) { 
                relativeTime = "(already started)";
            } else if (diffMins < 0) { 
                relativeTime = "(starting now / recently started)";
            } else if (diffMins < 1) {
                relativeTime = "(starting now)";
            } else if (diffMins < 60) {
                relativeTime = `(in ${diffMins} minute${diffMins > 1 ? 's' : ''})`;
            } else if (diffMins < 24 * 60) {
                const hours = Math.floor(diffMins / 60);
                relativeTime = `(in ${hours} hour${hours > 1 ? 's' : ''})`;
            } else {
                const days = Math.floor(diffMins / (24 * 60));
                relativeTime = `(in ${days} day${days > 1 ? 's' : ''})`;
            }
            return `Starts: ${date.toLocaleString('en-US', options)} ${relativeTime}`;
        } catch (e) {
            console.error("Error formatting scheduled time:", e);
            return ""; 
        }
     }

    async createStreamElements(streams, username) {
        if (!this.streamList) return;
        for (const stream of streams) {
            const isExisting = stateManager.isVideoIdAdded(stream.videoId);
            if (isExisting) {
                console.log("Video already added:", stream.videoId, stream.title);
                const existingSources = stateManager.getSources({ videoId: stream.videoId });
                console.log("Existing sources:", existingSources);
            }
            const element = document.createElement('div');
            element.className = 'yt-stream-item';
            element.dataset.videoId = stream.videoId;
            const initialIsShort = typeof stream.isShort === 'boolean' ? stream.isShort : this.currentIsShortDefault;
            console.log(`Stream ${stream.videoId} initial isShort: ${initialIsShort} (detected: ${stream.isShort}, default: ${this.currentIsShortDefault})`);


            const thumbnailUrl = stream.thumbnails?.medium?.url || stream.thumbnails?.default?.url || 'https://cache.socialstream.ninja/sources/images/youtube.png';
            const status = this.getVideoStatus(stream.status, stream.viewers);
            stream.statusDisplay = status; // Store for later use if needed

            let statusBadge = '';
            if (status === 'upcoming') statusBadge = '<span class="stream-status-badge upcoming">Upcoming</span>';
            else if (status === 'live') statusBadge = '<span class="stream-status-badge live">Live</span>';
            else if (status === 'ended') statusBadge = '<span class="stream-status-badge ended">Ended</span>';

            element.innerHTML = `
                ${statusBadge}
                <img class="yt-stream-thumbnail" src="${thumbnailUrl}" alt="Stream thumbnail">
                <div class="yt-stream-info">
                  <div class="yt-stream-title">
                    ${stream.title || 'Live Stream'}
                    <span class="yt-stream-type">${initialIsShort ? 'Shorts Live' : 'YouTube Live'}</span>
                  </div>
                  <div class="yt-stream-channel">${stream.channelTitle || username || stream.channelId || ''}</div>
                  <div class="yt-stream-viewers">${("viewers" in stream) ? (this.formatViewers(stream.viewers)) : "?"} viewers</div>
                  ${status === 'upcoming' ? '<div class="stream-scheduled-time">' + this.formatScheduledTime(stream.scheduledStartTime) + '</div>' : ''}
                  ${isExisting ? '<span class="stream-status already-added">Already Added</span>' : ''}
                </div>
                <div class="yt-stream-controls">
                  <label class="shorts-toggle-label" title="Mark as YouTube Shorts?">
                    <input type="checkbox" class="shorts-toggle-checkbox" ${initialIsShort ? 'checked' : ''}>
                    <span>Shorts</span>
                  </label>
                </div>`;

            if (!isExisting && status !== 'ended') {
                element.addEventListener('click', (e) => {
                    if (!e.target.closest('.yt-stream-controls')) {
                        this.toggleStreamSelection(stream.videoId, element);
                    }
                });
            } else {
                element.classList.add(isExisting ? 'already-added' : 'ended-stream');
                if (isExisting) element.title = "This stream is already in your sources list.";
                if (status === 'ended') element.title = "This stream has ended and cannot be added.";
            }

            const checkbox = element.querySelector('.shorts-toggle-checkbox');
            if (checkbox) {
                if (status === 'ended' || isExisting) checkbox.disabled = true;
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    const currentStreamData = this.streams.find(s => s.videoId === stream.videoId);
                    if (currentStreamData) {
                        console.log(`YouTube type changed for ${stream.videoId}: ${currentStreamData.isShort} -> ${checkbox.checked}`);
                        currentStreamData.isShort = checkbox.checked;
                    }

                    const typeLabel = element.querySelector('.yt-stream-type');
                    if (typeLabel) typeLabel.textContent = checkbox.checked ? 'Shorts Live' : 'YouTube Live';
                });
            }
            const shortsLabel = element.querySelector('.shorts-toggle-label');
            if (shortsLabel) shortsLabel.addEventListener('click', (e) => e.stopPropagation());
            this.streamList.appendChild(element);

            if (!isExisting && status !== 'ended') {
                const nonEndedNonExistingStreams = streams.filter(s => !stateManager.isVideoIdAdded(s.videoId) && this.getVideoStatus(s.status, s.viewers) !== 'ended');
                if (nonEndedNonExistingStreams.length === 1) {
                    this.toggleStreamSelection(stream.videoId, element);
                } else if (status === 'live') {
                    this.toggleStreamSelection(stream.videoId, element);
                } else if (status === 'upcoming' && stream.scheduledStartTime) {
                    const startTime = new Date(stream.scheduledStartTime);
                    const now = new Date();
                    const diffMs = startTime - now;
                    const diffMins = diffMs / (1000 * 60);
                    if (diffMins <= 60 && diffMins >= -15) { // Looser range for "soon"
                        this.toggleStreamSelection(stream.videoId, element);
                    }
                }
            }
        }
    }

    toggleStreamSelection(videoId, element) { 
        if (!element || element.classList.contains('already-added') || element.classList.contains('ended-stream')) return; 

        if (this.selectedStreams.has(videoId)) {
            this.selectedStreams.delete(videoId);
            element.classList.remove('selected');
        } else {
            this.selectedStreams.add(videoId);
            element.classList.add('selected');
        }
    }

    handleActivation() {
        console.log("handleActivation called, selectedStreams:", this.selectedStreams);
        const result = Array.from(this.selectedStreams).map(videoId => {
            const stream = this.streams.find(s => s.videoId === videoId);
            return stream; 
        });
        console.log("handleActivation result:", result);
        
        // Store the promise resolver before hiding
        const resolver = this.resolvePromise;
        this.hide();
        
        // Now resolve the promise with the result
        if (resolver) {
            console.log("Resolving promise with result");
            resolver(result);
        }
    }

    hide() { 
        if (this.modal) this.modal.style.display = 'none';
        if (this.resolvePromise && this.selectedStreams.size === 0) { 
            this.resolvePromise({ cancelled: true }); 
        }
        this.resolvePromise = null;
        this.rejectPromise = null;
    }
}


async function handleYouTubeActivation(username, isShortDefault = false, showPrompts = true, autoActivateAll = false, isChannelName = false, options = {}) {
    try {
        const manualTrigger = !!options.manualTrigger;
        console.log("handleYouTubeActivation:", { username, isShortDefault, showPrompts, autoActivateAll, isChannelName, manualTrigger });
        const combinedStreams = manualTrigger
            ? await discoverYouTubeStreamsForManualAction(username, isShortDefault, isChannelName)
            : await fetchYouTubeLiveStreams(username, {
                isChannelOnly: isChannelName,
                isUsernameOnly: !isChannelName && !username.startsWith("UC"),
                isShortDefault,
                cacheTtlMs: showPrompts ? 15000 : YOUTUBE_STREAM_DISCOVERY_CACHE_TTL_MS
            });
        
        if (!combinedStreams.length) {
            Toast.warning("YouTube", `No live or upcoming streams found for ${username}.`);
            // Removed throw new Error to allow proceeding if user wants to manually add.
            // The function will return, and if showPrompts is true, it might offer manual add.
            return { type: 'no_streams_found' }; 
        }
        
        const groupTargetType = isShortDefault ? 'youtubeshorts' : 'youtube';
        let group = stateManager.getGroups().find(g => g.username === username && g.target === groupTargetType);
        let groupId = group ? group.id : null;

        if (!group) {
            console.warn(`Group for ${username} (${groupTargetType}) not found. Creating now.`);
            groupId = stateManager.addGroup({
                target: groupTargetType,
                username: username,
                isChannel: isChannelName,
                autoActivate: autoActivateAll, 
                groupVisible: true, 
                groupMuted: false
            });
            // The groupAdded listener in index.html should handle DOM creation for the group.
            // We might need to wait for the DOM to update if we immediately need the group element.
            await Promise.resolve(); // Allow microtask queue to process (e.g., DOM updates from listeners)
        }
        const parentGroupData = stateManager.getGroup(groupId); 

        for (let stream of combinedStreams) {
            if (typeof stream.isShort !== 'boolean') {
                stream.isShort = isShortDefault; 
            }
             // Ensure statusDisplay is set for auto-activation logic
            if (!stream.statusDisplay) {
                stream.statusDisplay = YouTubeStreamSelector.prototype.getVideoStatus(stream.status, stream.viewers);
            }
        }

        if (!autoActivateAll) {
            if (!window.streamSelector) {
                console.log("Creating new YouTubeStreamSelector");
                window.streamSelector = new YouTubeStreamSelector();
            }
            console.log("Calling show() with streams:", combinedStreams.length);
            const selectionResult = await window.streamSelector.show(combinedStreams, username, isShortDefault);
            console.log("show() returned:", selectionResult);

            console.log("Selection result:", selectionResult);
            if (!selectionResult || selectionResult.cancelled || !Array.isArray(selectionResult) || selectionResult.length === 0) {
                console.log("YouTube stream selection cancelled or no streams selected.");
                return { type: 'cancelled_or_empty' };
            }

            let activatedCount = 0;
            for (const selectedStream of selectionResult) { 
                console.log("Processing selected stream:", selectedStream);
                if (selectedStream && !stateManager.isVideoIdAdded(selectedStream.videoId)) {
                    const sourceElement = await createYouTubeEntry(selectedStream, username, selectedStream.isShort);
                    console.log("Created source element:", sourceElement);
                    if (sourceElement) {
                        const activateButton = sourceElement.querySelector('[data-activatehtml]');
                        // Ensure parentGroupData is available for visibility/mute logic if needed before activation
                        console.log("Checking activation - activateButton:", !!activateButton, "parentGroupData:", !!parentGroupData);
                        if (activateButton && parentGroupData) { 
                            const sourceForActivation = stateManager.getSource(sourceElement.dataset.sourceId);
                            console.log("Source for activation:", sourceForActivation);
                            if (sourceForActivation && sourceForActivation.status !== 'active' && !sourceForActivation.vid && !sourceForActivation.wssId) {
                                console.log("Creating window for source");
                                await createWindow(activateButton); 
                                activatedCount++;
                            }
                        } else if (!parentGroupData) {
                            console.warn("Parent group data not found during YouTube activation for:", username);
                        }
                    }
                }
            }
            return { type: 'multiple_selected', count: activatedCount };
        } else { 
            let activatedCount = 0;
            for (const stream of combinedStreams) {
                const streamStatus = stream.statusDisplay; // Use pre-calculated statusDisplay
                // Only consider live or upcoming within the next 180 minutes
                if (streamStatus === 'ended') continue;
                let shouldActivate = streamStatus === 'live';
                if (!shouldActivate && streamStatus === 'upcoming' && stream.scheduledStartTime) {
                    let startMs = getYouTubeStreamSortTimestamp(stream);
                    if (startMs === Number.MAX_SAFE_INTEGER) continue;
                    const startTime = new Date(startMs);
                    const now = new Date();
                    const diffMs = startTime - now;
                    const diffMins = diffMs / (1000 * 60);
                    if (diffMins >= 0 && diffMins <= 180) {
                        shouldActivate = true;
                    }
                }
                if (!shouldActivate) continue;

                if (!stateManager.isVideoIdAdded(stream.videoId)) {
                    // Create the source and activate it
                    const sourceElement = await createYouTubeEntry(stream, username, stream.isShort);
                    if (sourceElement) {
                        const activateButton = sourceElement.querySelector('[data-activatehtml]');
                        if (activateButton && parentGroupData) {
                            const sourceForActivation = stateManager.getSource(sourceElement.dataset.sourceId);
                            if (sourceForActivation && sourceForActivation.status !== 'active' && !sourceForActivation.vid && !sourceForActivation.wssId) {
                                await createWindow(activateButton);
                                activatedCount++;
                            }
                        }
                    }
                } else {
                    // Already added: try to activate the existing source via UI button if not open
                    const existingSource = stateManager.getSources().find(s => s.videoId === stream.videoId);
                    if (existingSource && existingSource.status !== 'active' && !existingSource.vid && !existingSource.wssId) {
                        try {
                            // Ensure DOM element exists
                            let sourceElement = document.querySelector(`[data-source-id="${existingSource.id}"]`);
                            if (!sourceElement) {
                                sourceElement = createSourceElement(existingSource.id);
                                const groupElement = document.querySelector(`[data-group-id="${parentGroupData?.id}"]`);
                                const streamsContainer = groupElement?.querySelector('.stream-group');
                                if (sourceElement && streamsContainer) streamsContainer.appendChild(sourceElement);
                            }
                            const activateButton = sourceElement?.querySelector('[data-activatehtml]');
                            if (activateButton) {
                                const winId = await createWindow(activateButton);
                                if (winId) activatedCount++;
                            }
                        } catch (e) {
                            console.warn('Failed to activate existing YouTube source for', username, e);
                        }
                    }
                }
            }
            if (activatedCount === 0) Toast.info("YouTube", `No new streams found to auto-activate for ${username}.`);
            return { type: 'multiple_auto', count: activatedCount };
        }
    } catch (error) {
        console.error("Error in handleYouTubeActivation for " + username + ":", error);
        if (isYouTubeDiscoveryNetworkError(error)) {
            Toast.warning("YouTube Network", `Could not reach YouTube while checking ${username}. This looks like a temporary DNS/network issue; try again shortly.`);
            return { type: 'network_error', message: error.message };
        }
        if (showPrompts && error.message && !error.message.includes("No video ID found") && !error.message.includes("User cancelled")) {
            // Check if ipcRenderer and window.confirm are available
            if (typeof ipcRenderer !== 'undefined' && ipcRenderer && typeof window.confirm === 'function') {
                 const manual = window.confirm(
                    `⚠️ Error during YouTube stream discovery for ${username}.\n\n` +
                    "Would you like to manually add a stream by URL or Video ID instead?"
                );
                if (manual) await newOtherSourcePrompt(isShortDefault ? 'youtubeshorts' : 'youtube');
            } else {
                Toast.error("YouTube Error", `Error discovering streams for ${username}. Try adding manually.`);
            }
        }
        // Do not re-throw error if we handled it with a prompt or if it was a known non-error condition
        if (!(error.message && (error.message.includes("No video ID found") || error.message.includes("User cancelled")))) {
           // throw error; // Re-throw only if it's an unexpected error
        }
        return { type: 'error', message: error.message };
    }
}


class YouTubeStatusManager {
    constructor() {
        if (YouTubeStatusManager.instance) {
            return YouTubeStatusManager.instance;
        }
        this.cleanupInterval = null;
        this.initialized = false;
        this.init(); // Call init, it will retry if stateManager not ready
        YouTubeStatusManager.instance = this;
    }

    init() {
        if (this.initialized) return;
        // Wait for stateManager to be initialized
        if (!stateManager || !stateManager.initialized) {
            console.log("YouTubeStatusManager: stateManager not ready, retrying init in 200ms.");
            setTimeout(() => this.init(), 200);
            return;
        }
        console.log("YouTubeStatusManager initializing with stateManager...");
        this.settingsChanged(); 
        this.initialized = true;
    }
    
    settingsChanged(updates = null) {
        // Ensure stateManager and its global state are available
        if (!stateManager || !stateManager.state || !stateManager.state.global) {
            console.warn("YouTubeStatusManager: stateManager or global state not available for settingsChanged. Will retry.");
            // If called too early (e.g. by globalUpdated before full init), defer.
            if (!this.initialized) { // Only defer if not yet fully initialized
                 setTimeout(() => this.settingsChanged(updates), 500);
            }
            return;
        }

        const globalState = stateManager.state.global;
        // Hard-disable runtime scheduled checks regardless of saved flags
        this.checkInterval = null;
        this.autoCleanupEnabled = false;
        this.autoAddEnabled = false;

        this.stopScheduledChecks();
        console.log("YouTubeStatusManager: Scheduled checks are disabled by configuration.");
    }

    async periodicCheck() {
        console.log("YouTubeStatusManager: Performing periodic check for all groups.");
        const youtubeGroups = stateManager.getGroups().filter(g => g.target === "youtube" || g.target === "youtubeshorts");

        for (const group of youtubeGroups) {
            const username = group.username;
            const target = group.target;
            const isDefaultShorts = target === "youtubeshorts";
            const isChannel = group.isChannel;
            if (!username) continue;

            try {
                const liveStreams = await fetchYouTubeLiveStreams(username, { isChannelOnly: isChannel, isUsernameOnly: !isChannel && !username.startsWith("UC") });

                if (this.autoAddEnabled) {
                    for (const stream of liveStreams) {
                        // Ensure stream.status is valid before checking
                        if (stream.status === 'live' && !stateManager.isVideoIdAdded(stream.videoId)) {
                            Toast.info("YouTube Sync", `Auto-adding new live stream "${stream.title}" for ${username}`);
                            const isStreamShort = typeof stream.isShort === 'boolean' ? stream.isShort : isDefaultShorts;
                            const newEntryElement = await createYouTubeEntry(stream, username, isStreamShort); 
                            if (newEntryElement) {
                                const activateBtn = newEntryElement.querySelector('[data-activatehtml]');
                                if (activateBtn) {
                                    const sourceData = stateManager.getSource(newEntryElement.dataset.sourceId);
                                    if (sourceData && group.autoActivate && !sourceData.vid && !sourceData.wssId) { 
                                         await createWindow(activateBtn); 
                                    }
                                }
                            }
                        }
                    }
                }

                // Runtime auto-cleanup disabled by design to preserve quota
            } catch (error) {
                console.warn(`Error during YouTube sync for ${username}:`, error);
            }
        }
    }

    startScheduledChecks() { 
        if (this.cleanupInterval) clearInterval(this.cleanupInterval); 
        if (this.checkInterval && this.checkInterval > 0) { // Ensure interval is valid
            this.cleanupInterval = setInterval(() => this.periodicCheck(), this.checkInterval);
            console.log(`YouTubeStatusManager: Scheduled checks started (Interval: ${this.checkInterval / 1000}s). Auto-add: ${this.autoAddEnabled}, Auto-cleanup: ${this.autoCleanupEnabled}`);
        } else {
            console.warn(`YouTubeStatusManager: Invalid checkInterval (${this.checkInterval}), scheduled checks not started.`);
        }
    }
    stopScheduledChecks() { 
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            console.log("YouTubeStatusManager: Scheduled checks stopped.");
        }
    }

    showGlobalSettingsModal() {
        if (document.getElementById('ytGlobalSettingsModal')) return;
        const modal = document.createElement('div');
        modal.id = 'ytGlobalSettingsModal';
        modal.className = 'modal';
        modal.style.display = 'block';

        const currentSettings = stateManager.state.global;

        modal.innerHTML = `
            <div class="modal-content">
                <span class="yt-stream-close" onclick="this.closest('.modal').remove()">×</span>
                <h2>YouTube Stream Sync Settings</h2>
                <div style="margin: 20px 0;">
                    <label style="display: block; margin-bottom: 15px;">
                        <input type="checkbox" id="ytAutoAddToggle" ${currentSettings.youtubeAutoAdd ? 'checked' : ''}>
                        Automatically add new live streams to groups
                    </label>
                    <label style="display: block; margin-bottom: 15px;">
                        <input type="checkbox" id="ytAutoCleanupToggle" ${currentSettings.youtubeAutoCleanup ? 'checked' : ''}>
                        Automatically remove ended streams from groups
                    </label>
                    <label style="display: block;">
                        Check Interval:
                        <select id="ytCheckIntervalSelect" style="margin-left: 10px;">
                            <option value="60000" ${currentSettings.youtubeCheckInterval === 60000 ? 'selected' : ''}>1 minute</option>
                            <option value="180000" ${currentSettings.youtubeCheckInterval === 180000 ? 'selected' : ''}>3 minutes</option>
                            <option value="300000" ${currentSettings.youtubeCheckInterval === 300000 ? 'selected' : ''}>5 minutes</option>
                            <option value="600000" ${currentSettings.youtubeCheckInterval === 600000 ? 'selected' : ''}>10 minutes</option>
                        </select>
                    </label>
                </div>
                <div style="text-align: right;">
                    <button class="yt-stream-button primary" onclick="YouTubeStatusManager.instance.saveGlobalSettings(this.closest('.modal'))">Save Settings</button>
                    <button class="yt-stream-button secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    saveGlobalSettings(modalElement) {
        const autoAdd = modalElement.querySelector('#ytAutoAddToggle').checked;
        const autoCleanup = modalElement.querySelector('#ytAutoCleanupToggle').checked;
        const interval = parseInt(modalElement.querySelector('#ytCheckIntervalSelect').value);

        stateManager.updateGlobal({
            youtubeAutoAdd: autoAdd,
            youtubeAutoCleanup: autoCleanup,
            youtubeCheckInterval: interval
        });

        Toast.success("Settings Saved", "YouTube sync settings updated.");
        modalElement.remove();
    }
}
YouTubeStatusManager.instance = null;

async function customPrompt(sources) { 
    return new Promise((resolve, reject) => {
        const modal = document.getElementById("modal");
        if (!modal) { reject(new Error("Modal element not found for customPrompt")); return; }

        const dropdown = modal.querySelector("[data-type='dropdown']");
        const submitButton = modal.querySelector("[data-type='submit']");
        const cancelButton = modal.querySelector("[data-type='cancel']");

        if (!dropdown || !submitButton || !cancelButton) {
            reject(new Error("Modal components not found for customPrompt"));
            return;
        }

        sources.sort();
        dropdown.innerHTML = ""; 
        sources.forEach(source => {
            const option = document.createElement("option");
            option.value = source; 
            option.textContent = source.replace("sources/","").replace(".js",""); 
            dropdown.appendChild(option);
        });

        modal.classList.remove("hidden");

        const handleSubmit = () => {
            modal.classList.add("hidden");
            cleanup();
            resolve(dropdown.value); 
        };
        const handleCancel = () => {
            modal.classList.add("hidden");
            cleanup();
            reject(new Error("User cancelled custom prompt.")); 
        };
        const cleanup = () => {
            submitButton.removeEventListener('click', handleSubmit);
            cancelButton.removeEventListener('click', handleCancel);
        };

        submitButton.addEventListener('click', handleSubmit, { once: true });
        cancelButton.addEventListener('click', handleCancel, { once: true });
    });
}
function searchWithContext(text, searchTerm, contextLength = 20) { 
    const regex = new RegExp(`(.{0,${contextLength}})${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.{0,${contextLength}})`, 'gi');
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const [fullMatch, before, after] = match;
        const start = Math.max(0, match.index - contextLength);
        const end = Math.min(text.length, regex.lastIndex + contextLength);
        matches.push({
            before: text.slice(start, match.index).padStart(contextLength, ' '),
            term: match[0].substring(before.length, match[0].length - after.length), 
            after: after.padEnd(contextLength, ' '),
            fullContext: text.slice(start, end)
        });
    }
    matches.forEach((result, index) => { 
        console.log(`Context Match ${index + 1}:`);
        console.log(`${result.before}[${result.term}]${result.after}`);
    });
    return matches;
}
function decodeUnicodeEscapes(str) { 
    if (!str || typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
}

function extractYouTubeInitialDataFromHtml(htmlData) {
    if (!htmlData || typeof htmlData !== 'string') return null;
    const markers = ['ytInitialData"] = ', "ytInitialData'] = ", 'var ytInitialData = ', 'ytInitialData = '];
    let jsonStart = -1;
    for (const marker of markers) {
        const markerIndex = htmlData.indexOf(marker);
        if (markerIndex !== -1) {
            jsonStart = htmlData.indexOf('{', markerIndex + marker.length);
            break;
        }
    }
    if (jsonStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = jsonStart; index < htmlData.length; index++) {
        const char = htmlData[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(htmlData.slice(jsonStart, index + 1));
                } catch (e) {
                    console.error("Error parsing ytInitialData:", e);
                    return null;
                }
            }
        }
    }
    return null;
}

function normalizeYouTubeLookupText(value) {
    return String(value || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getYouTubeFormattedText(value) {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) {
        return value.runs.map(run => run && run.text ? run.text : '').join('');
    }
    return '';
}

function collectYouTubeChannelCandidates(node, candidates = []) {
    if (!node || typeof node !== 'object') return candidates;
    if (node.channelRenderer && typeof node.channelRenderer === 'object') {
        const renderer = node.channelRenderer;
        candidates.push({
            channelId: renderer.channelId || null,
            title: getYouTubeFormattedText(renderer.title),
            handle: getYouTubeFormattedText(renderer.subscriberCountText || renderer.videoCountText),
            url: renderer.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || null
        });
    }
    Object.keys(node).forEach(key => {
        const value = node[key];
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                value.forEach(item => collectYouTubeChannelCandidates(item, candidates));
            } else {
                collectYouTubeChannelCandidates(value, candidates);
            }
        }
    });
    return candidates;
}

function collectYouTubeVideoRenderers(node, videos = []) {
    if (!node || typeof node !== 'object') return videos;
    if (node.videoRenderer && typeof node.videoRenderer === 'object') {
        videos.push({ type: 'videoRenderer', renderer: node.videoRenderer });
    }
    if (node.lockupViewModel && typeof node.lockupViewModel === 'object') {
        videos.push({ type: 'lockupViewModel', renderer: node.lockupViewModel });
    }
    Object.keys(node).forEach(key => {
        const value = node[key];
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                value.forEach(item => collectYouTubeVideoRenderers(item, videos));
            } else {
                collectYouTubeVideoRenderers(value, videos);
            }
        }
    });
    return videos;
}

function findFirstYouTubeVideoId(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(node.videoId)) {
        return node.videoId;
    }
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                for (const item of value) {
                    const found = findFirstYouTubeVideoId(item);
                    if (found) return found;
                }
            } else {
                const found = findFirstYouTubeVideoId(value);
                if (found) return found;
            }
        }
    }
    return null;
}

function collectYouTubeStringValues(node, values = []) {
    if (!node || typeof node !== 'object') return values;
    if (typeof node.simpleText === 'string') values.push(node.simpleText);
    if (typeof node.content === 'string') values.push(node.content);
    if (Array.isArray(node.runs)) {
        node.runs.forEach(run => {
            if (run && typeof run.text === 'string') values.push(run.text);
        });
    }
    Object.keys(node).forEach(key => {
        const value = node[key];
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                value.forEach(item => collectYouTubeStringValues(item, values));
            } else {
                collectYouTubeStringValues(value, values);
            }
        }
    });
    return values;
}

function extractLockupThumbnails(lockup) {
    const sources = lockup?.contentImage?.thumbnailViewModel?.image?.sources;
    if (!Array.isArray(sources)) return null;
    const result = {};
    sources.forEach((thumb, index) => {
        if (!thumb || !thumb.url) return;
        let sizeName = `custom${index}`;
        if (thumb.width === 120) sizeName = 'default';
        else if (thumb.width === 320 || thumb.width === 336) sizeName = 'medium';
        else if (thumb.width === 480) sizeName = 'high';
        else if (thumb.width === 640) sizeName = 'standard';
        else if (thumb.width === 1280 && thumb.height === 720) sizeName = 'maxres';
        result[sizeName] = { url: thumb.url, width: thumb.width, height: thumb.height };
    });
    return Object.keys(result).length ? result : null;
}

function getLockupScheduledStartTime(textValues) {
    const scheduledText = textValues.find(text => /^scheduled for\s+/i.test(text));
    if (!scheduledText) return null;
    const parsed = Date.parse(scheduledText.replace(/^scheduled for\s+/i, '').trim());
    return Number.isNaN(parsed) ? null : parsed;
}

function getVideoStatusFromLockup(lockup) {
    const textValues = collectYouTubeStringValues(lockup);
    const normalizedText = textValues.join(' ').toLowerCase();
    const isUpcoming = normalizedText.includes('upcoming') || normalizedText.includes('scheduled for') || normalizedText.includes(' waiting');
    const isLive = normalizedText.includes(' watching') || normalizedText.includes(' live now') || normalizedText === 'live';
    const isEnded = normalizedText.includes('streamed') || normalizedText.includes('premiered');
    return {
        status: isLive ? 'live' : isUpcoming ? 'upcoming' : isEnded ? 'ended' : 'video',
        scheduledStartTime: getLockupScheduledStartTime(textValues)
    };
}

function getVideoStatusFromAnyRenderer(videoEntry, fallbackRendererStatus) {
    if (!videoEntry || !videoEntry.renderer) return null;
    if (videoEntry.type === 'videoRenderer') {
        return fallbackRendererStatus(videoEntry.renderer);
    }
    const lockup = videoEntry.renderer;
    const status = getVideoStatusFromLockup(lockup);
    const videoId = findFirstYouTubeVideoId(lockup);
    if (!videoId) return null;
    return {
        videoId,
        title: lockup?.metadata?.lockupMetadataViewModel?.title?.content || '',
        description: null,
        thumbnails: extractLockupThumbnails(lockup),
        tags: [],
        categoryId: null,
        defaultLanguage: null,
        defaultAudioLanguage: null,
        isShort: false,
        viewers: null,
        status: status.status,
        statusDisplay: status.status,
        scheduledStartTime: status.scheduledStartTime,
        actualStartTime: null,
        actualEndTime: null,
        channelId: null,
        channelTitle: null
    };
}

function selectYouTubeChannelCandidate(candidates, identifier) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const query = normalizeYouTubeLookupText(identifier);
    if (!query) return candidates[0];
    return candidates.find(candidate => normalizeYouTubeLookupText(candidate.title) === query)
        || candidates.find(candidate => normalizeYouTubeLookupText(candidate.url || '').endsWith('/' + query))
        || candidates.find(candidate => normalizeYouTubeLookupText(candidate.title).includes(query))
        || candidates[0];
}

function normalizeYouTubeChannelIdentifier(identifier) {
    let normalized = String(identifier || '').trim();
    if (!normalized) return '';
    if (normalized.startsWith('/')) {
        normalized = `https://www.youtube.com${normalized}`;
    }
    try {
        const parsed = parseYoutubeUrl(normalized);
        if (parsed?.type === 'channel_id' && parsed.id) return parsed.id;
        if (parsed?.username) return parsed.username;
        const url = new URL(normalized);
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts[0] === 'channel' && pathParts[1]) return pathParts[1];
        if (pathParts[0] && pathParts[0].startsWith('@')) return pathParts[0];
        if ((pathParts[0] === 'c' || pathParts[0] === 'user') && pathParts[1]) return `${pathParts[0]}/${pathParts[1]}`;
    } catch (_) {}
    return normalized;
}

function shouldResolveYouTubeChannelBySearch(identifier) {
    const normalized = normalizeYouTubeChannelIdentifier(identifier);
    if (!normalized) return false;
    return !(
        normalized.startsWith("UC") ||
        normalized.startsWith("HC") ||
        normalized.startsWith("UU") ||
        normalized.startsWith('@') ||
        normalized.startsWith('channel/') ||
        normalized.startsWith('c/') ||
        normalized.startsWith('user/')
    );
}

function buildYouTubeChannelScrapeUrl(identifier, alt = false) {
    const normalized = normalizeYouTubeChannelIdentifier(identifier);
    if (!normalized) return '';
    const section = alt ? 'live' : 'streams';
    if (normalized.startsWith("UC") || normalized.startsWith("HC") || normalized.startsWith("UU")) {
        return `https://www.youtube.com/channel/${encodeURIComponent(normalized)}/${section}`;
    }
    if (normalized.startsWith('channel/')) {
        return `https://www.youtube.com/${normalized.split('/').map(encodeURIComponent).join('/')}/${section}`;
    }
    if (normalized.startsWith('c/') || normalized.startsWith('user/')) {
        return `https://www.youtube.com/${normalized.split('/').map(encodeURIComponent).join('/')}/${section}`;
    }
    if (/\s/.test(normalized)) {
        return '';
    }
    const handle = normalized.startsWith('@') ? normalized : '@' + normalized;
    return `https://www.youtube.com/${encodeURI(handle)}/${section}`;
}

function getYouTubeDiscoveryFetchHeaders() {
    return {
        'Accept-Language': YT_ACCEPT_LANGUAGE,
        'User-Agent': config?.global?.userAgent || getDefaultConfig().global.userAgent,
        'Cookie': 'SOCS=CAESNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMxMTE0LjAzX3AwGgJlbiADGgYIgObvqgY; CONSENT=YES+ regione.lang'
    };
}

async function fetchYouTubeDiscoveryHtml(fetchUrl) {
    const response = await ipcRenderer.invoke('nodefetch', {
        url: fetchUrl,
        headers: getYouTubeDiscoveryFetchHeaders(),
        timeout: 15000
    });
    if (isYouTubeTransientNetworkError(response)) {
        throw createYouTubeDiscoveryNetworkError(fetchUrl, response);
    }
    if (response?.status && response.status >= 400) {
        console.warn(`YouTube discovery fetch returned HTTP ${response.status}:`, fetchUrl);
    }
    const htmlData = response?.data || response;
    return typeof htmlData === 'string' ? htmlData : '';
}

async function resolveYouTubeChannelScrapeUrl(identifier, alt = false) {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(identifier)}&sp=EgIQAg%253D%253D`;
    console.log("Resolving YouTube channel by search:", searchUrl);
    const searchHtml = await fetchYouTubeDiscoveryHtml(searchUrl);
    const searchData = extractYouTubeInitialDataFromHtml(searchHtml);
    const candidates = collectYouTubeChannelCandidates(searchData);
    const selected = selectYouTubeChannelCandidate(candidates, identifier);
    if (selected?.channelId) {
        return buildYouTubeChannelScrapeUrl(selected.channelId, alt);
    }
    if (selected?.url) {
        return buildYouTubeChannelScrapeUrl(selected.url, alt);
    }
    return '';
}

async function fetchYoutube(username, alt = false, options = {}) {
    function getVideoStatusFromRenderer(videoRenderer) { 
			  const data = videoRenderer; 
			  const isLiveNow = checkIsLiveNow(data);
			  const isUpcoming = checkIsUpcoming(data);
			  const isEnded = checkIsEnded(data);
			  let streamStatus = isLiveNow ? 'live' : isUpcoming ? 'upcoming' : isEnded ? 'ended' : 'video';

			  return {
				videoId: data.videoId,
				title: data.title?.runs?.[0]?.text || data.title?.simpleText || '',
				description: data.descriptionSnippet?.runs?.[0]?.text || null,
				thumbnails: extractThumbnails(data.thumbnail?.thumbnails),
				tags: [], 
				categoryId: null,
				defaultLanguage: null,
				defaultAudioLanguage: null,
				isShort: data.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url?.includes("/shorts/"), 
				viewers: extractViewerCount(data),
				status: streamStatus, // This is the crucial status for filtering
                statusDisplay: streamStatus, // Explicitly set for consistency
				scheduledStartTime: data.upcomingEventData?.startTime || null, 
				actualStartTime: null, 
				actualEndTime: null,
				channelId: data.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || data.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.navigationEndpoint?.browseEndpoint?.browseId || null,
				channelTitle: data.ownerText?.runs?.[0]?.text || data.longBylineText?.runs?.[0]?.text || null,
				queryIdentifier: username 
			  };
		}
		function extractViewerCount(data) {
			  if (data.viewCountText?.runs) { 
				const viewText = data.viewCountText.runs.map(r => r.text).join('').replace(/[^0-9.,KMB]/gi, '');
                return parseHumanReadableNumber(viewText);
			  }
			  if (data.viewCountText?.simpleText) { 
				const views = data.viewCountText.simpleText.replace(/[^0-9.,KMB]/gi, '');
				return parseHumanReadableNumber(views);
			  }
              if (data.shortViewCountText?.simpleText) { 
                const views = data.shortViewCountText.simpleText.replace(/[^0-9.,KMB]/gi, '');
                return parseHumanReadableNumber(views);
              }
               if (data.shortViewCountText?.accessibility?.accessibilityData?.label) { 
                const views = data.shortViewCountText.accessibility.accessibilityData.label.replace(/[^0-9.,KMB]/gi, '');
                return parseHumanReadableNumber(views);
              }
			  return null;
		}
        function parseHumanReadableNumber(numStr) {
            if (!numStr) return null;
            numStr = numStr.toUpperCase();
            let multiplier = 1;
            if (numStr.endsWith('K')) { multiplier = 1000; numStr = numStr.slice(0, -1); }
            else if (numStr.endsWith('M')) { multiplier = 1000000; numStr = numStr.slice(0, -1); }
            else if (numStr.endsWith('B')) { multiplier = 1000000000; numStr = numStr.slice(0, -1); }
            const num = parseFloat(numStr.replace(/,/g, ''));
            return isNaN(num) ? null : Math.round(num * multiplier);
        }
		function extractThumbnails(thumbnails) {
			  if (!thumbnails || !Array.isArray(thumbnails)) return null;
			  const result = {};
			  thumbnails.forEach((thumb, index) => {
                  let sizeName = `custom${index}`;
                  if (thumb.width === 120) sizeName = 'default';
                  else if (thumb.width === 320 || thumb.width === 336) sizeName = 'medium'; 
                  else if (thumb.width === 480) sizeName = 'high';
                  else if (thumb.width === 640) sizeName = 'standard';
                  else if (thumb.width === 1280 && thumb.height === 720) sizeName = 'maxres'; 

				result[sizeName] = { url: thumb.url, width: thumb.width, height: thumb.height };
			  });
			  return result;
		}
		function checkIsLiveNow(data) {
			  const badges = data.badges || [];
			  const hasLiveBadge = badges.some(badge => badge.metadataBadgeRenderer?.style?.includes('BADGE_STYLE_TYPE_LIVE_NOW'));
			  const hasUpcomingBadge = badges.some(badge => badge.metadataBadgeRenderer?.label === 'UPCOMING'); 
			  if (hasUpcomingBadge) return false;

			  const hasLiveThumbnailOverlay = data.thumbnailOverlays?.some(overlay => overlay.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE');
			  const isStreamingText = data.viewCountText?.runs?.some(run => run.text?.toLowerCase().includes('watching'));
              const shortViewCountIsLive = data.shortViewCountText?.runs?.some(run => run.text?.toLowerCase().includes('watching'));
			  return hasLiveBadge || hasLiveThumbnailOverlay || isStreamingText || shortViewCountIsLive;
		}
		function checkIsUpcoming(data) {
			  const hasUpcomingEventData = !!data.upcomingEventData?.startTime;
			  const hasPremiereBadge = data.badges?.some(badge => badge.metadataBadgeRenderer?.label === 'PREMIERE');
              const hasUpcomingBadge = data.badges?.some(badge => badge.metadataBadgeRenderer?.label === 'UPCOMING');
			  const hasUpcomingThumbnailOverlay = data.thumbnailOverlays?.some(overlay => overlay.thumbnailOverlayTimeStatusRenderer?.style === 'UPCOMING');
			  const premieresText = data.publishedTimeText?.simpleText?.toLowerCase().includes('premieres');
			  return hasUpcomingEventData || hasPremiereBadge || hasUpcomingBadge || hasUpcomingThumbnailOverlay || premieresText;
		}
		function checkIsEnded(data) { 
			  const wasStreamText = data.publishedTimeText?.simpleText?.toLowerCase().includes('streamed') || data.publishedTimeText?.simpleText?.toLowerCase().includes('premiered');
			  const hasDefaultTimeOverlay = data.thumbnailOverlays?.some(overlay => overlay.thumbnailOverlayTimeStatusRenderer?.style === 'DEFAULT' && overlay.thumbnailOverlayTimeStatusRenderer.text?.simpleText); 
			  return wasStreamText && hasDefaultTimeOverlay && !checkIsLiveNow(data) && !checkIsUpcoming(data);
		}

        const scrapeOptions = options && typeof options === 'object' ? options : {};
        const forceSearch = !!scrapeOptions.forceSearch && shouldResolveYouTubeChannelBySearch(username);
        let fetchUrl = forceSearch ? '' : buildYouTubeChannelScrapeUrl(username, alt);

		try {
            if (!ipcRenderer) { // Guard against ipcRenderer not being available (e.g. web context)
                console.warn("ipcRenderer not available for fetchYoutube scrape.");
                return false;
            }
            if (!fetchUrl) {
                fetchUrl = await resolveYouTubeChannelScrapeUrl(username, alt);
            }
            if (!fetchUrl) {
                console.warn("Unable to resolve YouTube channel scrape URL for:", username);
                return false;
            }

			console.log("Fetching YouTube URL (scrape):", fetchUrl);
			const htmlData = await fetchYouTubeDiscoveryHtml(fetchUrl);
			if (!htmlData || typeof htmlData !== 'string') {
				console.warn("No valid string data received from YouTube scrape for:", username);
				return false;
			}
            const ytInitialData = extractYouTubeInitialDataFromHtml(htmlData);
            if (!ytInitialData) {
                console.warn("Could not find ytInitialData in scrape for:", username);
            }

            const videos = [];
            if (ytInitialData) {
                const tabs = ytInitialData.contents?.twoColumnBrowseResultsRenderer?.tabs;
                let targetTabContents = null;

                if (tabs) {
                    const liveTab = tabs.find(tab => tab.tabRenderer?.title?.toLowerCase() === 'live' || tab.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url?.endsWith('/live'));
                    const streamsTab = tabs.find(tab => tab.tabRenderer?.title?.toLowerCase() === 'streams' || tab.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url?.endsWith('/streams'));
                    const videosTab = tabs.find(tab => tab.tabRenderer?.title?.toLowerCase() === 'videos' || tab.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url?.endsWith('/videos'));
                    targetTabContents = liveTab?.tabRenderer?.content || streamsTab?.tabRenderer?.content || videosTab?.tabRenderer?.content;

                }

                let videoEntries = collectYouTubeVideoRenderers(targetTabContents);
                if (!videoEntries.length) {
                    videoEntries = collectYouTubeVideoRenderers(ytInitialData);
                }
                videoEntries.forEach(entry => {
                    const video = getVideoStatusFromAnyRenderer(entry, getVideoStatusFromRenderer);
                    if (video && video.videoId) {
                        video.queryIdentifier = username;
                        videos.push(video);
                    }
                });
                if (videos.length === 0 && ytInitialData.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents) {
                     ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents.forEach(section => {
                        section.itemSectionRenderer?.contents?.forEach(contentItem => {
                             if (contentItem.shelfRenderer?.content?.expandedShelfContentsRenderer?.items) { 
                                contentItem.shelfRenderer.content.expandedShelfContentsRenderer.items.forEach(shelfItem => {
                                    const videoRenderer = shelfItem.videoRenderer;
                                    if (videoRenderer && videoRenderer.videoId) {
                                         videos.push(getVideoStatusFromRenderer(videoRenderer));
                                    }
                                });
                            }
                            const videoRenderer = contentItem.videoRenderer; 
                            if (videoRenderer && videoRenderer.videoId) {
                                videos.push(getVideoStatusFromRenderer(videoRenderer));
                            }
                        });
                    });
                }
            } else { 
                 const videoIdMatches = [...htmlData.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
                 if (videoIdMatches.length > 0) {
                     const firstVideoId = videoIdMatches[0][1];
                     // Provide a minimal object, ensuring status and isShort are present
                     videos.push({ videoId: firstVideoId, title: `Live/Upcoming Stream (Scraped ID for ${username})`, status: 'upcoming', statusDisplay: 'upcoming', isShort: false });
                 }
            }

			if (videos.length > 0) {
                console.log(`Scraped ${videos.length} potential videos for ${username}. First:`, videos[0]);
                const liveOrUpcoming = videos.filter(v => v.status === 'live' || v.status === 'upcoming');
                if (liveOrUpcoming.length > 0) return liveOrUpcoming;
                return videos.slice(0, 5); 
            }
			console.warn("No video items extracted from YouTube scrape for:", username);
			return false;
		} catch (e) {
			console.error(`Error during YouTube scrape for ${username}:`, e);
            if (isYouTubeDiscoveryNetworkError(e)) {
                throw e;
            }
			return false;
		}
}

async function fetchRumble(username, alt = false, diagnostics = null) { 
    // Note: `alt` now indicates whether to prefer user-style URLs first (true) or channel-style first (false)
    const channelPreferredUrls = [
        `https://rumble.com/c/${username}/live`
    ];
    const userPreferredUrls = [
        `https://rumble.com/user/${username}/live`
		
    ];

    const seenUrls = new Set();
    const candidateUrls = (alt ? [...userPreferredUrls, ...channelPreferredUrls] : [...channelPreferredUrls, ...userPreferredUrls])
        .filter(url => {
            if (seenUrls.has(url)) return false;
            seenUrls.add(url);
            return true;
        });

    if (candidateUrls.length === 0) {
        console.warn("No Rumble URL candidates generated for:", username);
        return false;
    }
    console.log("Rumble candidate URL order:", candidateUrls);

    const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
    const recordFetchOutcome = ({ url, success, sawHardNotFound = false }) => {
        if (!diag) return;
        diag.totalRequests = (diag.totalRequests || 0) + 1;
        if (success) {
            diag.successfulResponses = (diag.successfulResponses || 0) + 1;
        } else {
            diag.failedResponses = (diag.failedResponses || 0) + 1;
            if (sawHardNotFound) {
                diag.hardNotFoundResponses = (diag.hardNotFoundResponses || 0) + 1;
            }
            if (url) {
                if (!Array.isArray(diag.failedUrls)) {
                    diag.failedUrls = [];
                }
                diag.failedUrls.push(url);
            }
        }
    };

    try {
        if (!ipcRenderer) {
            console.warn("ipcRenderer not available for fetchRumble.");
            return false;
        }
        const commonHeaders = {
            'User-Agent': config?.global?.userAgent || getDefaultConfig().global.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': YT_ACCEPT_LANGUAGE,
            'Referer': 'https://rumble.com/',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        const tryFetchUrl = async (urlToFetch) => {
            // Try Node-side fetch first (explicit UA), then fallback to renderer fetch
            let htmlData = null;
            let sawHardNotFound = false;
            try {
                const response = await ipcRenderer.invoke('nodefetch', {
                    url: urlToFetch,
                    headers: commonHeaders,
                    timeout: 15000
                });
                if (response && response.status >= 200 && response.status < 400 && typeof response.data === 'string') {
                    htmlData = response.data;
                } else {
                    if (response && [404, 410].includes(response.status)) sawHardNotFound = true;
                    console.warn('Rumble nodefetch returned non-OK or non-text response:', response?.status, 'for URL:', urlToFetch);
                }
            } catch (e) {
                console.warn('Rumble nodefetch failed, will try renderer fetch:', e?.message || e);
            }

            if (!htmlData) {
                try {
                    const res = await fetch(urlToFetch, {
                        method: 'GET',
                        headers: {
                            // Cannot set User-Agent from renderer; rely on Chromium UA
                            'Accept': commonHeaders['Accept'],
                            'Accept-Language': commonHeaders['Accept-Language'],
                            'Referer': commonHeaders['Referer'],
                            'Cache-Control': commonHeaders['Cache-Control'],
                            'Pragma': commonHeaders['Pragma']
                        },
                        credentials: 'omit',
                        cache: 'no-store',
                        redirect: 'follow'
                    });
                    if (res.ok) {
                        htmlData = await res.text();
                    } else {
                        if ([404, 410].includes(res.status)) sawHardNotFound = true;
                        console.warn('Rumble renderer fetch returned non-OK status:', res.status, 'for URL:', urlToFetch);
                    }
                } catch (e) {
                    console.warn('Rumble renderer fetch failed:', e?.message || e);
                }
            }

            return { htmlData, sawHardNotFound };
        };

        const extractLiveVideo = (htmlDataResolved) => {
            if (htmlDataResolved && typeof htmlDataResolved === 'string') {
                const buildVideoInfoFromUrl = (candidate) => {
                    if (!candidate || typeof candidate !== 'string') return null;
                    try {
                        const parsed = candidate.startsWith('http')
                            ? new URL(candidate)
                            : new URL(candidate, 'https://rumble.com');
                        let pathname = (parsed.pathname || '').trim();
                        if (!pathname) return null;
                        const match = pathname.match(/\/((?:v|p)[a-zA-Z0-9]+[^\/]*\.html)/i);
                        if (!match || !match[1]) return null;
                        const fullPath = match[1];
                        const idMatch = fullPath.match(/^((?:v|p)[a-zA-Z0-9]+)/);
                        if (!idMatch || !idMatch[1]) return null;
                        return { videoId: idMatch[1], fullPath };
                    } catch (_) {
                        return null;
                    }
                };

                const hasChatMarkup = /chat\/popup\/\d+/i.test(htmlDataResolved) ||
                    /<aside[^>]+media-page-chat-aside-chat/i.test(htmlDataResolved) ||
                    /<[^>]+data-js=["']media_page_chat_aside_chat["']/i.test(htmlDataResolved);

                const findChatId = () => {
                    const directChatPatterns = [
                        /chat\/popup\/(\d+)/i,
                        /data-chat-id=["'](\d+)["']/i,
                        /["']chatId["']\s*[:=]\s*["']?(\d+)/i
                    ];
                    for (const regex of directChatPatterns) {
                        const match = htmlDataResolved.match(regex);
                        if (match && match[1] && /^\d+$/.test(match[1])) {
                            return match[1];
                        }
                    }
                    if (!hasChatMarkup) {
                        return null;
                    }
                    const fallbackPatterns = [
                        /data-video-id=["'](\d+)["']/i,
                        /["']video_id["']\s*[:=]\s*["']?(\d+)/i,
                        /["']cvid["']\s*:\s*(\d+)/i
                    ];
                    for (const regex of fallbackPatterns) {
                        const match = htmlDataResolved.match(regex);
                        if (match && match[1] && /^\d+$/.test(match[1])) {
                            return match[1];
                        }
                    }
                    return null;
                };

                const detectedChatId = findChatId();
                const withChatId = (info) => {
                    if (!info) return null;
                    if (hasChatMarkup && detectedChatId && /^\d+$/.test(detectedChatId)) {
                        return { ...info, chatId: info.chatId || detectedChatId };
                    }
                    return info;
                };

                const findLiveTileInfo = () => {
                    const liveTilePatterns = [
                        /<div[^>]+data-video-id=["'](\d+)["'][\s\S]{0,1800}?(?:thumbnail__thumb--live|videostream__footer--live)[\s\S]{0,1200}?href=["']\/([^"']+\.html)/i,
                        /<div[^>]+data-video-id=["'](\d+)["'][\s\S]{0,1800}?(?:thumbnail__thumb--live|videostream__status--live|videostream__footer--live)/i
                    ];

                    for (const regex of liveTilePatterns) {
                        const match = htmlDataResolved.match(regex);
                        if (!match || !match[1] || !/^\d+$/.test(match[1])) {
                            continue;
                        }

                        const info = match[2]
                            ? buildVideoInfoFromUrl(match[2])
                            : null;

                        return {
                            videoId: info?.videoId || null,
                            fullPath: info?.fullPath || null,
                            chatId: match[1]
                        };
                    }

                    return null;
                };

                const liveTileInfo = findLiveTileInfo();
                if (!hasChatMarkup && liveTileInfo) {
                    console.log("Found Rumble live video (listing tile):", liveTileInfo);
                    return liveTileInfo;
                }

                const canonicalRegex = /<link[^>]+rel=["']?canonical["']?[^>]*href=["']?([^"' >]+)/i;
                const canonicalMatch = htmlDataResolved.match(canonicalRegex);
                if (canonicalMatch && canonicalMatch[1]) {
                    const videoInfo = buildVideoInfoFromUrl(canonicalMatch[1]);
                    if (videoInfo) {
                        if (!hasChatMarkup) {
                            console.warn("Rumble page missing live chat markers; skipping canonical result.");
                            return null;
                        }
                        const enriched = withChatId(videoInfo);
                        console.log("Found Rumble live video (canonical):", enriched);
                        return enriched;
                    }
                }

                const metaPatterns = [
                    { regex: /<meta[^>]+property=["']?og:url["']?[^>]*content=["']?([^"' >]+)/i, label: "og:url" },
                    { regex: /<meta[^>]+name=["']?twitter:url["']?[^>]*content=["']?([^"' >]+)/i, label: "twitter:url" },
                    { regex: /<meta[^>]+itemprop=["']?url["']?[^>]*content=["']?([^"' >]+)/i, label: "itemprop:url" }
                ];
                for (const { regex, label } of metaPatterns) {
                    const metaMatch = htmlDataResolved.match(regex);
                    if (metaMatch && metaMatch[1]) {
                        const videoInfo = buildVideoInfoFromUrl(metaMatch[1]);
                        if (videoInfo) {
                            if (!hasChatMarkup) {
                                console.warn(`Rumble page missing live chat markers; skipping ${label} result.`);
                                continue;
                            }
                            const enriched = withChatId(videoInfo);
                            console.log(`Found Rumble live video (${label}):`, enriched);
                            return enriched;
                        }
                    }
                }

                const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
                let ldJsonMatch;
                while ((ldJsonMatch = ldJsonRegex.exec(htmlDataResolved))) {
                    const jsonText = ldJsonMatch[1]?.trim();
                    if (!jsonText) continue;
                    try {
                        const parsed = JSON.parse(jsonText);
                        const entries = Array.isArray(parsed) ? parsed : [parsed];
                        for (const entry of entries) {
                            if (!entry || typeof entry !== 'object') continue;
                            const type = entry['@type'];
                            const isVideoObject = Array.isArray(type)
                                ? type.includes('VideoObject')
                                : type === 'VideoObject';
                            if (!isVideoObject) continue;
                            const candidateUrls = [entry.url, entry.mainEntityOfPage, entry.embedUrl];
                            for (const candidateUrl of candidateUrls) {
                                const videoInfo = buildVideoInfoFromUrl(candidateUrl);
                                if (videoInfo) {
                                    if (!hasChatMarkup) {
                                        console.warn("Rumble page missing live chat markers; skipping ld+json result.");
                                        continue;
                                    }
                                    const enriched = withChatId(videoInfo);
                                    console.log("Found Rumble live video (ld+json):", enriched);
                                    return enriched;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn("Failed to parse ld+json while searching for Rumble live video:", e);
                    }
                }

                // Try new method first (looking for href pattern)
                const altRegex = /videostream__status--live[\s\S]{0,500}?href=["']\/([^"']+\.html)/;
                const altMatch = htmlDataResolved.match(altRegex);
                
                if (altMatch && altMatch[1]) {
                    // Extract just the video ID for compatibility, but also save the full path
                    const fullPath = altMatch[1];
                    const videoIdMatch = fullPath.match(/^(v[a-zA-Z0-9]+)/);
                    const videoId = videoIdMatch ? videoIdMatch[1] : fullPath.replace('.html', '');
                    if (!hasChatMarkup) {
                        console.warn("Rumble page missing live chat markers; skipping new-method result.");
                        return null;
                    }
                    
                    const enriched = withChatId({ videoId, fullPath });
                    console.log("Found Rumble live video (new method):", enriched);
                    
                    // Return an object with both the video ID and full path
                    return enriched;
                }
                
                // Fallback to old method (looking for data-video-id pattern)
                console.log("Trying old rumble fetch method...");
                try {
                    const oldMethodMatch = htmlDataResolved.split('data-video-id="').slice(1).find(segment => segment.includes("videostream__status--live"));
                    if (oldMethodMatch) {
                        const videoId = oldMethodMatch.split('"')[0];
                        if (videoId) {
                            if (!hasChatMarkup) {
                                console.warn("Rumble page missing live chat markers; skipping old-method result.");
                                return null;
                            }
                            const enriched = withChatId({ videoId, fullPath: `${videoId}.html` });
                            console.log("Found Rumble live video (old method):", enriched);
                            // Return in same format as new method for consistency
                            return enriched;
                        }
                    }
                } catch (e) {
                    console.warn("Old rumble fetch method failed:", e);
                }

                // Attempt to parse embedded JSON-like data
                try {
                    const jsonLikeMatches = [...htmlDataResolved.matchAll(/"hash_id":"(v[a-zA-Z0-9]+)"/g)];
                    if (jsonLikeMatches.length > 0) {
                        for (const match of jsonLikeMatches) {
                            const surrounding = htmlDataResolved.slice(Math.max(0, match.index - 600), match.index + 600);
                            if (/\b(is_live|isLive|isLivestream|is_livestream|livestream|live_status|status)\b[^<>{}]{0,80}?(true|"live"|'live'|1)/i.test(surrounding)) {
                                const videoId = match[1];
                                let fullPath = null;
                                const urlMatch = surrounding.match(/"url":"\/([^"']+\.html)"/);
                                if (urlMatch && urlMatch[1]) {
                                    fullPath = urlMatch[1];
                                } else {
                                    const slugMatch = surrounding.match(/"slug":"([^"']+)"/);
                                    if (slugMatch && slugMatch[1]) {
                                        const slug = slugMatch[1].replace(/[^a-zA-Z0-9-]+/g, '-');
                                        fullPath = `${videoId}-${slug}.html`;
                                    }
                                }
                                if (!fullPath) {
                                    fullPath = `${videoId}.html`;
                                }
                                if (!hasChatMarkup) {
                                    console.warn("Rumble page missing live chat markers; skipping JSON heuristic result.");
                                    continue;
                                }
                                const enriched = withChatId({ videoId, fullPath });
                                console.log("Found Rumble live video (JSON heuristic):", enriched);
                                return enriched;
                            }
                        }
                    }
                } catch (e) {
                    console.warn("JSON heuristic for Rumble live video failed:", e);
                }

                // Fallback heuristic: scan hrefs for potential live videos
                const hrefMatches = [...htmlDataResolved.matchAll(/href=["']\/((?:v|p)[^"']+\.html)["']/g)];
                for (const hrefMatch of hrefMatches) {
                    const fullPath = hrefMatch[1];
                    const snippet = htmlDataResolved.slice(Math.max(0, hrefMatch.index - 400), hrefMatch.index + 400);
                    if (/\blive\b/i.test(snippet) || /\bstatus\b[^<>{}]{0,80}?(?:live|LIVE)/.test(snippet)) {
                        const videoIdMatch = fullPath.match(/^(v[a-zA-Z0-9]+)/);
                        const videoId = videoIdMatch ? videoIdMatch[1] : fullPath.replace('.html', '');
                        if (!hasChatMarkup) {
                            console.warn("Rumble page missing live chat markers; skipping href heuristic result.");
                            continue;
                        }
                        const enriched = withChatId({ videoId, fullPath });
                        console.log("Found Rumble live video (href heuristic):", enriched);
                        return enriched;
                    }
                }

                if (detectedChatId && hasChatMarkup) {
                    const fallbackInfo = { videoId: detectedChatId, fullPath: null, chatId: detectedChatId };
                    console.log("Falling back to chat-id-only Rumble detection:", fallbackInfo);
                    return fallbackInfo;
                }
            }
            return null;
        };

        for (let i = 0; i < candidateUrls.length; i++) {
            const urlToFetch = candidateUrls[i];
            console.log("Fetching Rumble URL:", urlToFetch);
            const { htmlData, sawHardNotFound } = await tryFetchUrl(urlToFetch);
            recordFetchOutcome({ url: urlToFetch, success: !!htmlData, sawHardNotFound });
            const videoInfo = extractLiveVideo(htmlData);
            if (videoInfo) {
                return videoInfo;
            }
            if (sawHardNotFound && i < candidateUrls.length - 1) {
                console.warn("Rumble fetch returned not-found status, attempting alternate URL...");
            }
        }

        console.warn("No live video found on Rumble page for:", username);
        return false;
    } catch (e) {
        console.error("Error fetching Rumble data for " + username + ":", e);
        if (diag) {
            diag.encounteredException = true;
            diag.lastException = e;
        }
        return false;
    }
}

function detectVideoOrientation(imgElement) { 
    if (!imgElement || (imgElement.src && imgElement.src.includes("/sources/images/"))) {
        return false; 
    }
    const naturalWidth = imgElement.naturalWidth;
    const naturalHeight = imgElement.naturalHeight;
    if (naturalWidth === 0 || naturalHeight === 0) return false; 
    const aspectRatio = naturalHeight / naturalWidth;
    if (aspectRatio >= 1.5) return true;
    const landscapeAspectRatio = naturalWidth / naturalHeight;
    const isStandardLandscape = (
        Math.abs(landscapeAspectRatio - 16/9) < 0.1 || 
        Math.abs(landscapeAspectRatio - 4/3) < 0.1    
    );
    if (isStandardLandscape && aspectRatio < 1.2) return false;
    return false;
}
function logDebugInfo(debug) { }
function extractYoutubeVideoId(url) { 
    if (!url || typeof url !== 'string') return null;
	try {
		const urlObj = new URL(url); 
		const hostname = urlObj.hostname.toLowerCase();
		const pathname = urlObj.pathname; 
		const searchParams = urlObj.searchParams;
        const youtubeDomains = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'];
        const youtubeContentDomain = 'googleusercontent.com'; 
        const validVideoId = (value) => /^[a-zA-Z0-9_-]{11}$/.test(value || '');

        if (youtubeDomains.includes(hostname)) {
            if (pathname.startsWith('/shorts/')) {
                const candidate = pathname.split('/shorts/')[1].split(/[?\/#]/)[0];
                return validVideoId(candidate) ? candidate : null;
            }
            if (pathname.startsWith('/live/')) {
                const candidate = pathname.split('/live/')[1].split(/[?\/#]/)[0];
                return validVideoId(candidate) ? candidate : null;
            }
            if (pathname.startsWith('/embed/')) {
                const candidate = pathname.split('/embed/')[1].split(/[?\/#]/)[0];
                return validVideoId(candidate) ? candidate : null;
            }
            if (pathname === '/watch') {
                const candidate = searchParams.get('v');
                return validVideoId(candidate) ? candidate : null;
            }
            if (hostname === 'youtu.be') {
                const candidate = pathname.substring(1).split(/[?\/#]/)[0];
                return validVideoId(candidate) ? candidate : null;
            }
        } else if (hostname.endsWith(youtubeContentDomain) && pathname.startsWith('/youtube.com/')) {
            const pathParts = pathname.split('/');
            if (pathParts.length > 2) {
                const potentialIdSegment = pathParts[pathParts.length-1];
                if (potentialIdSegment.length === 11 && !potentialIdSegment.includes('?')) return potentialIdSegment; 
                let videoId = searchParams.get('v') || searchParams.get('embed_id');
                if (videoId) return videoId;
                 const idFromPathRegex = /\/youtube\.com\/\d*([a-zA-Z0-9_-]{11})/;
                 const pathMatch = pathname.match(idFromPathRegex);
                 if (pathMatch && pathMatch[1]) return pathMatch[1];
            }
        }
		return null; 
	} catch (e) {
        // Fallback for raw video IDs
        if (url.length === 11 && /^[a-zA-Z0-9_-]+$/.test(url)) return url;
		return null;
	}
}
function parseYoutubeUrl(url) { 
    const urlString = typeof url === 'string' ? url : url.toString();
	const handleRegex = /(?:youtube\.com\/)(@[a-zA-Z0-9._-]+)/i;
	const usernameRegex = /(?:youtube\.com\/(?:user\/|c\/))([a-zA-Z0-9._-]+)/i;
    const channelIdRegex = /(?:youtube\.com\/channel\/)(UC[a-zA-Z0-9_-]{22})/i;

	try {
		const parsedUrl = new URL(urlString); 
        const videoId = extractYoutubeVideoId(urlString); 
        if (videoId) {
            return { isYoutubeUrl: true, type: 'video', id: videoId, isShort: urlString.includes('/shorts/') };
        }
        const handleMatch = urlString.match(handleRegex);
        if (handleMatch && handleMatch[1]) {
            return { isYoutubeUrl: true, type: 'channel_username', username: handleMatch[1] };
        }
        const usernameMatch = urlString.match(usernameRegex);
        if (usernameMatch && usernameMatch[1]) {
            return { isYoutubeUrl: true, type: 'channel_username', username: usernameMatch[1] };
        }
        const channelIdMatch = urlString.match(channelIdRegex);
        if (channelIdMatch && channelIdMatch[1]) {
             return { isYoutubeUrl: true, type: 'channel_id', id: channelIdMatch[1] };
        }
        if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsedUrl.hostname)) {
            return { isYoutubeUrl: true, type: 'other_youtube_url' };
        }
	} catch (_) { 
		return { isYoutubeUrl: false };
	}
	return { isYoutubeUrl: false }; 
}

function extractYoutubeID(urlInput) { 
    if (!urlInput || typeof urlInput !== 'string') return null;
    const extracted = extractYoutubeVideoId(urlInput);
    if (extracted) {
        return { id: extracted, isShorts: urlInput.includes('/shorts/') };
    }
    // If it's just an 11-char ID
    if (urlInput.length === 11 && /^[a-zA-Z0-9_-]+$/.test(urlInput)) {
        return { id: urlInput, isShorts: false }; 
    }
	return null; 
}
async function fetchYouTubeLiveStreams(identifier, options = {}) {
    const {
        isChannelOnly = false,
        isUsernameOnly = false,
        isShortDefault = false,
        cacheTtlMs = YOUTUBE_STREAM_DISCOVERY_CACHE_TTL_MS,
        allowScrapeFallback = true,
        bypassCache = false
    } = options;
    const cacheKey = getYouTubeStreamDiscoveryCacheKey(identifier, {
        isChannelOnly,
        isUsernameOnly,
        isShortDefault
    });
    const resolvedCacheTtl = (typeof cacheTtlMs === 'number' && cacheTtlMs >= 0)
        ? cacheTtlMs
        : YOUTUBE_STREAM_DISCOVERY_CACHE_TTL_MS;

    if (!bypassCache) {
        const cached = youtubeStreamDiscoveryCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cloneYouTubeStreams(cached.streams);
        }
        if (youtubeStreamDiscoveryInflight.has(cacheKey)) {
            const pending = await youtubeStreamDiscoveryInflight.get(cacheKey);
            return cloneYouTubeStreams(pending);
        }
    }

    const request = (async () => {
        const streamsFromApi = await fetchYouTubeLiveStreamsFromApi(identifier, {
            isChannelOnly,
            isUsernameOnly
        });
        let streamsFromScrape = [];

        if (allowScrapeFallback && (!streamsFromApi || streamsFromApi.length === 0)) {
            streamsFromScrape = await fetchYoutube(identifier, false, { forceSearch: isChannelOnly });
            if (!Array.isArray(streamsFromScrape) || !streamsFromScrape.length) {
                streamsFromScrape = await fetchYoutube(identifier, true, { forceSearch: isChannelOnly }) || [];
            }
        }

        return mergeYouTubeStreams(streamsFromApi, streamsFromScrape, isShortDefault);
    })().finally(() => {
        youtubeStreamDiscoveryInflight.delete(cacheKey);
    });

    if (!bypassCache) {
        youtubeStreamDiscoveryInflight.set(cacheKey, request);
    }

    const streams = await request;

    if (!bypassCache) {
        youtubeStreamDiscoveryCache.set(cacheKey, {
            expiresAt: Date.now() + resolvedCacheTtl,
            streams: cloneYouTubeStreams(streams)
        });
    }

    return cloneYouTubeStreams(streams);
}
