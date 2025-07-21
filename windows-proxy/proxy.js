const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');
const chalk = require('chalk');
const config = require('./config');

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
    this.isRunning = false;
    this.requestTimeouts = new Map(); // Track request timeouts
    
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
    });
    
    this.bleClient.on('disconnected', () => {
      console.log(chalk.yellow('⚠ Disconnected from iOS BLE device'));
      // Clear pending requests when disconnected
      this.clearAllPendingRequests('BLE device disconnected');
    });
    
    this.bleClient.on('error', (error) => {
      console.error(chalk.red('BLE Error:'), error.message);
    });
  }

  setupCleanupTimer() {
    // Clean up timed out requests every 30 seconds
    setInterval(() => {
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

  async start() {
    try {
      console.log(chalk.blue('Starting BLE Proxy...'));
      
      if (isMockMode) {
        console.log(chalk.yellow('🧪 Running in MOCK MODE - using TCP sockets instead of BLE'));
        console.log(chalk.gray('Make sure the mock iOS service is running on port 9999'));
      } else {
        console.log(chalk.blue('📡 Running in BLE MODE - will scan for real iOS device'));
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
          if (err) reject(err);
          else resolve();
        });
      });
      
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
    
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    await this.bleClient.disconnect();
    console.log(chalk.blue('Proxy stopped'));
  }

  handleHTTPRequest(req, res) {
    console.log(chalk.cyan(`HTTP ${req.method} ${req.url}`));
    
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
    const { res } = pendingRequest;
    
    try {
      // Write status and headers
      res.writeHead(response.statusCode, response.headers);
      
      // Write body
      if (response.body) {
        const bodyBuffer = Buffer.from(response.body, 'base64');
        res.write(bodyBuffer);
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
  if (global.proxyInstance) {
    await global.proxyInstance.stop();
  }
  process.exit(0);
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