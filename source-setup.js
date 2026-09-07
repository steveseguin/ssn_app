'use strict';

// Extract handles only from known channel/watch/chat routes for this platform.
// Leave the specialized YouTube, Rumble and authenticated connectors to their
// existing parsers. A URL from another site must not become a username.
function normalizeSimpleSourceInput(target, value) {
    const routes = {
        velora: [/^(?:www\.)?velora\.tv$/, /^\/([^/]+)\/?$/],
        picarto: [/^(?:www\.)?picarto\.tv$/, /^\/(?:chatpopout\/)?([^/]+)(?:\/public)?\/?$/],
        mixcloud: [/^(?:www\.)?mixcloud\.com$/, /^\/(?:live\/)?([^/]+)(?:\/chat)?\/?$/],
        twitcasting: [/^(?:www\.)?twitcasting\.tv$/, /^\/([^/]+)(?:\/broadcaster)?\/?$/],
        younow: [/^(?:www\.)?younow\.com$/, /^\/([^/]+)\/?$/],
        chzzk: [/^chzzk\.naver\.com$/, /^\/(?:live\/)?([a-fA-F0-9]{32})(?:\/chat)?\/?$/],
        nimo: [/^(?:www\.)?nimo\.tv$/, /^\/(?:popout\/chat\/|live\/)?([^/]+)\/?$/],
        sooplive: [/^play\.sooplive\.com$/, /^\/([^/]+)(?:\/\d+)?\/?$/],
        beamstream: [/^(?:www\.)?beamstream\.gg$/, /^\/([^/]+)(?:\/chat)?\/?$/],
        x: [/^(?:www\.)?(?:x\.com|twitter\.com)$/, /^\/([^/]+)(?:\/livechat)?\/?$/],
        arenasocial: [/^(?:www\.)?arena\.social$/, /^\/(?:live\/)?([^/]+)\/?$/]
    };
    const route = routes[target];
    if (!route) return value;
    let handle = String(value || '').trim().replace(/^@+/, '');
    if (/^(?:https?:\/\/|www\.)/i.test(handle) || handle.includes('/') || route[0].test(handle.toLowerCase())) {
        let url;
        try { url = new URL(/^https?:\/\//i.test(handle) ? handle : 'https://' + handle); } catch (_) { }
        const match = url && !url.username && !url.password && !url.port &&
            /^https?:$/.test(url.protocol) && route[0].test(url.hostname) && url.pathname.match(route[1]);
        if (!match) throw new Error('Enter a channel handle or a channel/chat URL from the selected site.');
        try { handle = decodeURIComponent(match[1]); } catch (_) { handle = ''; }
    }
    const pattern = target === 'twitcasting' ? /^[\w.:-]+$/ : /^[\w.-]+$/;
    if (!pattern.test(handle) || /^(?:\.+|live|chat|explore|discover|login|signup)$/i.test(handle)) {
        throw new Error('Enter the channel handle from its URL, not a home page or video link.');
    }
    return handle;
}

// Public channel routes verified in SSApp's source windows. These are channel
// identifiers, not display names; never append an unparsed URL to a route.
function parseNamedSourceInput(target, value) {
    const definitions = {
        bigo: { hosts: ['www.bigo.tv', 'bigo.tv'], path: /^\/(?:user\/|[a-z]{2}\/)?([^/]+)\/?$/, base: 'https://www.bigo.tv/', suffix: '' },
        loco: { hosts: ['loco.com', 'www.loco.com', 'loco.gg', 'www.loco.gg'], path: /^\/(?:chat\/)?streamers\/([^/]+)\/?$/, base: 'https://loco.com/chat/streamers/', suffix: '' },
        vkvideo: { hosts: ['live.vkvideo.ru', 'live.vkplay.ru', 'vkplay.live'], path: /^\/([^/]+)(?:\/only-chat|\/stream\/sl_\d+)?\/?$/, base: 'https://live.vkvideo.ru/', suffix: '/only-chat' }
    };
    const definition = definitions[target];
    if (!definition) throw new Error('Choose a supported platform.');
    let username = String(value || '').trim().replace(/^@/, '');
    if (/^(?:https?:\/\/|www\.)/i.test(username) || username.includes('/') || definition.hosts.includes(username.toLowerCase())) {
        let url;
        try { url = new URL(/^https?:\/\//i.test(username) ? username : 'https://' + username); } catch (_) { }
        if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !definition.hosts.includes(url.hostname)) {
            throw new Error('Paste a channel link from the selected site, or enter its channel ID/handle.');
        }
        const match = url.pathname.match(definition.path);
        if (!match) throw new Error('Use a channel link, not the home page or an individual video link.');
        username = match[1];
    }
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(username) || ['.', '..', 'app', 'games', 'show', 'user', 'streamers', 'offline'].includes(username.toLowerCase())) {
        throw new Error('Enter the channel ID/handle from its URL, not its display name.');
    }
    if (target !== 'bigo') username = username.toLowerCase();
    return { username, url: definition.base + encodeURIComponent(username) + definition.suffix };
}

function createSourceSetup(title, description, fields, save) {
    const modal = showModal(`<div class="modal-content source-setup" role="dialog" aria-labelledby="source-setup-title">
        <h2 id="source-setup-title">${title}</h2>${description}
        <form id="source-setup-form">${fields}
            <p id="source-setup-error" role="alert"></p>
            <div class="source-setup-buttons"><button type="submit">Add source</button>
                <button type="button" data-type="cancel">Cancel</button></div>
        </form></div>`);
    modal.querySelector('[data-type="cancel"]').onclick = () => closeModal();
    modal.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        try { await save(modal); } catch (error) {
            if (modal.isConnected) modal.querySelector('#source-setup-error').textContent = error.message;
            else Toast.error('Unable to add source', error.message);
        }
    };
    return modal;
}

function showNamedSourceSetup(target) {
    const definitions = {
        bigo: ['BIGO Live', 'BIGO ID or broadcaster URL', 'Opens the broadcaster’s watch page, with chat beside the video. Use the BIGO ID or handle in the URL, not the display name.', 'https://www.bigo.tv/123456789'],
        loco: ['Loco', 'Streamer handle or channel URL', 'Opens the channel’s read-only chat pop-out. Use the handle in the streamer URL, not an individual stream/video ID.', 'https://loco.com/streamers/handle'],
        vkvideo: ['VK Video Live', 'Channel handle or channel URL', 'Opens the channel’s chat-only page. Use a VK Video Live channel, not a VK social profile or a regular VK video link.', 'https://live.vkvideo.ru/handle']
    };
    const definition = definitions[target];
    if (!definition) return;
    createSourceSetup('Add ' + definition[0], `<p>${definition[2]}</p>`,
        `<label for="source-setup-input">${definition[1]}</label><input id="source-setup-input" type="text" required autocomplete="off" spellcheck="false" placeholder="${definition[3]}">`,
        async modal => {
            const parsed = parseNamedSourceInput(target, modal.querySelector('input').value);
            closeModal(); // Restore the source template before creating a row.
            await newOtherSource(target, parsed.url, false, { username: parsed.username, sourceFile: 'sources/' + target + '.js' });
        });
}

function showBilibiliSourceSetup() {
    createSourceSetup('Add Bilibili', '<p>Choose the site your live room is on. These are separate regional services; use the room link from that site.</p>',
        `<label for="bilibili-site">Bilibili site</label>
        <select id="bilibili-site" aria-describedby="bilibili-site-help">
            <option value="bilibilicom">Bilibili.com — China</option>
            <option value="bilibilitv">Bilibili.tv / Bstation — international</option>
        </select>
        <p id="bilibili-site-help">Bilibili.com is the Chinese platform; live rooms use live.bilibili.com. Bilibili.tv serves international audiences, especially Southeast Asia. The room links and IDs are different.</p>
        <label for="source-setup-input">Live room URL or room ID</label>
        <input id="source-setup-input" type="text" required autocomplete="off" spellcheck="false" placeholder="Paste the live room URL or its ID">
        <p>Use a live room, not a profile or a recorded video. SSApp opens the live watch page to capture its chat.</p>`,
        async modal => {
            const target = modal.querySelector('select').value;
            let id = modal.querySelector('input').value.trim();
            if (!/^\d+$/.test(id)) {
                let url;
                try { url = new URL(/^https?:\/\//i.test(id) ? id : 'https://' + id); } catch (_) { }
                const match = url && !url.username && !url.password && !url.port && ['https:', 'http:'].includes(url.protocol) && (target === 'bilibilicom'
                    ? url.hostname === 'live.bilibili.com' && url.pathname.match(/^\/(\d+)\/?$/)
                    : /^(?:www\.)?bilibili\.tv$/.test(url.hostname) && url.pathname.match(/^\/(?:[a-z]{2}\/)?live\/(\d+)\/?$/));
                if (!match) throw new Error('Paste a live room URL from the selected Bilibili site, or enter its numeric room ID.');
                id = match[1];
            }
            closeModal();
            await newSource(target, id);
        });
}

function newOtherSourcePrompt(target = '') {
    createSourceSetup('Add other source',
        '<p>Paste the URL of the page showing your chat.</p>',
        `<label for="source-setup-input">Chat page URL</label>
        <input id="source-setup-input" type="text" required autocomplete="off" spellcheck="false" placeholder="https://...">
        <details class="source-setup-help">
            <summary>Which URL should I use?</summary>
            <p>Use the chat pop-out if supported. Some sites need the full watch or live event page with chat visible instead.</p>
            <p>Use a supported site's chat page, not its homepage or a username. After adding it, activate the source and sign in if needed.</p>
            <p><a href="https://socialstream.ninja/docs/supported-sites.html" target="_blank" rel="noopener">Supported sites and setup instructions</a></p>
        </details>`,
        async modal => {
            const value = modal.querySelector('input').value.trim();
            let url;
            try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : 'https://' + value); } catch (_) { }
            if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || !(url.hostname.includes('.') || url.hostname === 'localhost' || url.hostname.startsWith('['))) {
                throw new Error('Enter a full http:// or https:// page URL.');
            }
            closeModal();
            await addOtherSourceFromUrl(target, url.href);
        });
}
