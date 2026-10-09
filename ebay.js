'use strict';

// eBay Live setup uses the same public discovery query as eBay's event pages.
// Capture remains an ordinary source window with its selected /chat URL.
const EBAY_LIVE_DOMAINS = new Set(['ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.com.au', 'ebay.ca', 'ebay.fr',
    'ebay.it', 'ebay.es', 'ebay.nl', 'ebay.ie', 'ebay.at', 'ebay.ch', 'ebay.pl', 'ebay.be',
    'ebay.com.hk', 'ebay.com.sg', 'ebay.com.my', 'ebay.ph']);

function getEbayLiveOrigin(value) {
    let url;
    const input = String(value || '').trim();
    try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch (_) {}
    const host = (url?.hostname || '').replace(/^www\./, '');
    const localized = ['cafr.ebay.ca', 'befr.ebay.be', 'benl.ebay.be'].includes(host);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        (!localized && !EBAY_LIVE_DOMAINS.has(host))) {
        throw new Error('Use an eBay Live link from an eBay marketplace, such as ebay.ca, ebay.co.uk or ebay.com.');
    }
    // Bare marketplace domains redirect to www; use the canonical host so the
    // saved URL also matches the capture manifest. Preserve regional languages.
    return 'https://' + (EBAY_LIVE_DOMAINS.has(host) ? 'www.' + host : host);
}

function parseEbayLiveInput(value, idType = 'event') {
    const input = String(value || '').trim();
    if (!input) throw new Error('Enter an eBay Live event or seller link, or an ID.');
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(input)) {
        return { type: idType === 'seller' ? 'seller' : 'event', id: input, origin: 'https://www.ebay.com' };
    }
    const origin = getEbayLiveOrigin(input);
    const url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
    const match = url.pathname.match(/^\/ebaylive\/(events|sellers)\/([a-zA-Z0-9_-]{1,128})(?:\/(chat|stream))?\/?$/);
    if (!match || (match[1] === 'sellers' && match[3])) {
        throw new Error('Use an eBay Live event or seller link. Store names and /usr/ profile links are not seller IDs.');
    }
    return { type: match[1] === 'sellers' ? 'seller' : 'event', id: match[2], origin };
}

async function validateEbayLiveEvent(parsed) {
    if (parsed.type !== 'event') throw new Error('Choose an eBay Live event first. Use the source menu to choose another stream.');
    let result;
    try {
        result = await ipcRenderer.invoke('nodefetch', {
            url: parsed.origin + '/ebaylive/graphql', method: 'POST', timeout: 15000,
            headers: { 'Content-Type': 'application/json' },
            body: { operationName: 'Events', query: EBAY_EVENTS_QUERY,
                variables: { liveEventsInput: { ids: [parsed.id] }, includeVideoPreview: false } }
        });
    } catch (_) {}
    let body;
    try { body = typeof result?.data === 'string' ? JSON.parse(result.data) : result?.data; } catch (_) {}
    const events = body?.data?.liveEvents?.events;
    if (result?.status !== 200 || body?.errors?.length || !Array.isArray(events)) {
        throw new Error('Could not verify this eBay Live event. Check your connection and try again.');
    }
    const event = events.find(item => item && item.id === parsed.id);
    if (!event) throw new Error('eBay Live event not found. Paste the full event link; a seller ID or login session ID is not an event ID.');
    return event;
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
    const source = existingSourceId ? stateManager.getSource(existingSourceId) : null;
    if (source?.ebaySellerId) {
        return chooseSellerStreams({ target: 'ebay', sellerId: source.ebaySellerId,
            username: source.ebaySellerId, sellerOrigin: source.ebayOrigin || 'https://www.ebay.com' }, existingSourceId);
    }
    return showSellerSourceSetup('ebay', existingSourceId);
}

function chooseEbaySourceStream(button) {
    const sourceId = button.closest('[data-source-id]')?.dataset.sourceId;
    if (!sourceId) return;
    closeOtherSettingsMenus();
    showEbayAddSourcePrompt(sourceId);
}
