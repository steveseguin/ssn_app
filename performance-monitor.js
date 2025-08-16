// Don't require electron here - use the exposed API from preload

class PerformanceMonitor {
    constructor() {
        this.container = null;
        this.updateInterval = null;
        this.detailsPanel = null;
        this.metrics = {
            cpu: 0,
            memory: 0,
            memoryPercent: 0,
            windows: []
        };
    }

    init() {
        this.createUI();
        this.startMonitoring();
        this.setupEventListeners();
    }

    createUI() {
        // Create main container
        this.container = document.createElement('div');
        this.container.id = 'performance-monitor';
        this.container.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            background: rgba(30, 30, 30, 0.95);
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            font-size: 12px;
            z-index: 10000;
            cursor: pointer;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
            min-width: 140px;
        `;

        // Create metrics display
        const metricsDisplay = document.createElement('div');
        metricsDisplay.style.cssText = `
            display: flex;
            gap: 15px;
            align-items: center;
        `;

        // CPU indicator
        const cpuDiv = document.createElement('div');
        cpuDiv.style.cssText = 'display: flex; align-items: center; gap: 5px;';
        cpuDiv.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                <rect x="9" y="9" width="6" height="6"></rect>
                <line x1="9" y1="1" x2="9" y2="4"></line>
                <line x1="15" y1="1" x2="15" y2="4"></line>
                <line x1="9" y1="20" x2="9" y2="23"></line>
                <line x1="15" y1="20" x2="15" y2="23"></line>
                <line x1="20" y1="9" x2="23" y2="9"></line>
                <line x1="20" y1="14" x2="23" y2="14"></line>
                <line x1="1" y1="9" x2="4" y2="9"></line>
                <line x1="1" y1="14" x2="4" y2="14"></line>
            </svg>
            <span id="cpu-value">0%</span>
        `;

        // Memory indicator
        const memDiv = document.createElement('div');
        memDiv.style.cssText = 'display: flex; align-items: center; gap: 5px;';
        memDiv.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="8" width="18" height="10" rx="2"></rect>
                <path d="M7 8V6a2 2 0 012-2h6a2 2 0 012 2v2"></path>
                <line x1="7" y1="12" x2="10" y2="12"></line>
                <line x1="14" y1="12" x2="17" y2="12"></line>
            </svg>
            <span id="mem-value">0 MB</span>
        `;

        metricsDisplay.appendChild(cpuDiv);
        metricsDisplay.appendChild(memDiv);
        this.container.appendChild(metricsDisplay);

        // Create details panel (hidden by default)
        this.detailsPanel = document.createElement('div');
        this.detailsPanel.id = 'performance-details';
        this.detailsPanel.style.cssText = `
            position: absolute;
            bottom: 100%;
            right: 0;
            background: rgba(30, 30, 30, 0.98);
            color: #fff;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 10px;
            display: none;
            min-width: 300px;
            max-width: 400px;
            max-height: 400px;
            overflow-y: auto;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        `;

        this.container.appendChild(this.detailsPanel);
        document.body.appendChild(this.container);
    }

    setupEventListeners() {
        // Toggle details on hover
        this.container.addEventListener('mouseenter', () => {
            this.showDetails();
        });

        this.container.addEventListener('mouseleave', () => {
            this.hideDetails();
        });

        // Listen for performance data from main process
        if (window.electronAPI && window.electronAPI.onPerformanceData) {
            window.electronAPI.onPerformanceData((data) => {
                this.updateMetrics(data);
            });
        }
    }

    startMonitoring() {
        // Request performance data every 2 seconds
        this.updateInterval = setInterval(async () => {
            try {
                if (window.electronAPI && window.electronAPI.requestPerformanceData) {
                    const data = await window.electronAPI.requestPerformanceData();
                    if (data) {
                        this.updateMetrics(data);
                    }
                }
            } catch (e) {
                console.error('Error fetching performance data:', e);
            }
        }, 2000);

        // Initial request
        setTimeout(async () => {
            try {
                if (window.electronAPI && window.electronAPI.requestPerformanceData) {
                    const data = await window.electronAPI.requestPerformanceData();
                    if (data) {
                        this.updateMetrics(data);
                    }
                }
            } catch (e) {
                console.error('Error fetching initial performance data:', e);
            }
        }, 500);
    }

    updateMetrics(data) {
        this.metrics = data;
        
        // Update main display
        const cpuValue = document.getElementById('cpu-value');
        const memValue = document.getElementById('mem-value');
        
        if (cpuValue) {
            cpuValue.textContent = `${data.cpu.toFixed(1)}%`;
            cpuValue.style.color = this.getColorForValue(data.cpu, 100);
        }
        
        if (memValue) {
            const memMB = (data.memory / 1024 / 1024).toFixed(0);
            memValue.textContent = `${memMB} MB`;
            memValue.style.color = this.getColorForValue(data.memoryPercent, 100);
        }

        // Update details if visible
        if (this.detailsPanel.style.display === 'block') {
            this.updateDetails();
        }
    }

    updateDetails() {
        let html = `
            <div style="margin-bottom: 12px; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
                Performance Details
            </div>
            <div style="margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span>CPU Usage:</span>
                    <span style="color: ${this.getColorForValue(this.metrics.cpu, 100)}">${this.metrics.cpu.toFixed(1)}%</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span>Memory:</span>
                    <span style="color: ${this.getColorForValue(this.metrics.memoryPercent, 100)}">${(this.metrics.memory / 1024 / 1024).toFixed(0)} MB (${this.metrics.memoryPercent.toFixed(1)}%)</span>
                </div>
            </div>
        `;

        if (this.metrics.windows && this.metrics.windows.length > 0) {
            html += `
                <div style="margin-top: 12px; font-size: 13px; font-weight: 600; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px;">
                    Windows & Tabs
                </div>
                <div style="margin-top: 8px; font-size: 11px;">
            `;

            this.metrics.windows.forEach(win => {
                const memMB = (win.memory / 1024 / 1024).toFixed(1);
                const cpuPercent = win.cpu.toFixed(1);
                const title = win.title || win.url || 'Untitled';
                const truncatedTitle = title.length > 40 ? title.substring(0, 40) + '...' : title;
                
                html += `
                    <div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 4px;">
                        <div style="margin-bottom: 2px; word-wrap: break-word;">${truncatedTitle}</div>
                        <div style="display: flex; gap: 10px; color: rgba(255,255,255,0.7);">
                            <span>CPU: ${cpuPercent}%</span>
                            <span>Mem: ${memMB} MB</span>
                        </div>
                    </div>
                `;
            });

            html += '</div>';
        }

        this.detailsPanel.innerHTML = html;
    }

    showDetails() {
        this.detailsPanel.style.display = 'block';
        this.updateDetails();
    }

    hideDetails() {
        this.detailsPanel.style.display = 'none';
    }

    getColorForValue(value, max) {
        const percent = (value / max) * 100;
        if (percent < 50) return '#4CAF50';
        if (percent < 75) return '#FFC107';
        return '#F44336';
    }

    destroy() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PerformanceMonitor;
}