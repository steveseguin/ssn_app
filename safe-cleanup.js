// Safe cleanup utilities to prevent errors during shutdown
class SafeCleanup {
    constructor() {
        this.cleanupTasks = [];
        this.isCleaningUp = false;
    }

    register(name, cleanupFn) {
        this.cleanupTasks.push({ name, fn: cleanupFn });
    }

    async executeAll() {
        if (this.isCleaningUp) {
            console.log('Cleanup already in progress');
            return;
        }

        this.isCleaningUp = true;
        const results = [];

        for (const task of this.cleanupTasks) {
            try {
                console.log(`Executing cleanup: ${task.name}`);
                await Promise.race([
                    task.fn(),
                    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))
                ]);
                results.push({ name: task.name, status: 'success' });
            } catch (error) {
                console.error(`Cleanup failed for ${task.name}:`, error);
                results.push({ name: task.name, status: 'failed', error: error.message });
            }
        }

        this.isCleaningUp = false;
        return results;
    }

    // Safe interval clearing
    static clearInterval(interval) {
        if (interval) {
            try {
                clearInterval(interval);
                return true;
            } catch (e) {
                console.error('Error clearing interval:', e);
                return false;
            }
        }
        return false;
    }

    // Safe timeout clearing
    static clearTimeout(timeout) {
        if (timeout) {
            try {
                clearTimeout(timeout);
                return true;
            } catch (e) {
                console.error('Error clearing timeout:', e);
                return false;
            }
        }
        return false;
    }

    // Safe object cleanup
    static cleanupObject(obj, propertiesToClean = []) {
        if (!obj) return;

        for (const prop of propertiesToClean) {
            try {
                if (obj[prop]) {
                    // Clear intervals/timeouts
                    if (prop.includes('Interval')) {
                        this.clearInterval(obj[prop]);
                    } else if (prop.includes('Timeout')) {
                        this.clearTimeout(obj[prop]);
                    }
                    // Clear references
                    obj[prop] = null;
                }
            } catch (e) {
                console.error(`Error cleaning property ${prop}:`, e);
            }
        }
    }

    // Safe window/view cleanup
    static async cleanupWindow(window) {
        if (!window) return false;

        try {
            // Remove all listeners first
            if (window.removeAllListeners) {
                window.removeAllListeners();
            }

            // Clear any attached intervals/timeouts
            if (window.intervals) {
                for (const interval of window.intervals) {
                    this.clearInterval(interval);
                }
                window.intervals = [];
            }

            if (window.timeouts) {
                for (const timeout of window.timeouts) {
                    this.clearTimeout(timeout);
                }
                window.timeouts = [];
            }

            // Close if possible
            if (!window.isDestroyed && window.isDestroyed()) {
                return true;
            }

            if (window.close) {
                window.close();
            }

            // Wait a bit for close to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            // Destroy if still exists
            if (!window.isDestroyed || !window.isDestroyed()) {
                if (window.destroy) {
                    window.destroy();
                }
            }

            return true;
        } catch (e) {
            console.error('Error during window cleanup:', e);
            return false;
        }
    }
}

// Global cleanup manager
const globalCleanup = new SafeCleanup();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SafeCleanup, globalCleanup };
}