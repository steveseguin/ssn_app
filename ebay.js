'use strict';

// eBay Live setup uses the same public discovery query as eBay's event pages.
// Capture remains an ordinary source window with its selected /chat URL.
const EBAY_LIVE_DOMAINS = new Set(['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.com.au', 'ebay.ca', 'ebay.fr',
    'ebay.it', 'ebay.es', 'ebay.nl', 'ebay.ie', 'ebay.at', 'ebay.ch', 'ebay.pl', 'ebay.be',
    'ebay.com.hk', 'ebay.com.sg', 'ebay.com.my', 'ebay.ph']);

function parseEbayLiveInput(value, idType = 'event') {
    const input = String(value || '').trim();
    if (!input) throw new Error('Enter an eBay Live event or seller link, or an ID.');
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(input)) {
        return { type: idType === 'seller' ? 'seller' : 'event', id: input, origin: 'https://www.ebay.com' };
    }
    let url;
    try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch (_) {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        !EBAY_LIVE_DOMAINS.has(url.hostname.replace(/^(www|cafr|befr|benl)\./, ''))) {
        throw new Error('Use an eBay Live link, such as ebay.com/ebaylive/events/… or ebay.com/ebaylive/sellers/….');
    }
    const match = url.pathname.match(/^\/ebaylive\/(events|sellers)\/([a-zA-Z0-9_-]{1,128})(?:\/(chat|stream))?\/?$/);
    if (!match || (match[1] === 'sellers' && match[3])) {
        throw new Error('Use an eBay Live event or seller link. Store names and /usr/ profile links are not seller IDs.');
    }
    return { type: match[1] === 'sellers' ? 'seller' : 'event', id: match[2], origin: 'https://' + url.hostname };
}

const EBAY_EVENTS_QUERY = `query Events($liveEventsInput: LiveEventsInput!, $includeVideoPreview: Boolean!) {
  liveEvents(liveEventsInput: $liveEventsInput) {
    events {
      ...Event
      liveEventStream @include(if: $includeVideoPreview) {
        previewLiveUrl
        __typename
      }
      liveCrossBorderTradeData {
        isLikelyCBTBuyer
        sellerShipFromCountry
        __typename
      }
      __typename
    }
    nextPageCursor
    __typename
  }
}

fragment Image on Image {
  id
  url
  width
  height
  __typename
}

fragment Host on User {
  id
  profilePictureUrl
  userAccountName
  sellerProfile {
    sellerStore {
      name
      logo {
        id
        url
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}

fragment Event on LiveEvent {
  id
  title
  previewImage {
    ...Image
    __typename
  }
  watchedCount
  isUserRegistered
  state
  startTime
  isCaseBreak
  hosts {
    ...Host
    __typename
  }
  tags {
    name
    id
    __typename
  }
  __typename
}`;

async function findEbayLiveEvents(seller, isCurrent = () => true) {
    const events = new Map();
    const cursors = new Set();
    let pageCursor;
    for (let page = 0; page < 20 && isCurrent(); page++) {
        const pagination = { maxPageSize: 100 };
        if (pageCursor) pagination.pageCursor = pageCursor;
        const result = await ipcRenderer.invoke('nodefetch', {
            url: seller.origin + '/ebaylive/graphql', method: 'POST', timeout: 15000,
            headers: { 'Content-Type': 'application/json' },
            body: { operationName: 'Events', query: EBAY_EVENTS_QUERY, variables: {
                liveEventsInput: { sellerId: seller.id, states: ['LIVE'], pagination }, includeVideoPreview: false
            } }
        });
        if (!isCurrent()) return [];
        let body;
        try { body = typeof result.data === 'string' ? JSON.parse(result.data) : result.data; } catch (_) {}
        const data = body?.data?.liveEvents;
        if (result.status !== 200 || body?.errors?.length || !Array.isArray(data?.events)) {
            throw new Error('Could not load this seller’s live events. Try Refresh, or paste an event link directly.');
        }
        for (const event of data.events) {
            if (event.state !== 'LIVE' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.id || '') ||
                !event.hosts?.some(host => host.id === seller.id)) continue;
            events.set(event.id, event);
        }
        pageCursor = data.nextPageCursor;
        if (!pageCursor) return [...events.values()];
        if (cursors.has(pageCursor)) break;
        cursors.add(pageCursor);
    }
    if (!isCurrent()) return [];
    throw new Error('The live-event list was incomplete. Try Refresh or paste the event link directly.');
}

function showEbayAddSourcePrompt(existingSourceId = null) {
    const existing = existingSourceId ? stateManager.getSource(existingSourceId) : null;
    const modal = showModal(`<div class="modal-content ebay-setup" role="dialog" aria-labelledby="ebay-setup-title">
        <h2 id="ebay-setup-title">${existing ? 'Choose another eBay Live stream' : 'Add eBay Live'}</h2>
        <p>Paste an event link to capture that event, or a seller link to choose from their live streams.</p>
        <form id="ebay-setup-form">
            <label for="ebay-live-input">Event or seller link / ID</label>
            <input id="ebay-live-input" type="text" autocomplete="off" spellcheck="false" placeholder="https://www.ebay.com/ebaylive/events/…" aria-describedby="ebay-input-help">
            <div class="ebay-id-type"><label for="ebay-id-type">For an ID without a link:</label>
                <select id="ebay-id-type"><option value="event">Event ID</option><option value="seller">Seller ID</option></select></div>
            <p id="ebay-input-help" class="ebay-help">Event links can end in /stream or /chat. Seller links contain /ebaylive/sellers/. Use the seller ID, not the store name.</p>
            <div class="ebay-buttons"><button type="submit" id="ebay-continue">Continue</button><button type="button" id="ebay-refresh" hidden>Refresh</button><button type="button" id="ebay-cancel" data-type="cancel">Cancel</button></div>
        </form>
        <p id="ebay-status" role="status" aria-live="polite"></p>
        <div id="ebay-events" aria-label="Live events"></div>
        <p class="ebay-help">Chat and auction data are captured together. The selected event stays saved until you choose a different one.${existing ? ' Choosing a different event stops this source; activate it when you are ready.' : ''}</p>
    </div>`);
    const input = modal.querySelector('#ebay-live-input');
    const type = modal.querySelector('#ebay-id-type');
    const status = modal.querySelector('#ebay-status');
    const results = modal.querySelector('#ebay-events');
    const refresh = modal.querySelector('#ebay-refresh');
    const submit = modal.querySelector('#ebay-continue');
    let revision = 0;
    let saving = false;
    const current = run => modal.isConnected && run === revision;
    if (existing?.ebaySellerId) {
        input.value = (existing.ebayOrigin || 'https://www.ebay.com') + '/ebaylive/sellers/' + existing.ebaySellerId;
        type.value = 'seller';
    } else if (existing?.url) input.value = existing.url;

    function resetResults() {
        revision++;
        results.replaceChildren();
        refresh.hidden = true;
        submit.disabled = false;
        status.textContent = '';
    }
    input.addEventListener('input', resetResults);
    type.addEventListener('change', resetResults);
    modal.querySelector('#ebay-cancel').onclick = () => closeModal();

    async function saveEvent(event, parsed, run) {
        if (!current(run) || saving) return;
        saving = true;
        modal.querySelectorAll('button, input, select').forEach(element => { element.disabled = true; });
        const url = parsed.origin + '/ebaylive/events/' + event.id + '/chat';
        const data = { username: event.title || 'eBay Live ' + event.id, videoId: event.id,
            ebaySellerId: parsed.type === 'seller' ? parsed.id : null, ebayOrigin: parsed.origin,
            sourceFile: 'sources/ebay.js', connectionMode: 'classic' };
        try {
            // Source rows are cloned from a body-level template. Restore the
            // modal's temporary inert/aria-hidden state before cloning it.
            closeModal();
            if (existingSourceId) {
                const source = stateManager.getSource(existingSourceId);
                if (!source) throw new Error('This source was removed. Close this dialog and add it again.');
                if (source.url !== url) {
                    const row = document.querySelector(`[data-source-id="${CSS.escape(existingSourceId)}"]`);
                    if (!row) throw new Error('The source is still loading. Close this dialog and try again.');
                    await stopThis(row.querySelector('[data-stophtml]'));
                    stateManager.updateSource(existingSourceId, { ...data, url, status: 'inactive', error: null });
                } else stateManager.updateSource(existingSourceId, data);
            } else {
                await newOtherSource('ebay', url, false, data);
            }
            if (modal.isConnected) closeModal();
        } catch (error) {
            if (modal.isConnected) {
                status.textContent = error.message || 'Could not add this event.';
                modal.querySelectorAll('button, input, select').forEach(element => { element.disabled = false; });
            } else Toast.error('eBay Live', error.message || 'Could not add this event.');
        } finally { saving = false; }
    }

    async function lookup(event) {
        if (event) event.preventDefault();
        if (saving) return;
        const run = ++revision;
        results.replaceChildren();
        let parsed;
        try { parsed = parseEbayLiveInput(input.value, type.value); }
        catch (error) { status.textContent = error.message; input.focus(); return; }
        if (parsed.type === 'event') return saveEvent({ id: parsed.id }, parsed, run);
        type.value = 'seller';
        refresh.hidden = false;
        refresh.disabled = true;
        submit.disabled = true;
        status.textContent = 'Looking for live streams…';
        try {
            const events = await findEbayLiveEvents(parsed, () => current(run));
            if (!current(run)) return;
            status.textContent = events.length ? `${events.length} live ${events.length === 1 ? 'stream' : 'streams'} found. Choose the event you want to capture.` : 'No live streams found for this seller. Check the seller ID, try Refresh, or paste an event link directly.';
            for (const live of events) {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'ebay-event';
                const imageUrl = live.previewImage?.url;
                try {
                    const image = new URL(imageUrl);
                    if (image.protocol === 'https:' && (image.hostname === 'i.ebayimg.com' || image.hostname.endsWith('.ebayimg.com'))) {
                        const thumbnail = document.createElement('img');
                        thumbnail.src = image.href; thumbnail.alt = ''; thumbnail.loading = 'lazy';
                        card.appendChild(thumbnail);
                    }
                } catch (_) {}
                const info = document.createElement('span');
                const title = document.createElement('strong'); title.textContent = live.title || live.id;
                const detail = document.createElement('span');
                detail.textContent = 'LIVE' + (Number.isFinite(live.watchedCount) ? ' · ' + live.watchedCount.toLocaleString() + ' viewers' : '') + ' · ' + live.id;
                info.append(title, detail); card.appendChild(info);
                card.onclick = () => saveEvent(live, parsed, run);
                results.appendChild(card);
            }
        } catch (error) {
            if (current(run)) status.textContent = error.message || 'Could not load live streams. Try Refresh.';
        } finally {
            if (current(run)) { refresh.disabled = false; submit.disabled = false; }
        }
    }
    modal.querySelector('#ebay-setup-form').onsubmit = lookup;
    refresh.onclick = lookup;
    input.focus();
    if (existing?.ebaySellerId) lookup();
}

function chooseEbaySourceStream(button) {
    const sourceId = button.closest('[data-source-id]')?.dataset.sourceId;
    if (!sourceId) return;
    closeOtherSettingsMenus();
    showEbayAddSourcePrompt(sourceId);
}
