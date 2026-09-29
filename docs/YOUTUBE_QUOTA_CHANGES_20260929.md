# YouTube discovery and quota changes — September 29, 2026

The public-channel picker shows API results immediately, then checks the requested
channel's page for missing live/upcoming streams. Added rows are not automatically
selected. Existing selections and Shorts edits survive the update. Closed or replaced
pickers ignore late results. Manual Auto-find & Activate includes page results before
activating streams, and retains the API results if the page lookup fails.

Page enrichment reuses the known results, the existing five-second manual cache,
and shared in-flight discovery. It does not request another API stream list.

## Deployed backend patch

[The backend patch](youtube-backend-quota-20260929.patch) was applied to
`/var/www/html/youtube` on September 29. Original files are backed up in
`/home/punkrawker/ssapp-youtube-20260929/original` outside the web root.

- `channel.php`, `channel_info.php`, and `channel_title.php` allow an uncached
  first lookup even if previous requests reached the old local per-IP quota limit.
- `youtube_helper.php` counts outbound API attempts immediately before sending
  them, including failed attempts. Cached responses do not increment these totals.
- `channel_info.php` reuses a cached video-to-channel mapping and channel details
  when the combined response is absent. It no longer fetches unused video details
  in that case. Existing full-data cache entries retain precedence, and callers
  that need video details still receive them.

Counters are stored in Memcached for seven days, keyed by
`ytapi_requests:YYYY-MM-DD:endpoint:operation`. The date is UTC. They contain only
aggregate request counts, without API keys, video IDs or client IP addresses.
These count attempts rather than Google quota units; Google operations have
different costs, and transport failures need not have reached Google. Cache loss
also loses the counters. They are diagnostic totals, not a daily quota ceiling.

The server-side readout is `php /home/punkrawker/ssapp-youtube-20260929/usage.php`
with an optional UTC date argument. Additional abuse limits remain pending traffic
review; they must not blanket-block a user's first lookup.

## Validation

- Isolated real Electron workflow: partial API results, owned page results,
  rejecting unrelated recommendations, preserved edits/selections, late results,
  shared requests, cached repeats, page timeout recovery, and manual activation.
- Real public `@LofiGirl` lookup: 10 rows initially at 1.12 seconds, 23 at 1.63
  seconds; one API discovery request and one channel-page request. Selecting a
  stream opened Standard chat and delivered five observed messages into the app.
  This was a short functional check, not another long soak or a completeness test.
- Staged PHP endpoints with isolated Memcached keys and fixture Google responses:
  uncached lookup succeeds with the old local counter at its limit; a repeated
  lookup makes zero outgoing calls; failed attempts are counted. These checks
  made no real Google requests.
- Live production HTTP checks returned the expected channel information,
  thumbnail and cached channel title. Production counters recorded real traffic.

## Post-deployment review

A live `channel_info` lookup for `xORCbIptqcc` had no combined response or video
details cached, but its channel mapping and channel details were already cached.
It made one `videos.list` call for video data absent from the endpoint's response.
The immediate repeat returned the same response with zero further API calls.

The cache-reuse follow-up removes that unnecessary call. The focused PHP check
fails against the first deployed version and passes against the follow-up: partial
cache reuse makes zero calls; an absent channel-details cache needs one channel
request; full-data callers still retrieve video details; combined-cache precedence
is preserved. These edge cases use isolated cache keys and fixture upstream data.

The follow-up was deployed at 15:23 UTC and the same checks passed against the
deployed files. Real production HTTP checks then returned matching channel details
on repeated requests, a valid thumbnail URL, and the cached channel title, with no
increase in the channel-details API counters during those cached requests. The
previous deployed helper and endpoint are backed up under
`/home/punkrawker/ssapp-youtube-20260929/before-channel-cache-reuse`.

Review consequence: removing the old pre-fetch limit from `channel_title.php`
allows uncached requests that it previously rejected. Counters provide visibility
into these PHP endpoints; they do not introduce abuse blocking or measure the
entire Google project's quota usage. Original cache lifetimes remain in effect.

The desktop changes are committed locally and require an app release to reach users.
