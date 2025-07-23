class BLEScanner {
    constructor() {
        this.eventSource = null;
        this.devices = new Map();
        this.isScanning = false;
        this.connectionStatus = 'disconnected';
        this.clientCount = 0;
        
        // DOM elements
        this.elements = {
            connectionIcon: document.getElementById('connectionIcon'),
            connectionStatus: document.getElementById('connectionStatus'),
            scanIcon: document.getElementById('scanIcon'),
            scanStatus: document.getElementById('scanStatus'),
            deviceCount: document.getElementById('deviceCount'),
            proxyMode: document.getElementById('proxyMode'),
            targetUUID: document.getElementById('targetUUID'),
            proxyPort: document.getElementById('proxyPort'),
            scanBtn: document.getElementById('scanBtn'),
            refreshBtn: document.getElementById('refreshBtn'),
            clearBtn: document.getElementById('clearBtn'),
            deviceList: document.getElementById('deviceList'),
            lastScanTime: document.getElementById('lastScanTime'),
            activityLog: document.getElementById('activityLog'),
            clearLogBtn: document.getElementById('clearLogBtn'),
            
            // Test elements
            testSection: document.getElementById('testSection'),
            testBtn: document.getElementById('testBtn'),
            testUrl: document.getElementById('testUrl'),
            testResults: document.getElementById('testResults'),
            testConnectionStatus: document.getElementById('connectionStatus'),
            responseStatus: document.getElementById('responseStatus'),
            responseTiming: document.getElementById('responseTiming'),
            responseBody: document.getElementById('responseBody'),
            responseHeaders: document.getElementById('responseHeaders'),
            headersContent: document.getElementById('headersContent'),
            
            // Direct proxy elements
            directProxyUrl: document.getElementById('directProxyUrl'),
            directProxyBtn: document.getElementById('directProxyBtn'),
            
            // BLE Log elements
            bleLogContainer: document.getElementById('bleLogContainer'),
            clearBleLogBtn: document.getElementById('clearBleLogBtn'),
            autoScrollLog: document.getElementById('autoScrollLog'),
            logLevelFilter: document.getElementById('logLevelFilter')
        };
        
        this.init();
        
        // Start auto-clearing stale devices every 10 seconds
        setInterval(() => this.clearStaleDevices(), 10000);
    }
    
    async init() {
        this.log('Initializing BLE Scanner interface...', 'info');
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Load initial status
        await this.loadStatus();
        
        // Setup real-time updates
        this.setupEventSource();
        
        this.log('BLE Scanner interface ready', 'success');
    }
    
    setupEventListeners() {
        this.elements.scanBtn.addEventListener('click', () => this.handleScan());
        this.elements.refreshBtn.addEventListener('click', () => this.loadStatus());
        this.elements.clearBtn.addEventListener('click', () => this.clearDevices());
        this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
        this.elements.testBtn.addEventListener('click', () => this.handleTest());
        this.elements.directProxyBtn.addEventListener('click', () => this.handleDirectProxy());
        this.elements.clearBleLogBtn.addEventListener('click', () => this.clearBleLog());
        this.elements.logLevelFilter.addEventListener('change', () => this.filterBleLog());
        
        // Example link handlers
        document.querySelectorAll('.example-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const url = e.target.dataset.url;
                this.openDirectProxy(url);
            });
        });
        
        // Enter key handler for direct proxy input
        this.elements.directProxyUrl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleDirectProxy();
            }
        });
    }
    
    setupEventSource() {
        if (this.eventSource) {
            this.eventSource.close();
        }
        
        this.eventSource = new EventSource('/events');
        
        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleRealtimeUpdate(data);
            } catch (error) {
                console.error('Error parsing event data:', error);
            }
        };
        
        this.eventSource.onerror = (error) => {
            console.error('EventSource error:', error);
            this.log('Connection to server lost, attempting to reconnect...', 'warning');
            
            // Retry connection after 3 seconds
            setTimeout(() => {
                this.setupEventSource();
            }, 3000);
        };
        
        this.eventSource.onopen = () => {
            this.log('Real-time connection established', 'success');
        };
    }
    
    handleRealtimeUpdate(data) {
        switch (data.type) {
            case 'connectionStatus':
                this.updateConnectionStatus(data.status, data.clientCount);
                break;
            case 'scanStatus':
                this.updateScanStatus(data.scanning);
                break;
            case 'deviceDiscovered':
                this.addDevice(data.device);
                break;
            case 'connected':
                this.log('Connected to BLE Scanner server', 'success');
                break;
            case 'bleLog':
                // Display BLE log messages in the on-screen log viewer
                this.addBleLog(data.message, data.level);
                break;
            default:
                console.log('Unknown event type:', data.type);
        }
    }
    
    async loadStatus() {
        try {
            const response = await fetch('/api/status');
            const status = await response.json();
            
            this.updateStatus(status);
            this.log('Status updated', 'info');
        } catch (error) {
            this.log(`Failed to load status: ${error.message}`, 'error');
        }
    }
    
    updateStatus(status) {
        // Update connection status
        this.updateConnectionStatus(status.connectionStatus);
        
        // Update scan status
        this.updateScanStatus(status.isScanning);
        
        // Update device count
        this.elements.deviceCount.textContent = status.deviceCount;
        
        // Update mode
        this.elements.proxyMode.textContent = status.mockMode ? 'Mock Mode' : 'BLE Mode';
        
        // Update configuration
        this.elements.targetUUID.textContent = status.config?.bleServiceUUID || 'Unknown';
        this.elements.proxyPort.textContent = status.config?.proxyPort || 'Unknown';
        
        // Log status
        this.log(`Proxy status: ${status.connectionStatus}, Mode: ${status.mockMode ? 'Mock' : 'BLE'}`, 'info');
    }
    
    updateConnectionStatus(status, clientCount = 0) {
        this.connectionStatus = status;
        this.clientCount = clientCount || 0;
        
        // Update UI elements
        this.elements.connectionStatus.textContent = this.formatStatus(status, this.clientCount);
        this.elements.connectionStatus.className = `status-value status-${status}`;
        
        // Update test section visibility
        this.updateTestSectionVisibility();
        
        // Handle button states based on connection status
        switch (status) {
            case 'connected':
                this.elements.connectionIcon.textContent = '🟢';
                this.setConnectButtonsDisabled(false);
                break;
            case 'connecting':
                this.elements.connectionIcon.textContent = '🟡';
                // Keep buttons disabled during connection
                break;
            case 'disconnected':
            default:
                this.elements.connectionIcon.textContent = '🔴';
                this.setConnectButtonsDisabled(false);
                break;
        }
    }
    
    updateScanStatus(scanning) {
        this.isScanning = scanning;
        
        // Update UI elements
        this.elements.scanStatus.textContent = scanning ? 'Scanning...' : 'Ready';
        this.elements.scanStatus.className = `status-value ${scanning ? 'status-scanning' : ''}`;
        
        // Update icon
        this.elements.scanIcon.textContent = scanning ? '📡' : '📱';
        
        // Update button
        this.elements.scanBtn.disabled = scanning;
        this.elements.scanBtn.innerHTML = scanning ? 
            '<span class="btn-icon">⏸️</span>Scanning...' : 
            '<span class="btn-icon">🔍</span>Start BLE Scan';
            
        if (scanning) {
            this.elements.lastScanTime.textContent = `Started: ${new Date().toLocaleTimeString()}`;
        }
    }
    
    formatStatus(status, clientCount = 0) {
        const formattedStatus = status.charAt(0).toUpperCase() + status.slice(1);
        
        // Add client count if there are connected clients
        if (clientCount > 0) {
            return `${formattedStatus} (${clientCount} client${clientCount === 1 ? '' : 's'})`;
        }
        
        return formattedStatus;
    }
    
    async handleScan() {
        if (this.isScanning) {
            this.log('Scan already in progress', 'warning');
            return;
        }
        
        try {
            this.log('Starting BLE scan...', 'info');
            
            const response = await fetch('/api/scan', {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.log('BLE scan started successfully', 'success');
                this.clearDevices();
            } else {
                this.log(`Failed to start scan: ${result.error}`, 'error');
            }
        } catch (error) {
            this.log(`Scan error: ${error.message}`, 'error');
        }
    }
    
    addDevice(device) {
        // Add timestamp for cache management
        device.lastSeen = Date.now();
        
        this.devices.set(device.id, device);
        this.renderDevices();
        this.updateDeviceCount();
        
        const logMessage = device.isPotentialProxy ? 
            `🎯 Potential BLE Proxy found: ${device.name}` :
            `📱 Device discovered: ${device.name}`;
            
        this.log(logMessage, device.isPotentialProxy ? 'success' : 'info');
    }
    
    renderDevices() {
        const deviceArray = Array.from(this.devices.values());
        
        if (deviceArray.length === 0) {
            this.elements.deviceList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📡</div>
                    <h3>No devices found yet</h3>
                    <p>Click "Start BLE Scan" to discover nearby Bluetooth devices</p>
                </div>
            `;
            return;
        }
        
        // Sort devices: potential proxies first, then by RSSI (signal strength)
        deviceArray.sort((a, b) => {
            if (a.isPotentialProxy && !b.isPotentialProxy) return -1;
            if (!a.isPotentialProxy && b.isPotentialProxy) return 1;
            return (b.rssi || -100) - (a.rssi || -100);
        });
        
        this.elements.deviceList.innerHTML = deviceArray.map(device => this.createDeviceCard(device)).join('');
        
        // Add event listeners to connect buttons
        this.elements.deviceList.querySelectorAll('.btn-connect').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const deviceId = e.target.dataset.deviceId;
                this.connectToDevice(deviceId);
            });
        });
    }
    
    createDeviceCard(device) {
        const cardClass = device.isPotentialProxy ? 'device-card potential-proxy' : 'device-card';
        const badge = device.isPotentialProxy ? 
            '<div class="device-badge potential">🎯 BLE Proxy Candidate</div>' : 
            '<div class="device-badge">Device</div>';
            
        const services = device.serviceUUIDs && device.serviceUUIDs.length > 0 ?
            `<div class="device-services">
                <div class="device-detail-label">Services:</div>
                ${device.serviceUUIDs.map(uuid => `<span class="service-uuid">${uuid}</span>`).join('')}
            </div>` : 
            `<div class="device-services">
                <div class="device-detail-label" style="opacity: 0.5;">No services detected</div>
            </div>`;
            
        const rssiBar = this.createRSSIBar(device.rssi);
        
        return `
            <div class="${cardClass}">
                <div class="device-header">
                    <div>
                        <div class="device-name">${device.name}</div>
                        <div class="device-address">${device.address || device.id}</div>
                    </div>
                    ${badge}
                </div>
                
                <div class="device-details">
                    <div class="device-detail">
                        <div class="device-detail-label">Signal Strength</div>
                        <div class="device-detail-value">${device.rssi ? `${device.rssi} dBm` : 'Unknown'} ${rssiBar}</div>
                    </div>
                    
                    <div class="device-detail">
                        <div class="device-detail-label">Last Seen</div>
                        <div class="device-detail-value">${new Date(device.lastSeen).toLocaleTimeString()}</div>
                    </div>
                </div>
                
                ${services}
                
                <div class="device-actions">
                    <button class="btn-connect device-connect-btn" data-device-id="${device.id}">
                        ${device.isPotentialProxy ? '🎯 Connect' : '🔗 Connect'}
                    </button>
                </div>
            </div>
        `;
    }
    
    createRSSIBar(rssi) {
        if (!rssi) return '<span style="opacity: 0.3">📶📶📶📶</span>';
        
        // RSSI typically ranges from -100 (weak) to -30 (strong)
        const strength = Math.max(0, Math.min(100, (rssi + 100) * 1.43)); // Convert to 0-100%
        const bars = Math.ceil(strength / 25); // Convert to 1-4 bars
        
        let barDisplay = '';
        for (let i = 1; i <= 4; i++) {
            barDisplay += i <= bars ? '📶' : '📶';
        }
        
        return `<span style="opacity: ${Math.max(0.3, strength / 100)}; display: inline-block; width: 4ch;">${barDisplay}</span>`;
    }
    
    async connectToDevice(deviceId) {
        // Prevent multiple simultaneous connections
        if (this.connectionStatus === 'connecting') {
            this.log('Connection already in progress, please wait...', 'warning');
            return;
        }
        
        const device = this.devices.get(deviceId);
        if (!device) {
            this.log(`Device ${deviceId} not found`, 'error');
            return;
        }
        
        // Update connection status immediately to prevent multiple attempts
        this.updateConnectionStatus('connecting');
        
        try {
            this.log(`Attempting to connect to ${device.name}...`, 'info');
            
            // Disable all connect buttons during connection attempt
            this.setConnectButtonsDisabled(true);
            
            const response = await fetch(`/api/connect?deviceId=${encodeURIComponent(deviceId)}`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.log(`Connection initiated to ${device.name}`, 'success');
            } else {
                this.log(`Failed to connect: ${result.error}`, 'error');
                // Reset connection status on failure
                this.updateConnectionStatus('disconnected');
                this.setConnectButtonsDisabled(false);
            }
        } catch (error) {
            this.log(`Connection error: ${error.message}`, 'error');
            // Reset connection status on error
            this.updateConnectionStatus('disconnected');
            this.setConnectButtonsDisabled(false);
        }
    }
    
    setConnectButtonsDisabled(disabled) {
        const connectButtons = document.querySelectorAll('.device-connect-btn');
        connectButtons.forEach(button => {
            button.disabled = disabled;
            if (disabled) {
                button.textContent = 'Connecting...';
                button.classList.add('btn-connecting');
            } else {
                button.textContent = 'Connect';
                button.classList.remove('btn-connecting');
            }
        });
    }
    
    clearDevices() {
        this.devices.clear();
        this.renderDevices();
        this.updateDeviceCount();
        this.log('Device list cleared - removed all cached devices', 'info');
        
        // Also notify server to clear its cache
        fetch('/api/clear-cache', { method: 'POST' })
            .then(response => response.json())
            .then(data => {
                this.log('Server cache cleared', 'success');
            })
            .catch(err => {
                this.log('Failed to clear server cache: ' + err.message, 'warning');
            });
    }
    
    // Auto-clear stale devices that haven't been seen recently
    clearStaleDevices() {
        const now = Date.now();
        const staleThreshold = 30000; // 30 seconds
        let removedCount = 0;
        
        for (const [deviceId, device] of this.devices.entries()) {
            if (now - device.lastSeen > staleThreshold) {
                this.devices.delete(deviceId);
                removedCount++;
            }
        }
        
        if (removedCount > 0) {
            this.renderDevices();
            this.updateDeviceCount();
            this.log(`Auto-cleared ${removedCount} stale device(s)`, 'info');
        }
    }
    
    updateDeviceCount() {
        this.elements.deviceCount.textContent = this.devices.size;
    }
    
    log(message, level = 'info') {
        const now = new Date();
        const time = now.toLocaleTimeString();
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${level}`;
        logEntry.innerHTML = `
            <span class="log-time">[${time}]</span>
            <span class="log-message">${message}</span>
        `;
        
        this.elements.activityLog.appendChild(logEntry);
        
        // Auto-scroll to bottom
        this.elements.activityLog.scrollTop = this.elements.activityLog.scrollHeight;
        
        // Keep only last 50 entries
        const entries = this.elements.activityLog.querySelectorAll('.log-entry');
        if (entries.length > 50) {
            entries[0].remove();
        }
        
        // Also log to console
        console.log(`[${time}] ${message}`);
    }
    
    clearLog() {
        this.elements.activityLog.innerHTML = '';
        this.log('Activity log cleared', 'info');
    }
    
    destroy() {
        if (this.eventSource) {
            this.eventSource.close();
        }
    }
    
    async handleTest() {
        const url = this.elements.testUrl.value.trim();
        if (!url) {
            this.log('Please enter a URL to test', 'error');
            return;
        }
        
        // Validate URL
        try {
            new URL(url);
        } catch (e) {
            this.log('Please enter a valid URL', 'error');
            return;
        }
        
        // Check if connected
        if (this.connectionStatus !== 'connected') {
            this.log('Not connected to BLE device. Please connect first.', 'error');
            return;
        }
        
        this.log(`Testing request to: ${url}`, 'info');
        
        // Disable test button and show loading
        this.elements.testBtn.disabled = true;
        this.elements.testBtn.innerHTML = '<span class="btn-icon">⏳</span>Testing...';
        
        try {
            // Get selected method
            const method = document.querySelector('input[name="method"]:checked').value;
            const followRedirects = document.getElementById('followRedirects').checked;
            
            const startTime = Date.now();
            
            // Make request through proxy
            const response = await fetch('/api/test-request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    url: url,
                    method: method,
                    followRedirects: followRedirects
                })
            });
            
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            const result = await response.json();
            
            this.displayTestResult(result, duration);
            this.log(`Test completed in ${duration}ms`, 'success');
            
        } catch (error) {
            console.error('Test error:', error);
            this.log(`Test failed: ${error.message}`, 'error');
            this.displayTestError(error);
        } finally {
            // Re-enable test button
            this.elements.testBtn.disabled = false;
            this.elements.testBtn.innerHTML = '<span class="btn-icon">🚀</span>Test Request';
        }
    }
    
    displayTestResult(result, duration) {
        // Show results section
        this.elements.testResults.style.display = 'block';
        
        // Update status badge
        const status = result.status || 0;
        const statusClass = status >= 200 && status < 300 ? 'success' : 
                           status >= 400 ? 'error' : 'warning';
        
        this.elements.responseStatus.className = `status-badge ${statusClass}`;
        this.elements.responseStatus.textContent = `${status} ${result.statusText || ''}`;
        
        // Update timing
        this.elements.responseTiming.textContent = `${duration}ms`;
        
        // Update headers if available
        if (result.headers && Object.keys(result.headers).length > 0) {
            this.elements.responseHeaders.style.display = 'block';
            this.elements.headersContent.textContent = JSON.stringify(result.headers, null, 2);
        } else {
            this.elements.responseHeaders.style.display = 'none';
        }
        
        // Update body
        let bodyText = '';
        if (result.data) {
            if (typeof result.data === 'object') {
                bodyText = JSON.stringify(result.data, null, 2);
            } else {
                bodyText = result.data.toString();
            }
        } else if (result.error) {
            bodyText = result.error;
        }
        
        this.elements.responseBody.textContent = bodyText || 'No response body';
    }
    
    displayTestError(error) {
        // Show results section
        this.elements.testResults.style.display = 'block';
        
        // Update status badge
        this.elements.responseStatus.className = 'status-badge error';
        this.elements.responseStatus.textContent = 'ERROR';
        
        // Update timing
        this.elements.responseTiming.textContent = '';
        
        // Hide headers
        this.elements.responseHeaders.style.display = 'none';
        
        // Update body with error
        this.elements.responseBody.textContent = error.message || 'Unknown error occurred';
    }
    
    updateTestSectionVisibility() {
        // Show test section only when connected
        if (this.connectionStatus === 'connected') {
            this.elements.testSection.style.display = 'block';
            this.elements.testBtn.disabled = false;
            
            // Update connection status indicator
            const statusDot = this.elements.testConnectionStatus.querySelector('.status-dot');
            const statusText = this.elements.testConnectionStatus.querySelector('span:last-child');
            
            if (statusDot && statusText) {
                statusDot.className = 'status-dot connected';
                statusText.textContent = 'Connected to BLE Proxy';
            }
        } else {
            this.elements.testSection.style.display = 'none';
            this.elements.testBtn.disabled = true;
            
            // Update connection status indicator
            const statusDot = this.elements.testConnectionStatus.querySelector('.status-dot');
            const statusText = this.elements.testConnectionStatus.querySelector('span:last-child');
            
            if (statusDot && statusText) {
                statusDot.className = 'status-dot disconnected';
                statusText.textContent = 'Not Connected';
            }
        }
    }
    
    handleDirectProxy() {
        const url = this.elements.directProxyUrl.value.trim();
        if (!url) {
            this.log('Please enter a URL', 'warning');
            return;
        }
        
        this.openDirectProxy(url);
    }
    
    openDirectProxy(url) {
        // Clean up the URL
        let cleanUrl = url.trim();
        if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
            // Don't add protocol here, let the proxy decide
        }
        
        // Construct the proxy URL
        const proxyUrl = `http://localhost:8080/proxy/${encodeURIComponent(cleanUrl)}`;
        
        this.log(`Opening ${cleanUrl} through BLE proxy`, 'info');
        
        // Open in a new tab/window
        window.open(proxyUrl, '_blank');
        
        // Clear the input
        this.elements.directProxyUrl.value = '';
    }
    
    // BLE Log methods
    addBleLog(message, type = 'info') {
        if (!this.elements.bleLogContainer) return;
        
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `
            <span class="log-timestamp">[${timestamp}]</span>
            <span class="log-message">${this.escapeHtml(message)}</span>
        `;
        
        this.elements.bleLogContainer.appendChild(logEntry);
        
        // Auto scroll if enabled
        if (this.elements.autoScrollLog && this.elements.autoScrollLog.checked) {
            this.elements.bleLogContainer.scrollTop = this.elements.bleLogContainer.scrollHeight;
        }
        
        // Filter new entry
        this.filterBleLogEntry(logEntry);
        
        // Limit log entries to prevent memory issues
        const entries = this.elements.bleLogContainer.querySelectorAll('.log-entry');
        if (entries.length > 500) {
            entries[0].remove();
        }
    }
    
    clearBleLog() {
        if (!this.elements.bleLogContainer) return;
        
        this.elements.bleLogContainer.innerHTML = `
            <div class="log-entry info">
                <span class="log-timestamp">[${new Date().toLocaleTimeString()}]</span>
                <span class="log-message">BLE Debug Log cleared</span>
            </div>
        `;
    }
    
    filterBleLog() {
        if (!this.elements.logLevelFilter || !this.elements.bleLogContainer) return;
        
        const selectedLevel = this.elements.logLevelFilter.value;
        const entries = this.elements.bleLogContainer.querySelectorAll('.log-entry');
        
        entries.forEach(entry => {
            this.filterBleLogEntry(entry, selectedLevel);
        });
    }
    
    filterBleLogEntry(entry, level = null) {
        if (!level) {
            level = this.elements.logLevelFilter ? this.elements.logLevelFilter.value : 'all';
        }
        
        if (level === 'all') {
            entry.classList.remove('hidden');
        } else {
            if (entry.classList.contains(level)) {
                entry.classList.remove('hidden');
            } else {
                entry.classList.add('hidden');
            }
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Enhanced log method that logs to both activity log and BLE log
    log(message, type = 'info') {
        // Add to activity log (existing functionality)
        if (this.elements.activityLog) {
            const timestamp = new Date().toLocaleTimeString();
            const logEntry = document.createElement('div');
            logEntry.className = `activity-entry ${type}`;
            logEntry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${this.escapeHtml(message)}`;
            this.elements.activityLog.appendChild(logEntry);
            this.elements.activityLog.scrollTop = this.elements.activityLog.scrollHeight;
        }
        
        // Add to BLE log (new functionality)
        this.addBleLog(message, type);
        
        // Also log to console for debugging
        console.log(`[BLE] ${message}`);
    }
}

// Auto-detect theme based on system preference
function detectTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.body.classList.add('dark-theme');
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    detectTheme();
    
    // Global error handler
    window.addEventListener('error', (event) => {
        console.error('Global error:', event.error);
    });
    
    // Create and start the BLE Scanner
    window.bleScanner = new BLEScanner();
    
    // Handle page unload
    window.addEventListener('beforeunload', () => {
        if (window.bleScanner) {
            window.bleScanner.destroy();
        }
    });
});

// Utility functions for debugging
window.debugUtils = {
    getDevices: () => window.bleScanner?.devices,
    clearDevices: () => window.bleScanner?.clearDevices(),
    getStatus: () => ({
        isScanning: window.bleScanner?.isScanning,
        connectionStatus: window.bleScanner?.connectionStatus,
        deviceCount: window.bleScanner?.devices?.size
    }),
    forceRefresh: () => window.bleScanner?.loadStatus()
}; 