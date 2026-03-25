/**
 * TikTok Chat Filter Test
 * Tests message counts/fold-types with identity='audience' vs 'anchor'
 * Also checks fold type distribution — foldType/anchorFoldType live in data.common
 *
 * Usage: node test-chat-filter.js [username] [duration_seconds]
 * Example: node test-chat-filter.js paigehutson 30
 *
 * foldType / anchorFoldType known values (from TikTok Studio protobuf):
 *   0 = NotFold   → show in main rolling buffer
 *   1 = Fold      → show in bottom/secondary buffer only (filtered from main view)
 *   2 = ?         → TBD (overage / low-priority?)
 */

const { TikTokLiveConnection } = require('./node_modules/tiktok-live-connector');

const TARGET = process.argv[2] || 'paigehutson';
const DURATION_SEC = parseInt(process.argv[3] || '20', 10);
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;

async function testIdentity(username, identity, label) {
    return new Promise((resolve) => {
        const counts = { chat: 0, errors: 0 };
        const messages = [];
        const foldDist = {};       // foldType distribution
        const anchorFoldDist = {}; // anchorFoldType distribution

        const conn = new TikTokLiveConnection(username, {
            processInitialData: false,
            fetchRoomInfoOnConnect: true,
            enableExtendedGiftInfo: false,
            enableRequestPolling: true,
            requestPollingIntervalMs: 2000,
            signApiKey: SIGN_API_KEY,
            wsClientParams: { identity }
        });

        conn.on('chat', (data) => {
            counts.chat++;
            const c = data.common || {};
            const foldType = c.foldType ?? c.fold_type ?? 'absent';
            const anchorFoldType = c.anchorFoldType ?? c.anchor_fold_type ?? 'absent';
            const anchorFoldTypeForWeb = c.anchorFoldTypeForWeb ?? 'absent';
            const priorityScore = c.priorityScore ?? 'absent';
            const filterTags = c.filterMsgTagsList?.join(',') || '';

            foldDist[foldType] = (foldDist[foldType] || 0) + 1;
            anchorFoldDist[anchorFoldType] = (anchorFoldDist[anchorFoldType] || 0) + 1;

            messages.push({
                user: data.user?.uniqueId || data.uniqueId || '?',
                text: (data.comment || '').slice(0, 55),
                foldType,
                anchorFoldType,
                anchorFoldTypeForWeb,
                priorityScore,
                filterTags
            });
        });

        conn.on('error', (err) => {
            counts.errors++;
            console.error(`  [${label}] Error:`, err?.message || err);
        });

        conn.on('disconnected', () => {});

        const timer = setTimeout(async () => {
            try { await conn.disconnect(); } catch (_) {}
            resolve({ label, identity, counts, messages, foldDist, anchorFoldDist });
        }, DURATION_SEC * 1000);

        console.log(`\n[${label}] @${username} identity='${identity}'...`);
        conn.connect()
            .then(info => {
                console.log(`  Connected! Room: ${info?.roomId || '?'}, Viewers: ${info?.viewerCount ?? '?'}`);
            })
            .catch(err => {
                console.error(`  Connect failed:`, err?.message || err);
                clearTimeout(timer);
                resolve({ label, identity, counts: { ...counts, connectFailed: true }, messages, foldDist, anchorFoldDist });
            });
    });
}

function printResult(result) {
    const { label, identity, counts, messages, foldDist, anchorFoldDist } = result;
    console.log(`\n${'='.repeat(65)}`);
    console.log(`RESULT: ${label} (identity='${identity}')`);
    if (counts.connectFailed) {
        console.log('  ** CONNECT FAILED (TikTok rejected the identity) **');
        return;
    }
    console.log(`  Messages received: ${counts.chat}  |  Errors: ${counts.errors}`);
    console.log(`  foldType dist:       `, JSON.stringify(foldDist));
    console.log(`  anchorFoldType dist: `, JSON.stringify(anchorFoldDist));

    if (messages.length > 0) {
        console.log(`\n  Last ${Math.min(8, messages.length)} messages:`);
        messages.slice(-8).forEach(m => {
            const tags = m.filterTags ? ` tags=[${m.filterTags}]` : '';
            console.log(`    fold=${m.foldType} aFold=${m.anchorFoldType} pri=${m.priorityScore}${tags} | ${m.user}: ${m.text}`);
        });
    }
    console.log('='.repeat(65));
}

async function runStream(username) {
    console.log(`\n${'#'.repeat(65)}`);
    console.log(`STREAM: @${username}  (${DURATION_SEC}s per identity mode)`);
    console.log(`${'#'.repeat(65)}`);

    const audienceResult = await testIdentity(username, 'audience', 'AUDIENCE');
    printResult(audienceResult);

    if (!audienceResult.counts.connectFailed) {
        console.log(`\nWaiting 3s before anchor test...`);
        await new Promise(r => setTimeout(r, 3000));
        const anchorResult = await testIdentity(username, 'anchor', 'ANCHOR');
        printResult(anchorResult);

        console.log(`\n  DIFF: audience=${audienceResult.counts.chat}  anchor=${anchorResult.counts.chat}`);
        if (!anchorResult.counts.connectFailed) {
            const diff = anchorResult.counts.chat - audienceResult.counts.chat;
            console.log(`  anchor got ${diff > 0 ? '+' + diff + ' more' : diff < 0 ? -diff + ' fewer' : 'same'} messages`);
        }
    }
}

(async () => {
    const streams = process.argv.slice(2).filter(a => !/^\d+$/.test(a));
    const targets = streams.length > 0 ? streams : [TARGET];

    for (const username of targets) {
        await runStream(username);
        if (targets.indexOf(username) < targets.length - 1) {
            console.log('\nWaiting 5s between streams...');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    process.exit(0);
})();
