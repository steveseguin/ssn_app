// IPC throttling to prevent flooding the main process
class IPCThrottle {
    constructor() {
        this.queues = new Map();
        this.timers = new Map();
        this.cache = new Map();
    }

    // Throttle IPC calls - only send after delay
    throttle(channel, data, delay = 100) {
        if (!this.queues.has(channel)) {
            this.queues.set(channel, []);
        }

        const queue = this.queues.get(channel);
        queue.push(data);

        // Clear existing timer
        if (this.timers.has(channel)) {
            clearTimeout(this.timers.get(channel));
        }

        // Set new timer
        const timer = setTimeout(() => {
            this.flush(channel);
        }, delay);

        this.timers.set(channel, timer);
    }

    // Debounce IPC calls - only keep last call
    debounce(channel, data, delay = 100) {
        // Clear existing timer
        if (this.timers.has(channel)) {
            clearTimeout(this.timers.get(channel));
        }

        // Set new timer with latest data
        const timer = setTimeout(() => {
            this.send(channel, data);
            this.timers.delete(channel);
        }, delay);

        this.timers.set(channel, timer);
    }

    // Cache IPC responses to avoid redundant calls
    async cachedInvoke(channel, data, ttl = 5000) {
        const cacheKey = `${channel}:${JSON.stringify(data)}`;
        
        // Check cache
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < ttl) {
                return cached.value;
            }
        }

        // Make actual IPC call
        const result = await this.invoke(channel, data);
        
        // Cache result
        this.cache.set(cacheKey, {
            value: result,
            timestamp: Date.now()
        });

        // Clean old cache entries
        this.cleanCache();

        return result;
    }

    flush(channel) {
        const queue = this.queues.get(channel);
        if (!queue || queue.length === 0) return;

        // Send batched data
        this.sendBatch(channel, queue);
        
        // Clear queue
        this.queues.set(channel, []);
        this.timers.delete(channel);
    }

    send(channel, data) {
        // Override this in actual implementation
        if (typeof window !== 'undefined' && window.electronAPI) {
            window.electronAPI.send(channel, data);
        }
    }

    sendBatch(channel, batch) {
        // Override this in actual implementation
        if (typeof window !== 'undefined' && window.electronAPI) {
            window.electronAPI.send(`${channel}-batch`, batch);
        }
    }

    async invoke(channel, data) {
        // Override this in actual implementation
        if (typeof window !== 'undefined' && window.electronAPI) {
            return await window.electronAPI.invoke(channel, data);
        }
        return null;
    }

    cleanCache() {
        const now = Date.now();
        const maxAge = 60000; // 1 minute max cache age

        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > maxAge) {
                this.cache.delete(key);
            }
        }
    }

    destroy() {
        // Clear all timers
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        
        // Clear all data
        this.queues.clear();
        this.timers.clear();
        this.cache.clear();
    }
}

// Singleton instance
let ipcThrottle = null;

function getIPCThrottle() {
    if (!ipcThrottle) {
        ipcThrottle = new IPCThrottle();
    }
    return ipcThrottle;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IPCThrottle, getIPCThrottle };
}