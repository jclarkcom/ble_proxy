const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const chalk = require('chalk');
const config = require('./config');
const { killProcessOnPort } = require('./kill-port');

// Choose BLE client based on mock mode
const isMockMode = process.env.MOCK_MODE === 'true';
const BLEClient = isMockMode ? require('./mock-ble-client') : require('./ble-client');

class BLEProxy {
  constructor(overrideConfig = {}) {
    // Merge config with overrides
    this.config = {
      ...config,
      ...overrideConfig
    };
    
    // Add web interface config
    this.config.webInterface = {
      port: this.config.webInterface?.port || 8081,
      host: this.config.webInterface?.host || '127.0.0.1',
      enabled: this.config.webInterface?.enabled !== false,
      ...this.config.webInterface
    };
    
    // Create BLE config from main config
    const bleConfig = {
      bleServiceUUID: this.config.ble.serviceUUID,
      requestCharUUID: this.config.ble.requestCharUUID, 
      responseCharUUID: this.config.ble.responseCharUUID,
      controlCharUUID: this.config.ble.controlCharUUID,
      ...this.config.ble
    };
    
    this.bleClient = new BLEClient(bleConfig);
    this.pendingRequests = new Map(); // Track requests by ID
    this.server = null;
    this.webServer = null;
    this.isRunning = false;
    this.requestTimeouts = new Map(); // Track request timeouts
    
    // Web interface state
    this.webClients = new Set(); // Track Server-Sent Events clients
    this.scanResults = new Map(); // Track BLE scan results
    this.isScanning = false;
    this.connectionStatus = 'disconnected';
    
    this.setupBLEHandlers();
    this.setupCleanupTimer();
  }

  setupBLEHandlers() {
    // Handle responses from iOS device
    this.bleClient.on('response', (data) => {
      this.handleBLEResponse(data);
    });
    
    this.bleClient.on('connected', () => {
      console.log(chalk.green('✓ Connected to iOS BLE device'));
      this.connectionStatus = 'connected';
      this.broadcastToWebClients({ type: 'connectionStatus', status: 'connected', clientCount: this.webClients.size });
    });
    
    this.bleClient.on('disconnected', () => {
      console.log(chalk.yellow('⚠ Disconnected from iOS BLE device'));
      this.connectionStatus = 'disconnected';
      this.broadcastToWebClients({ type: 'connectionStatus', status: 'disconnected', clientCount: this.webClients.size });
      this.clearAllPendingRequests('BLE device disconnected');
    });
    
    // Add scan result handlers if BLE client supports them
    if (this.bleClient.on) {
      this.bleClient.on('deviceDiscovered', (device) => {
        this.handleDeviceDiscovered(device);
      });
      
      this.bleClient.on('scanStart', () => {
        this.isScanning = true;
        this.broadcastToWebClients({ type: 'scanStatus', scanning: true });
      });
      
      this.bleClient.on('scanStop', () => {
        this.isScanning = false;
        this.broadcastToWebClients({ type: 'scanStatus', scanning: false });
      });
      
      // Listen for BLE log events and broadcast to web clients
      this.bleClient.on('log', (logData) => {
        this.broadcastBleLog(logData.message, logData.level);
      });
    }
  }

  handleDeviceDiscovered(device) {
    const deviceId = device.address || device.id || device.uuid;
    
    // Check if this could be our BLE proxy
    const isPotentialProxy = this.checkIfPotentialBLEProxy(device);
    
    const deviceInfo = {
      id: deviceId,
      name: device.name || device.localName || 'Unknown Device',
      address: device.address,
      rssi: device.rssi,
      serviceUUIDs: device.advertisement?.serviceUUIDs || [],
      manufacturerData: device.advertisement?.manufacturerData,
      isPotentialProxy,
      lastSeen: new Date().toISOString()
    };
    
    this.scanResults.set(deviceId, deviceInfo);
    
    // Broadcast to web clients
    this.broadcastToWebClients({ 
      type: 'deviceDiscovered', 
      device: deviceInfo 
    });
    
    if (isPotentialProxy) {
      // console.log(chalk.green(`🎯 Potential BLE Proxy found: ${deviceInfo.name} (${deviceInfo.address})`));
    }
  }

  checkIfPotentialBLEProxy(device) {
    const serviceUUIDs = device.advertisement?.serviceUUIDs || [];
    const targetServiceUUID = this.config.ble.serviceUUID.toLowerCase();
    
    // Check if device advertises our service UUID
    const hasMatchingService = serviceUUIDs.some(uuid => 
      uuid.toLowerCase() === targetServiceUUID ||
      uuid.toLowerCase().replace(/-/g, '') === targetServiceUUID.replace(/-/g, '')
    );
    
    // Check name patterns (iOS might advertise with app name)
    const name = (device.name || device.localName || '').toLowerCase();
    const nameMatches = name.includes('bleproxy') || 
                       name.includes('ble') && name.includes('proxy');
    
    return hasMatchingService || nameMatches;
  }

  broadcastToWebClients(message) {
    const data = JSON.stringify(message);
    for (const client of this.webClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (error) {
        // Remove dead clients
        this.webClients.delete(client);
      }
    }
  }

  async startWebInterface() {
    // Create web server
    this.webServer = http.createServer();
    this.webServer.on('request', this.handleWebRequest.bind(this));
    
    // Start listening
    await new Promise((resolve, reject) => {
      this.webServer.listen(this.config.webInterface.port, this.config.webInterface.host, (err) => {
        if (err) {
          if (err.code === 'EADDRINUSE') {
            console.error(chalk.red(`❌ Web interface port ${this.config.webInterface.port} is already in use!`));
            console.error(chalk.yellow(`💡 Try running with --kill-ports to automatically kill conflicting processes:`));
            console.error(chalk.gray(`   node proxy.js --kill-ports`));
            console.error(chalk.yellow(`💡 Or manually kill the process using port ${this.config.webInterface.port}:`));
            console.error(chalk.gray(`   node kill-port.js ${this.config.webInterface.port}`));
          }
          reject(err);
        } else {
          resolve();
        }
      });
    });
    
    console.log(chalk.green(`✓ Web interface listening on http://${this.config.webInterface.host}:${this.config.webInterface.port}`));
    console.log(chalk.cyan(`📊 Open web interface: http://${this.config.webInterface.host}:${this.config.webInterface.port}`));
  }

  handleWebRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // API endpoints
    if (pathname.startsWith('/api/')) {
      this.handleAPIRequest(req, res, pathname, parsedUrl.query);
      return;
    }
    
    // Server-Sent Events for real-time updates
    if (pathname === '/events') {
      this.handleSSE(req, res);
      return;
    }
    
    // Serve static files
    this.serveStaticFile(req, res, pathname);
  }

  handleAPIRequest(req, res, pathname, query) {
    res.setHeader('Content-Type', 'application/json');
    
    switch (pathname) {
      case '/api/status':
        this.handleStatusAPI(req, res);
        break;
        
      case '/api/scan':
        this.handleScanAPI(req, res, query);
        break;
        
      case '/api/devices':
        this.handleDevicesAPI(req, res);
        break;
        
      case '/api/connect':
        this.handleConnectAPI(req, res, query);
        break;
        
      case '/api/test-request':
        this.handleTestRequestAPI(req, res);
        break;
        
      case '/api/clear-cache':
        this.handleClearCacheAPI(req, res);
        break;
        
      default:
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'API endpoint not found' }));
    }
  }

  handleStatusAPI(req, res) {
    const status = {
      connectionStatus: this.connectionStatus,
      isScanning: this.isScanning,
      mockMode: isMockMode,
      proxyPort: this.config.proxy.port,
      deviceCount: this.scanResults.size,
      pendingRequests: this.pendingRequests.size,
      uptime: process.uptime(),
      config: {
        bleServiceUUID: this.config.ble.serviceUUID,
        proxyHost: this.config.proxy.host,
        proxyPort: this.config.proxy.port
      }
    };
    
    res.writeHead(200);
    res.end(JSON.stringify(status, null, 2));
  }

  handleScanAPI(req, res, query) {
    if (req.method === 'POST') {
      // Start scan
      this.startBLEScan()
        .then(() => {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Scan started' }));
        })
        .catch(error => {
          res.writeHead(500);
          res.end(JSON.stringify({ success: false, error: error.message }));
        });
    } else {
      // Get scan status
      res.writeHead(200);
      res.end(JSON.stringify({ 
        isScanning: this.isScanning,
        deviceCount: this.scanResults.size 
      }));
    }
  }

  handleDevicesAPI(req, res) {
    const devices = Array.from(this.scanResults.values());
    res.writeHead(200);
    res.end(JSON.stringify({ devices }, null, 2));
  }

  handleConnectAPI(req, res, query) {
    console.log(chalk.blue(`🔗 Connection request for device: ${query.deviceId}`));
    
    if (!query.deviceId) {
      console.log(chalk.red('❌ No deviceId provided'));
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'deviceId parameter required' }));
      return;
    }
    
    const device = this.scanResults.get(query.deviceId);
    if (!device) {
      console.log(chalk.red(`❌ Device ${query.deviceId} not found in scan results`));
      console.log(chalk.gray(`Available devices: ${Array.from(this.scanResults.keys()).join(', ')}`));
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Device not found in scan results' }));
      return;
    }
    
    console.log(chalk.blue(`✓ Device found: ${device.name}, attempting connection...`));
    
    // Attempt to connect to the device
    this.connectToDevice(query.deviceId)
      .then(() => {
        console.log(chalk.green(`✅ Connection initiated to ${device.name}`));
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Connection initiated' }));
      })
      .catch(error => {
        console.log(chalk.red(`❌ Connection failed: ${error.message}`));
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      });
  }

  handleClearCacheAPI(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    
    try {
      // Clear server-side device cache
      const devicesCleared = this.scanResults.size;
      this.scanResults.clear();
      
      // Reset BLE client if available
      if (this.bleClient && typeof this.bleClient.clearCache === 'function') {
        this.bleClient.clearCache();
      }
      
      console.log(chalk.blue('🧹 Server cache cleared by user request'));
      
      res.writeHead(200);
      res.end(JSON.stringify({ 
        success: true, 
        message: 'Server cache cleared successfully',
        devicesCleared: devicesCleared
      }));
      
      // Broadcast cache clear event to all web clients
      this.broadcastToWebClients({ 
        type: 'cacheCleared', 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error(chalk.red('❌ Error clearing cache:', error));
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to clear cache' }));
    }
  }

  async handleTestRequestAPI(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Check if connected to BLE device
    if (!this.bleClient.isConnected()) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Not connected to BLE device' }));
      return;
    }

    try {
      // Parse request body
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      await new Promise(resolve => {
        req.on('end', resolve);
      });

      const testRequest = JSON.parse(body);
      const { url, method = 'GET', followRedirects = true } = testRequest;

      if (!url) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'URL is required' }));
        return;
      }

      console.log(chalk.blue(`🧪 Testing ${method} request to: ${url}`));
      const startTime = Date.now();

      // Make the request through the BLE proxy by using our own sendRequest method
      const requestId = 'test-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      const bodyData = method === 'POST' ? JSON.stringify({ test: true }) : '';
      const bodyBase64 = bodyData ? Buffer.from(bodyData, 'utf8').toString('base64') : '';
      
      const requestData = {
        id: requestId,
        method: method,
        url: url,
        headers: {
          'User-Agent': 'BLE-Proxy-Test/1.0',
          'Accept': '*/*'
        },
        body: bodyBase64,
        isConnect: false
      };

      try {
        // Check if BLE client is connected
        if (!this.bleClient.connected) {
          throw new Error('BLE client is not connected to iOS device');
        }

        const response = await this.bleClient.sendRequest(JSON.stringify(requestData));
        const endTime = Date.now();
        const duration = endTime - startTime;

        console.log(chalk.green(`✅ Test request completed in ${duration}ms`));

        // Parse response
        let responseData;
        try {
          responseData = JSON.parse(response);
        } catch (e) {
          responseData = { data: response };
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          status: responseData.status || 200,
          statusText: responseData.statusText || 'OK',
          headers: responseData.headers || {},
          data: responseData.data || responseData,
          duration: duration
        }));

      } catch (proxyError) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        console.log(chalk.red(`❌ Test request failed: ${proxyError.message}`));

        res.writeHead(200); // Still return 200 but with error in response
        res.end(JSON.stringify({
          status: 0,
          statusText: 'Proxy Error',
          headers: {},
          error: proxyError.message,
          duration: duration
        }));
      }

    } catch (error) {
      console.error(chalk.red('Test request API error:'), error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  handleSSE(req, res) {
    // Set up Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Send initial connection message
    res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');
    
    // Add client to broadcast list
    this.webClients.add(res);
    
    // Broadcast updated client count to all clients (including new one)
    this.broadcastToWebClients({ 
      type: 'connectionStatus', 
      status: this.connectionStatus,
      clientCount: this.webClients.size
    });
    
    // Send current status
    res.write('data: ' + JSON.stringify({ 
      type: 'connectionStatus', 
      status: this.connectionStatus,
      clientCount: this.webClients.size
    }) + '\n\n');
    
    res.write('data: ' + JSON.stringify({ 
      type: 'scanStatus', 
      scanning: this.isScanning 
    }) + '\n\n');
    
    // Clean up when client disconnects
    req.on('close', () => {
      this.webClients.delete(res);
      // Broadcast updated client count to remaining clients
      this.broadcastToWebClients({ 
        type: 'connectionStatus', 
        status: this.connectionStatus,
        clientCount: this.webClients.size
      });
    });
  }
  
  // Broadcast BLE log messages to all connected web clients
  broadcastBleLog(message, type = 'info') {
    const logData = {
      type: 'bleLog',
      message: message,
      level: type,
      timestamp: new Date().toISOString()
    };
    
    const eventData = 'data: ' + JSON.stringify(logData) + '\n\n';
    
    // Send to all connected clients
    for (const client of this.webClients) {
      try {
        client.write(eventData);
      } catch (error) {
        // Remove client if write fails
        this.webClients.delete(client);
      }
    }
  }

  serveStaticFile(req, res, pathname) {
    // Default to index.html
    if (pathname === '/') {
      pathname = '/index.html';
    }
    
    const filePath = path.join(__dirname, 'web', pathname.substring(1));
    const ext = path.extname(filePath).toLowerCase();
    
    // Content type mapping
    const contentTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.ico': 'image/x-icon'
    };
    
    const contentType = contentTypes[ext] || 'text/plain';
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('File not found');
        } else {
          res.writeHead(500);
          res.end('Server error');
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  }

  async startBLEScan() {
    if (this.bleClient.startScan) {
      this.scanResults.clear();
      return this.bleClient.startScan();
    } else {
      throw new Error('BLE scanning not supported in this mode');
    }
  }

  async connectToDevice(deviceId) {
    if (this.bleClient.connectToDevice) {
      return this.bleClient.connectToDevice(deviceId);
    } else {
      throw new Error('Device connection not supported in this mode');
    }
  }

  setupCleanupTimer() {
    // Clean up timed out requests every 30 seconds
    this.cleanupTimer = setInterval(() => {
      this.cleanupTimedOutRequests();
    }, 30000);
  }

  cleanupTimedOutRequests() {
    const now = Date.now();
    const timeout = this.config.proxy.timeout;
    
    for (const [requestId, requestData] of this.pendingRequests.entries()) {
      if (now - requestData.timestamp > timeout) {
        console.warn(chalk.yellow(`Request ${requestId} timed out`));
        
        // Send timeout response
        if (requestData.res && !requestData.res.headersSent) {
          requestData.res.writeHead(408, { 'Content-Type': 'text/plain' });
          requestData.res.end('Request timeout');
        } else if (requestData.socket) {
          requestData.socket.write('HTTP/1.1 408 Request Timeout\r\n\r\n');
          requestData.socket.end();
        }
        
        // Clean up
        this.pendingRequests.delete(requestId);
        if (this.requestTimeouts.has(requestId)) {
          clearTimeout(this.requestTimeouts.get(requestId));
          this.requestTimeouts.delete(requestId);
        }
      }
    }
  }

  clearAllPendingRequests(reason) {
    for (const [requestId, requestData] of this.pendingRequests.entries()) {
      if (requestData.res && !requestData.res.headersSent) {
        requestData.res.writeHead(503, { 'Content-Type': 'text/plain' });
        requestData.res.end(`Service unavailable: ${reason}`);
      } else if (requestData.socket) {
        requestData.socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        requestData.socket.end();
      }
      
      if (this.requestTimeouts.has(requestId)) {
        clearTimeout(this.requestTimeouts.get(requestId));
        this.requestTimeouts.delete(requestId);
      }
    }
    
    this.pendingRequests.clear();
  }

  async start(options = {}) {
    try {
      console.log(chalk.blue('Starting BLE Proxy...'));
      
      if (isMockMode) {
        console.log(chalk.yellow('🧪 Running in MOCK MODE - using TCP sockets instead of BLE'));
        console.log(chalk.gray('Make sure the mock iOS service is running on port 9999'));
      } else {
        console.log(chalk.blue('📡 Running in BLE MODE - will scan for real iOS device'));
      }
      
      // Check and optionally kill processes using our ports
      const autoKill = options.killPorts || process.argv.includes('--kill-ports');
      
      // Check proxy port
      await killProcessOnPort(this.config.proxy.port, autoKill);
      
      // Check web interface port if enabled
      if (this.config.webInterface.enabled) {
        await killProcessOnPort(this.config.webInterface.port, autoKill);
      }
      
      // Start BLE client
      await this.bleClient.initialize();
      console.log(chalk.green(`✓ ${isMockMode ? 'Mock BLE' : 'BLE'} client initialized`));
      
      // Create HTTP proxy server
      this.server = http.createServer();
      this.server.on('request', this.handleHTTPRequest.bind(this));
      this.server.on('connect', this.handleHTTPSConnect.bind(this));
      
      // Start listening
      await new Promise((resolve, reject) => {
        this.server.listen(this.config.proxy.port, this.config.proxy.host, (err) => {
          if (err) {
            if (err.code === 'EADDRINUSE') {
              console.error(chalk.red(`❌ Port ${this.config.proxy.port} is already in use!`));
              console.error(chalk.yellow(`💡 Try running with --kill-ports to automatically kill conflicting processes:`));
              console.error(chalk.gray(`   node proxy.js --kill-ports`));
              console.error(chalk.yellow(`💡 Or manually kill the process using port ${this.config.proxy.port}:`));
              console.error(chalk.gray(`   node kill-port.js ${this.config.proxy.port}`));
            }
            reject(err);
          } else {
            resolve();
          }
        });
      });
      
      // Start web interface server if enabled
      if (this.config.webInterface.enabled) {
        await this.startWebInterface();
      }
      
      this.isRunning = true;
      console.log(chalk.green(`✓ Proxy server listening on ${this.config.proxy.host}:${this.config.proxy.port}`));
      console.log(chalk.yellow('Configure your browser to use this proxy:'));
      console.log(chalk.yellow(`  HTTP Proxy: ${this.config.proxy.host}:${this.config.proxy.port}`));
      console.log(chalk.gray(`  Max concurrent requests: ${this.config.proxy.maxConcurrentRequests}`));
      console.log(chalk.gray(`  Request timeout: ${this.config.proxy.timeout}ms`));
      
    } catch (error) {
      console.error(chalk.red('Failed to start proxy:'), error.message);
      throw error;
    }
  }

  async stop() {
    this.isRunning = false;
    
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    // Clear all pending requests
    this.clearAllPendingRequests('Proxy shutting down');
    
    // Close web interface connections
    for (const client of this.webClients) {
      try {
        client.end();
      } catch (error) {
        // Ignore errors when closing connections
      }
    }
    this.webClients.clear();
    
    // Close web server
    if (this.webServer) {
      await new Promise((resolve) => {
        this.webServer.close(resolve);
      });
    }
    
    // Close proxy server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    // Disconnect BLE client
    await this.bleClient.disconnect();
    console.log(chalk.green('✓ Proxy stopped'));
  }

  handleHTTPRequest(req, res) {
    console.log(chalk.cyan(`HTTP ${req.method} ${req.url}`));
    
    // Parse the URL to check for direct proxy requests
    const parsedUrl = url.parse(req.url, true);
    
    // Handle direct proxy URL requests (e.g., /proxy/google.com)
    if (parsedUrl.pathname.startsWith('/proxy/')) {
      return this.handleDirectProxy(req, res, parsedUrl);
    }
    
    if (!this.bleClient.isConnected()) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('BLE device not connected');
      return;
    }

    this.proxyHTTPRequest(req, res);
  }

  handleHTTPSConnect(req, clientSocket, head) {
    console.log(chalk.cyan(`HTTPS CONNECT ${req.url}`));
    
    if (!this.bleClient.isConnected()) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      clientSocket.end();
      return;
    }

    this.proxyHTTPSConnect(req, clientSocket, head);
  }

  async handleDirectProxy(req, res, parsedUrl) {
    try {
      // Extract target URL from path (e.g., /proxy/google.com -> google.com)
      const targetPath = parsedUrl.pathname.substring(7); // Remove '/proxy/'
      
      if (!targetPath) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head><title>BLE Proxy</title></head>
            <body>
              <h1>BLE Proxy</h1>
              <p>Usage: <code>http://localhost:${this.config.proxyPort}/proxy/example.com</code></p>
              <form method="get">
                <input type="text" name="url" placeholder="Enter URL (e.g., google.com)" style="width: 300px; padding: 8px;">
                <button type="submit">Go</button>
              </form>
                             <script>
                 const urlInput = document.querySelector('input[name="url"]');
                 const params = new URLSearchParams(window.location.search);
                 if (params.get('url')) {
                   window.location.href = '/proxy/' + params.get('url');
                 }
                 document.querySelector('form').addEventListener('submit', function(e) {
                   e.preventDefault();
                   if (urlInput.value.trim()) {
                     window.location.href = '/proxy/' + encodeURIComponent(urlInput.value.trim());
                   }
                 });
               </script>
            </body>
          </html>
        `);
        return;
      }

      // Construct the target URL
      let targetUrl = targetPath;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      // Add query parameters if present
      if (parsedUrl.search) {
        targetUrl += parsedUrl.search;
      }

      console.log(chalk.blue(`🌐 Direct proxy request: ${targetUrl}`));

      // Create a new request to the target URL
      const proxyReq = {
        method: req.method,
        url: targetUrl,
        headers: { ...req.headers }
      };

      // Remove proxy-specific headers
      delete proxyReq.headers['host'];
      delete proxyReq.headers['connection'];

      // Set appropriate headers
      proxyReq.headers['User-Agent'] = proxyReq.headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

      // If BLE is connected, send through BLE proxy
      if (this.bleClient.isConnected()) {
        console.log(chalk.green('📡 Routing through BLE proxy'));
        return this.proxyDirectRequestViaBLE(req, res, proxyReq, targetUrl);
      } else {
        // Fallback to direct HTTP request
        console.log(chalk.yellow('⚠ BLE not connected, using direct HTTP'));
        return this.proxyDirectRequestDirect(req, res, proxyReq, targetUrl);
      }

    } catch (error) {
      console.error(chalk.red('❌ Direct proxy error:'), error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + error.message);
    }
  }

  async proxyDirectRequestViaBLE(req, res, proxyReq, targetUrl) {
    const requestId = uuidv4();
    
    try {
      // Collect request data if needed
      let requestData = '';
      if (req.method === 'POST' || req.method === 'PUT') {
        requestData = await this.collectRequestData(req);
      }

      const proxyRequest = {
        id: requestId,
        method: proxyReq.method,
        url: proxyReq.url,
        headers: proxyReq.headers,
        body: requestData
      };

      // Store pending request with direct proxy flag
      this.pendingRequests.set(requestId, { 
        res, 
        timestamp: Date.now(),
        directProxy: true,
        targetUrl: targetUrl
      });

      // Send via BLE
      const compressed = await this.compressData(JSON.stringify(proxyRequest));
      await this.bleClient.sendRequest(compressed);

    } catch (error) {
      this.pendingRequests.delete(requestId);
      throw error;
    }
  }

  async proxyDirectRequestDirect(req, res, proxyReq, targetUrl) {
    const https = require('https');
    const http = require('http');
    
    const protocol = targetUrl.startsWith('https:') ? https : http;
    const parsedTarget = new URL(targetUrl);

    const options = {
      hostname: parsedTarget.hostname,
      port: parsedTarget.port,
      path: parsedTarget.pathname + parsedTarget.search,
      method: proxyReq.method,
      headers: proxyReq.headers
    };

    const proxyRequest = protocol.request(options, (proxyResponse) => {
      const contentType = proxyResponse.headers['content-type'] || '';
      
      // Collect response data
      let responseData = '';
      proxyResponse.setEncoding('utf8');
      
      proxyResponse.on('data', (chunk) => {
        responseData += chunk;
      });

      proxyResponse.on('end', () => {
        // Rewrite content if it's HTML or CSS
        if (contentType.includes('text/html')) {
          responseData = this.rewriteHTML(responseData, targetUrl);
        } else if (contentType.includes('text/css')) {
          responseData = this.rewriteCSS(responseData, targetUrl);
        }

        // Update headers
        const responseHeaders = { ...proxyResponse.headers };
        responseHeaders['content-length'] = Buffer.byteLength(responseData);
        delete responseHeaders['content-encoding']; // Remove compression headers

        res.writeHead(proxyResponse.statusCode, responseHeaders);
        res.end(responseData);
      });
    });

    proxyRequest.on('error', (error) => {
      console.error(chalk.red('Direct proxy request error:'), error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Request failed: ' + error.message);
    });

    // Send request body if needed
    if (req.method === 'POST' || req.method === 'PUT') {
      const requestData = await this.collectRequestData(req);
      proxyRequest.write(requestData);
    }

    proxyRequest.end();
  }

  rewriteHTML(html, baseUrl) {
    const parsedBase = new URL(baseUrl);
    const proxyPrefix = `http://localhost:${this.config.proxyPort}/proxy/`;
    
    // Rewrite various URL attributes
    html = html.replace(/href\s*=\s*["']([^"']+)["']/gi, (match, url) => {
      const rewritten = this.rewriteURL(url, parsedBase, proxyPrefix);
      return `href="${rewritten}"`;
    });

    html = html.replace(/src\s*=\s*["']([^"']+)["']/gi, (match, url) => {
      const rewritten = this.rewriteURL(url, parsedBase, proxyPrefix);
      return `src="${rewritten}"`;
    });

    html = html.replace(/action\s*=\s*["']([^"']+)["']/gi, (match, url) => {
      const rewritten = this.rewriteURL(url, parsedBase, proxyPrefix);
      return `action="${rewritten}"`;
    });

    // Rewrite CSS @import and url() in style tags
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
      const rewrittenCSS = this.rewriteCSS(css, baseUrl);
      return match.replace(css, rewrittenCSS);
    });

    // Add base tag to help with relative URLs
    html = html.replace(/<head[^>]*>/i, (match) => {
      return match + `\n  <base href="${proxyPrefix}${parsedBase.hostname}/" />`;
    });

    return html;
  }

  rewriteCSS(css, baseUrl) {
    const parsedBase = new URL(baseUrl);
    const proxyPrefix = `http://localhost:${this.config.proxyPort}/proxy/`;
    
    // Rewrite url() references
    css = css.replace(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, url) => {
      const rewritten = this.rewriteURL(url, parsedBase, proxyPrefix);
      return `url("${rewritten}")`;
    });

    // Rewrite @import statements
    css = css.replace(/@import\s+["']([^"']+)["']/gi, (match, url) => {
      const rewritten = this.rewriteURL(url, parsedBase, proxyPrefix);
      return `@import "${rewritten}"`;
    });

    return css;
  }

  rewriteURL(url, baseUrl, proxyPrefix) {
    try {
      // Skip data URLs, javascript:, mailto:, etc.
      if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('#')) {
        return url;
      }

      // If it's already a proxy URL, don't rewrite
      if (url.includes('/proxy/')) {
        return url;
      }

      let fullUrl;
      if (url.startsWith('http://') || url.startsWith('https://')) {
        // Absolute URL
        fullUrl = new URL(url);
      } else if (url.startsWith('//')) {
        // Protocol-relative URL
        fullUrl = new URL(baseUrl.protocol + url);
      } else {
        // Relative URL
        fullUrl = new URL(url, baseUrl);
      }

      // Return rewritten URL through proxy
      return proxyPrefix + fullUrl.host + fullUrl.pathname + fullUrl.search + fullUrl.hash;
    } catch (error) {
      console.warn(chalk.yellow(`⚠ Failed to rewrite URL: ${url}`), error.message);
      return url; // Return original URL on error
    }
  }

  async proxyHTTPRequest(req, res) {
    const requestId = uuidv4();
    
    try {
      // Collect request data
      const requestData = await this.collectRequestData(req);
      
      // Prepare request object
      const proxyRequest = {
        id: requestId,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: requestData
      };
      
      // Store pending request
      this.pendingRequests.set(requestId, { res, timestamp: Date.now() });
      
      // Compress and send via BLE
      const compressed = await this.compressData(JSON.stringify(proxyRequest));
      await this.bleClient.sendRequest(compressed);
      
    } catch (error) {
      console.error(chalk.red('HTTP request error:'), error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + error.message);
      }
      this.pendingRequests.delete(requestId);
    }
  }

  async proxyHTTPSConnect(req, clientSocket, head) {
    const requestId = uuidv4();
    
    try {
      // Prepare CONNECT request
      const proxyRequest = {
        id: requestId,
        method: 'CONNECT',
        url: req.url,
        headers: req.headers,
        isConnect: true
      };
      
      // Store pending request
      this.pendingRequests.set(requestId, { 
        socket: clientSocket, 
        head,
        timestamp: Date.now() 
      });
      
      // Compress and send via BLE
      const compressed = await this.compressData(JSON.stringify(proxyRequest));
      await this.bleClient.sendRequest(compressed);
      
    } catch (error) {
      console.error(chalk.red('HTTPS CONNECT error:'), error.message);
      clientSocket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      clientSocket.end();
      this.pendingRequests.delete(requestId);
    }
  }

  async handleBLEResponse(compressedData) {
    try {
      // Decompress response
      const responseData = await this.decompressData(compressedData);
      const response = JSON.parse(responseData);
      
      const pendingRequest = this.pendingRequests.get(response.id);
      if (!pendingRequest) {
        console.warn(chalk.yellow(`No pending request found for ID: ${response.id}`));
        return;
      }
      
      // Handle different response types
      if (response.isConnect) {
        this.handleHTTPSConnectResponse(response, pendingRequest);
      } else {
        this.handleHTTPResponse(response, pendingRequest);
      }
      
      // Clean up
      this.pendingRequests.delete(response.id);
      
    } catch (error) {
      console.error(chalk.red('BLE response error:'), error.message);
    }
  }

  handleHTTPResponse(response, pendingRequest) {
    const { res, directProxy, targetUrl } = pendingRequest;
    
    try {
      let responseBody = '';
      if (response.body) {
        const bodyBuffer = Buffer.from(response.body, 'base64');
        responseBody = bodyBuffer.toString('utf8');
      }

      // If this is a direct proxy request, rewrite content
      if (directProxy && targetUrl) {
        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('text/html')) {
          responseBody = this.rewriteHTML(responseBody, targetUrl);
        } else if (contentType.includes('text/css')) {
          responseBody = this.rewriteCSS(responseBody, targetUrl);
        }

        // Update content-length after rewriting
        const responseHeaders = { ...response.headers };
        responseHeaders['content-length'] = Buffer.byteLength(responseBody);
        delete responseHeaders['content-encoding']; // Remove compression headers since we've decompressed

        // Write status and updated headers
        res.writeHead(response.statusCode, responseHeaders);
        res.write(responseBody);
      } else {
        // Normal proxy response - write as-is
      res.writeHead(response.statusCode, response.headers);
      if (response.body) {
        const bodyBuffer = Buffer.from(response.body, 'base64');
        res.write(bodyBuffer);
        }
      }
      
      res.end();
      
    } catch (error) {
      console.error(chalk.red('HTTP response error:'), error.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  }

  handleHTTPSConnectResponse(response, pendingRequest) {
    const { socket, head } = pendingRequest;
    
    try {
      if (response.success) {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // For HTTPS CONNECT, we would need to establish a tunnel
        // This is a simplified implementation
      } else {
        socket.write(`HTTP/1.1 ${response.statusCode || 500} Connection Failed\r\n\r\n`);
        socket.end();
      }
    } catch (error) {
      console.error(chalk.red('HTTPS CONNECT response error:'), error.message);
      socket.end();
    }
  }

  async collectRequestData(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve(data.toString('base64'));
      });
      req.on('error', reject);
      
      // Set timeout
      setTimeout(() => reject(new Error('Request data timeout')), 30000);
    });
  }

  async compressData(data) {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(data);
      
      // Skip compression for small data or if disabled in debug mode
      if (buffer.length < this.config.compression.threshold || this.config.debug.skipCompression) {
        resolve(buffer);
        return;
      }
      
      zlib.gzip(buffer, { level: this.config.compression.level }, (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed);
      });
    });
  }

  async decompressData(data) {
    return new Promise((resolve, reject) => {
      zlib.gunzip(data, (err, decompressed) => {
        if (err) reject(err);
        else resolve(decompressed.toString());
      });
    });
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.blue('\nShutting down gracefully...'));
  
  // Set a timeout to force exit if graceful shutdown takes too long
  const forceExitTimer = setTimeout(() => {
    console.log(chalk.red('Force exiting after timeout...'));
    process.exit(1);
  }, 5000);
  
  try {
  if (global.proxyInstance) {
    await global.proxyInstance.stop();
  }
    clearTimeout(forceExitTimer);
  process.exit(0);
  } catch (error) {
    console.error(chalk.red('Error during shutdown:'), error);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
});

// Start the proxy if this file is run directly
if (require.main === module) {
  const proxy = new BLEProxy();
  global.proxyInstance = proxy;
  
  proxy.start().catch(error => {
    console.error(chalk.red('Failed to start proxy:'), error);
    process.exit(1);
  });
}

module.exports = BLEProxy; 