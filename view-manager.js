// Improved view manager with WeakRef support for better garbage collection
class ViewManager {
    constructor() {
        // Use WeakMap for views that can be garbage collected
        this.views = new Map();
        this.weakRefs = new WeakMap();
        this.cleanupInterval = null;
        this.startCleanup();
    }

    startCleanup() {
        // Periodic cleanup of destroyed views
        this.cleanupInterval = setInterval(() => {
            this.cleanupDestroyedViews();
        }, 30000); // Every 30 seconds
    }

    add(id, view) {
        if (!view) return false;
        
        // Store strong reference in Map
        this.views.set(id, view);
        
        // Also create WeakRef for tracking
        if (typeof WeakRef !== 'undefined') {
            this.weakRefs.set(view, new WeakRef(view));
        }
        
        return true;
    }

    get(id) {
        const view = this.views.get(id);
        if (view && !this.isDestroyed(view)) {
            return view;
        }
        
        // Clean up if destroyed
        if (view) {
            this.remove(id);
        }
        return null;
    }

    remove(id) {
        const view = this.views.get(id);
        if (view) {
            // Clean up any attached resources
            this.cleanupView(view);
            
            // Remove from maps
            this.views.delete(id);
            if (this.weakRefs.has(view)) {
                this.weakRefs.delete(view);
            }
        }
    }

    cleanupView(view) {
        if (!view) return;
        
        try {
            // Clean up intervals
            if (view.intervals) {
                view.intervals.forEach(interval => {
                    try {
                        clearInterval(interval);
                    } catch (e) {}
                });
                view.intervals = [];
            }
            
            // Clean up timeouts
            if (view.timeouts) {
                view.timeouts.forEach(timeout => {
                    try {
                        clearTimeout(timeout);
                    } catch (e) {}
                });
                view.timeouts = [];
            }
            
            // Remove event listeners if possible
            if (view.removeAllListeners) {
                view.removeAllListeners();
            }
            
            // Clear webContents handlers
            if (view.webContents && !view.webContents.isDestroyed()) {
                try {
                    view.webContents.removeAllListeners();
                } catch (e) {}
            }
        } catch (e) {
            console.error('Error cleaning up view:', e);
        }
    }

    isDestroyed(view) {
        if (!view) return true;
        
        try {
            if (view.isDestroyed) {
                return view.isDestroyed();
            }
            
            // Check webContents
            if (view.webContents) {
                return view.webContents.isDestroyed();
            }
            
            return false;
        } catch (e) {
            // If we can't check, assume destroyed
            return true;
        }
    }

    cleanupDestroyedViews() {
        let cleaned = 0;
        
        for (const [id, view] of this.views.entries()) {
            if (this.isDestroyed(view)) {
                this.remove(id);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`ViewManager: Cleaned up ${cleaned} destroyed views`);
        }
    }

    getAllViews() {
        const activeViews = {};
        
        for (const [id, view] of this.views.entries()) {
            if (!this.isDestroyed(view)) {
                activeViews[id] = view;
            }
        }
        
        return activeViews;
    }

    destroy() {
        // Clean up all views
        for (const [id, view] of this.views.entries()) {
            this.remove(id);
        }
        
        // Clear interval
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        
        // Clear maps
        this.views.clear();
        this.weakRefs = new WeakMap();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ViewManager;
}