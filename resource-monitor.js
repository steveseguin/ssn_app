// Resource monitoring and limiting to prevent runaway resource usage
const os = require('os');

class ResourceMonitor {
    constructor() {
        this.limits = {
            maxMemoryMB: 2048, // 2GB default limit
            maxCpuPercent: 80,
            maxHandles: 10000,
            maxQueueSize: 100000
        };
        
        this.metrics = {
            memory: 0,
            cpu: 0,
            handles: 0,
            queues: new Map()
        };
        
        this.callbacks = {
            memoryWarning: null,
            cpuWarning: null,
            handleWarning: null
        };
        
        this.monitorInterval = null;
        this.startMonitoring();
    }

    startMonitoring() {
        this.monitorInterval = setInterval(() => {
            this.checkResources();
        }, 10000); // Check every 10 seconds
    }

    async checkResources() {
        try {
            // Check memory
            const memUsage = process.memoryUsage();
            const memMB = memUsage.heapUsed / 1024 / 1024;
            this.metrics.memory = memMB;
            
            if (memMB > this.limits.maxMemoryMB) {
                console.warn(`High memory usage: ${memMB.toFixed(0)}MB (limit: ${this.limits.maxMemoryMB}MB)`);
                this.triggerGarbageCollection();
                
                if (this.callbacks.memoryWarning) {
                    this.callbacks.memoryWarning(memMB);
                }
            }
            
            // Check CPU (simplified)
            const cpuUsage = process.cpuUsage();
            const totalCPU = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
            this.metrics.cpu = totalCPU;
            
            // Check handle count (file descriptors, sockets, etc)
            if (process._getActiveHandles) {
                const handles = process._getActiveHandles().length;
                this.metrics.handles = handles;
                
                if (handles > this.limits.maxHandles) {
                    console.warn(`High handle count: ${handles} (limit: ${this.limits.maxHandles})`);
                    if (this.callbacks.handleWarning) {
                        this.callbacks.handleWarning(handles);
                    }
                }
            }
            
            // Check queue sizes
            for (const [name, size] of this.metrics.queues.entries()) {
                if (size > this.limits.maxQueueSize) {
                    console.warn(`Queue "${name}" is too large: ${size} items`);
                }
            }
            
        } catch (e) {
            console.error('Error monitoring resources:', e);
        }
    }

    triggerGarbageCollection() {
        if (global.gc) {
            try {
                global.gc();
                console.log('Manual garbage collection triggered');
            } catch (e) {
                console.error('Error triggering garbage collection:', e);
            }
        }
    }

    registerQueue(name, getSize) {
        // Register a queue to monitor
        setInterval(() => {
            try {
                const size = getSize();
                this.metrics.queues.set(name, size);
            } catch (e) {
                this.metrics.queues.delete(name);
            }
        }, 5000);
    }

    setLimit(type, value) {
        if (type in this.limits) {
            this.limits[type] = value;
            console.log(`Resource limit set: ${type} = ${value}`);
        }
    }

    onMemoryWarning(callback) {
        this.callbacks.memoryWarning = callback;
    }

    onCpuWarning(callback) {
        this.callbacks.cpuWarning = callback;
    }

    onHandleWarning(callback) {
        this.callbacks.handleWarning = callback;
    }

    getMetrics() {
        return {
            ...this.metrics,
            limits: this.limits,
            system: {
                totalMemory: os.totalmem() / 1024 / 1024,
                freeMemory: os.freemem() / 1024 / 1024,
                cpuCount: os.cpus().length,
                uptime: process.uptime()
            }
        };
    }

    // Emergency cleanup when resources are critical
    emergencyCleanup() {
        console.warn('Emergency cleanup initiated due to high resource usage');
        
        // Clear caches
        if (global.messageCache) {
            global.messageCache.clear();
        }
        
        // Force garbage collection
        this.triggerGarbageCollection();
        
        // Clear large arrays/maps
        if (global.browserViews) {
            for (const id in global.browserViews) {
                const view = global.browserViews[id];
                if (view && view.isDestroyed && view.isDestroyed()) {
                    delete global.browserViews[id];
                }
            }
        }
        
        return true;
    }

    destroy() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }
}

// Create singleton instance
let resourceMonitor = null;

function getResourceMonitor() {
    if (!resourceMonitor) {
        resourceMonitor = new ResourceMonitor();
    }
    return resourceMonitor;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ResourceMonitor, getResourceMonitor };
}