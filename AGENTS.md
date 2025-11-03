# Suggested TODOs

- [ ] Guard the message pump timer in `tiktok/connection-manager.js` (`MessageProcessor.startProcessing`) so only one `setTimeout` is pending at a time; burst traffic currently stacks timers until the first tick runs.
- [ ] Rework the queue trimming branch in `MessageProcessor.addToQueue` to drop entries in bulk (e.g., `splice` with a larger stride) instead of repeated `shift`/`cache.remove` loops that become O(n²) at high volume.
- [ ] Keep TikTok debug logging on for dev builds but move the heavy lifting off the hot path: buffer message summaries or offload `normalizeForLogging`/disk writes to a worker before high-rate payloads start blocking the event loop.
- [ ] Update the batch forwarder so `sendBatchToBackground` and `logTikTokForwardedMessage` operate on the batch as a unit; avoid per-message logging/IPC work when the renderer already accepts arrays.
- [ ] Replace the 30 k entry `MessageCache` Map with a fixed-size ring buffer (or similar) that still protects against duplicate replays during reconnects. Any change must keep dedupe effective through polling reconnects, where TikTok historically resends old messages—verify we resume from the latest cursor instead of page 0 before trimming the cache aggressively.
- [ ] Audit reconnect/polling flows to confirm we are requesting new pages rather than restarting from the beginning; this is the suspected trigger for the “long pause → duplicate flood” reports.
