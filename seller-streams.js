'use strict';

function isSellerGroup(group) {
    return !!group && (group.target === 'ebay' || group.target === 'whatnot');
}

function parseWhatnotSourceInput(value) {
    const input = String(value || '').trim();
    const showId = normalizeWhatnotShowId(input);
    if (showId) return { type: 'event', id: showId };
    let username = input.replace(/^@/, '');
    if (/^(?:https?:\/\/|www\.)/i.test(input) || input.includes('/')) {
        let url;
        try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch (_) { }
        const match = url && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port
            && /^(?:www\.)?whatnot\.com$/i.test(url.hostname)
            && url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?user\/([a-z0-9_.-]+)(?:\/shows)?\/?$/i);
        if (!match) throw new Error('Enter a Whatnot username, profile link, or live show link.');
        username = match[1];
    }
    if (!/^[a-z0-9_.-]{1,100}$/i.test(username) || /^\.+$/.test(username) || /^(?:www\.)?whatnot\.com$/i.test(username)) {
        throw new Error('Enter a Whatnot username, profile link, or live show link.');
    }
    return { type: 'seller', id: username.toLowerCase() };
}

function showSellerSourceSetup(target, existingSourceId = null) {
    const label = target === 'ebay' ? 'eBay Live' : 'Whatnot';
    let saving = false;
    const modal = createSourceSetup(existingSourceId ? 'Choose another eBay Live stream' : `Add ${label}`,
        '<p>Save a seller to choose their streams, or paste a stream link.</p>',
        `<label for="source-setup-input">${target === 'ebay' ? 'Seller or event link' : 'Username, profile or show link'}</label>
        <input id="source-setup-input" type="text" required autocomplete="off" spellcheck="false"
            placeholder="${target === 'ebay' ? 'https://www.ebay.com/ebaylive/sellers/…' : 'https://www.whatnot.com/user/…'}">
        ${target === 'ebay' ? '<p>Use an eBay Live seller link, not a store or /usr/ link. Event IDs also work.</p>' : ''}`,
        async dialog => {
            if (saving) return;
            const parsed = target === 'ebay' ? parseEbayLiveInput(dialog.querySelector('input').value)
                : parseWhatnotSourceInput(dialog.querySelector('input').value);
            saving = true;
            dialog.querySelector('[type="submit"]').disabled = true;
            try {
                if (parsed.type === 'seller') {
                    const data = { target, username: parsed.id, sellerId: parsed.id, sellerOrigin: parsed.origin || 'https://www.whatnot.com',
                        connectionMode: target === 'whatnot' ? 'websocket' : 'classic', autoActivate: false, groupMuted: true };
                    closeModal();
                    if (existingSourceId) {
                        await chooseSellerStreams(data, existingSourceId);
                    } else {
                        const id = `${target}-seller-${new URL(data.sellerOrigin).hostname}-${parsed.id}`;
                        if (!stateManager.getGroup(id)) stateManager.addGroup({ ...data, id });
                        manageWelcomePage();
                        document.querySelector(`[data-group-id="${CSS.escape(id)}"] [data-seller-discovery]`)?.focus();
                    }
                    return;
                }
                const event = target === 'ebay' ? await validateEbayLiveEvent(parsed) : { id: parsed.id, title: parsed.id };
                if (!dialog.isConnected) return;
                closeModal();
                await saveSellerStream({ target, sellerOrigin: parsed.origin }, {
                    videoId: event.id, title: event.title || event.id
                }, existingSourceId);
            } finally {
                saving = false;
                if (dialog.isConnected) dialog.querySelector('[type="submit"]').disabled = false;
            }
        });
    if (existingSourceId) modal.querySelector('input').value = stateManager.getSource(existingSourceId)?.url || '';
    modal.querySelector('input').focus();
}

function sellerStreamAlreadyAdded(target, videoId) {
    return stateManager.getSources().some(source => source.target === target &&
        (source.videoId === videoId || (target === 'whatnot' && normalizeWhatnotShowId(source.url) === videoId)
            || (target === 'ebay' && (() => {
                try { const parsed = parseEbayLiveInput(source.url); return parsed.type === 'event' && parsed.id === videoId; }
                catch (_) { return false; }
            })())));
}

async function saveSellerStream(group, stream, existingSourceId = null) {
    const target = group.target;
    const url = target === 'ebay' ? `${group.sellerOrigin || 'https://www.ebay.com'}/ebaylive/events/${stream.videoId}/chat`
        : `https://www.whatnot.com/live/${stream.videoId}`;
    const data = { target, username: stream.title || stream.videoId, videoId: stream.videoId, url,
        sourceFile: `sources/${target}.js`, connectionMode: group.connectionMode || (target === 'whatnot' ? 'websocket' : 'classic'),
        ...(target === 'ebay' ? { ebaySellerId: group.sellerId || null, ebayOrigin: group.sellerOrigin || 'https://www.ebay.com' } : {}) };
    if (existingSourceId) {
        const source = stateManager.getSource(existingSourceId);
        const row = document.querySelector(`[data-source-id="${CSS.escape(existingSourceId)}"]`);
        if (!source || !row) throw new Error('This source was removed. Add the stream again.');
        if (source.url !== url) {
            if (sellerStreamAlreadyAdded(target, stream.videoId)) return;
            await stopThis(row.querySelector('[data-stophtml]'));
            if (stateManager.getSource(existingSourceId) !== source) return;
            stateManager.updateSource(existingSourceId, { ...data, status: 'inactive', error: null });
        }
        return;
    }
    if (group.id && sellerStreamAlreadyAdded(target, stream.videoId)) return;
    if (group.id) {
        if (stateManager.getGroup(group.id) !== group) return;
        Object.assign(data, { groupId: group.id, isVisible: group.groupVisible, isMuted: group.groupMuted,
            customSession: group.customSession || 'AUTO', userAgent: group.userAgent || 'AUTO',
            mockUserAgentData: group.mockUserAgentData || null });
    }
    const element = await newOtherSource(target, url, false, data);
    // newOtherSource normalizes Whatnot's username to its show ID; retain the
    // discovered title for display while capture continues to use url/videoId.
    const source = stateManager.getSource(element?.dataset.sourceId);
    if (source) stateManager.updateSource(source.id, { username: data.username });
}

async function discoverSellerStreams(group, isCurrent) {
    if (group.target === 'whatnot') {
        const result = await ipcRenderer.invoke('discover-whatnot-streams', {
            username: group.sellerId || group.username, customSession: group.customSession, userAgent: group.userAgent
        });
        if (result.error) throw new Error(result.error);
        return result.streams;
    }
    const events = await findEbayLiveEvents({ id: group.sellerId, origin: group.sellerOrigin }, isCurrent);
    const name = events[0]?.hosts?.find(host => host.id === group.sellerId)?.userAccountName;
    if (name && group.id && isCurrent()) stateManager.updateGroup(group.id, { username: name });
    return events.map(event => ({ videoId: event.id, title: event.title, status: 'live', channelTitle: name || group.username,
        viewers: event.watchedCount, thumbnails: { medium: { url: /^https:\/\/i\.ebayimg\.com\//i.test(event.previewImage?.url || '') ? event.previewImage.url : '' } } }));
}

async function chooseSellerStreams(group, existingSourceId = null) {
    if (!isSellerGroup(group)) return;
    if (!window.streamSelector) window.streamSelector = new YouTubeStreamSelector();
    const picker = window.streamSelector;
    if (picker.resolvePromise) return;
    const previousFocus = document.activeElement;
    const selection = picker.show([], group.username, false, false, {
        target: group.target, platformLabel: group.target === 'ebay' ? 'eBay Live' : 'Whatnot',
        buttonLabel: existingSourceId ? 'Use Selected' : 'Add Selected', singleSelect: !!existingSourceId,
        isAdded: id => sellerStreamAlreadyAdded(group.target, id)
    });
    const resolver = picker.resolvePromise;
    const current = () => picker.resolvePromise === resolver && (!group.id || stateManager.getGroup(group.id) === group)
        && (!existingSourceId || !!stateManager.getSource(existingSourceId));
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'yt-stream-button secondary'; refresh.textContent = 'Refresh';
    picker.cancelButton.before(refresh);
    picker.activateButton.disabled = true;
    const dialog = picker.modal.querySelector('.yt-stream-modal-content');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `Streams for ${group.username}`);
    picker.closeButton.setAttribute('role', 'button'); picker.closeButton.tabIndex = 0;
    picker.closeButton.setAttribute('aria-label', 'Close');
    const onKey = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); picker.hide(); }
        else if (event.target === picker.closeButton && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); picker.hide();
        } else if (event.key === 'Tab') {
            const controls = [...dialog.querySelectorAll('button:not(:disabled), [tabindex="0"]')];
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    };
    picker.modal.addEventListener('keydown', onKey);
    const message = text => {
        picker.streamList.replaceChildren();
        const status = document.createElement('p'); status.className = 'yt-stream-discovery-message';
        status.setAttribute('role', 'status'); status.textContent = text; picker.streamList.appendChild(status);
    };
    async function load() {
        if (!current() || refresh.disabled) return;
        refresh.disabled = true; picker.activateButton.disabled = true;
        picker.selectedStreams.clear(); picker.streams = [];
        message('Looking for streams…');
        try {
            const streams = await discoverSellerStreams(group, current);
            if (!current()) { if (picker.resolvePromise === resolver) picker.hide(); return; }
            picker.streams = streams;
            if (!streams.length) message(group.target === 'whatnot' ? 'No live or upcoming shows. Check again later.' : 'No live streams. Check again later.');
            else { picker.streamList.replaceChildren(); await picker.createStreamElements(streams, group.username, false); }
        } catch (error) {
            if (current()) message(error.message || 'Could not load streams. Try Refresh.');
        } finally { refresh.disabled = false; }
    }
    refresh.onclick = load;
    // Let the shared picker finish displaying before placing keyboard focus.
    await Promise.resolve();
    picker.cancelButton.focus();
    void load();
    try {
        const selected = await selection;
        if (!Array.isArray(selected) || (group.id && stateManager.getGroup(group.id) !== group)) return;
        for (const stream of selected) await saveSellerStream(group, stream, existingSourceId);
    } catch (error) {
        Toast.error('Unable to add stream', error.message);
    } finally {
        refresh.remove(); picker.modal.removeEventListener('keydown', onKey);
        picker.activateButton.disabled = false;
        dialog.removeAttribute('role'); dialog.removeAttribute('aria-modal'); dialog.removeAttribute('aria-label');
        picker.closeButton.removeAttribute('role'); picker.closeButton.removeAttribute('tabindex'); picker.closeButton.removeAttribute('aria-label');
        if (previousFocus?.isConnected) previousFocus.focus();
    }
}

function setupSellerGroupUI(element, group) {
    if (!isSellerGroup(group)) return;
    const controls = element.querySelector('.control-panel');
    if (controls) controls.style.setProperty('display', 'none', 'important');
    element.querySelector('[onclick="handleYouTubeGroupAutoActivation(this)"]')?.classList.add('hidden');
    element.querySelector('.help-btn')?.classList.add('hidden');
    const check = element.querySelector('[onclick="handleYouTubeGroupActivationPrompt(this)"]');
    if (check) {
        check.dataset.sellerDiscovery = 'true';
        check.onclick = () => chooseSellerStreams(stateManager.getGroup(group.id));
    }
}
