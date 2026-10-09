'use strict';

// Public profile query used by Whatnot's Shows page. Electron's network stack
// is required here; Node fetch is rejected even for these public requests.
const QUERY = `query GetUserLiveStreams($username: String!, $first: Int, $after: String) {
  getUser(username: $username) {
    id username
    livestreams(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title status startTime activeViewers isHiddenBySeller
        thumbnail { url }
        user { id username }
      } }
    }
  }
}`;

async function discoverWhatnotStreams(args, session) {
    const username = String(args?.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{1,100}$/.test(username) || /^\.+$/.test(username)) {
        throw new Error('Enter a Whatnot username or profile link.');
    }
    const customSession = String(args.customSession || 'AUTO').trim();
    const partition = !customSession || customSession === 'AUTO' ? 'persist:whatnot'
        : customSession.startsWith('default-') ? `persist:${customSession.slice(8) || 'whatnot'}`
        : `persist:custom-${customSession}`;
    const network = session.fromPartition(partition);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const streams = new Map();
    const cursors = new Set();
    let after = null;
    try {
        for (let page = 0; page < 20; page++) {
            const headers = { 'Content-Type': 'application/json' };
            if (args.userAgent && args.userAgent !== 'AUTO') headers['User-Agent'] = args.userAgent;
            const response = await network.fetch('https://www.whatnot.com/services/graphql/?operationName=GetUserLiveStreams&ssr=0', {
                method: 'POST', headers, redirect: 'error', cache: 'no-store', signal: controller.signal,
                body: JSON.stringify({ operationName: 'GetUserLiveStreams', query: QUERY,
                    variables: { username, first: 50, after } })
            });
            if (!response.ok) throw new Error('Could not load Whatnot shows. Try Refresh or use a show link directly.');
            const body = await response.json();
            if (body.errors?.length || !body.data || !Object.prototype.hasOwnProperty.call(body.data, 'getUser')) {
                throw new Error('Could not read Whatnot shows. Try Refresh or use a show link directly.');
            }
            const user = body.data.getUser;
            if (!user) throw new Error('Whatnot seller not found. Check the username or profile link.');
            if (String(user.username || '').toLowerCase() !== username || !Array.isArray(user.livestreams?.edges)
                || typeof user.livestreams.pageInfo?.hasNextPage !== 'boolean') {
                throw new Error('Whatnot returned an incomplete seller listing. Try Refresh.');
            }
            for (const { node } of user.livestreams.edges) {
                if (!node || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(node.id || '')
                    || String(node.user?.username || '').toLowerCase() !== username
                    || node.isHiddenBySeller || !['PLAYING', 'CREATED'].includes(node.status)) continue;
                const thumbnail = /^https:\/\/images\.whatnot\.com\//i.test(node.thumbnail?.url || '') ? node.thumbnail.url : '';
                streams.set(node.id.toLowerCase(), {
                    videoId: node.id.toLowerCase(), title: node.title || node.id,
                    status: node.status === 'PLAYING' ? 'live' : 'upcoming',
                    channelTitle: user.username, scheduledStartTime: node.startTime,
                    viewers: node.status === 'PLAYING' && Number.isFinite(node.activeViewers) ? node.activeViewers : undefined,
                    thumbnails: { medium: { url: thumbnail } }
                });
            }
            if (!user.livestreams.pageInfo.hasNextPage) {
                return { sellerId: user.id, username: user.username, streams: [...streams.values()].sort((a, b) =>
                    (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1)
                    || (a.scheduledStartTime || 0) - (b.scheduledStartTime || 0)) };
            }
            after = user.livestreams.pageInfo.endCursor;
            if (!after || cursors.has(after)) break;
            cursors.add(after);
        }
        throw new Error('The Whatnot show list was incomplete. Try Refresh or use a show link directly.');
    } catch (error) {
        if (controller.signal.aborted) throw new Error('Whatnot lookup timed out. Try Refresh.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { discoverWhatnotStreams };
