const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const url = require('url');
const chalk = require('chalk');
const HttpClient = require('./http-client');

class MockIOSService {
  constructor(config = {}) {
    this.config = {
      port: config.port || 9999,
      host: config.host || '127.0.0.1',
      maxConnections: config.maxConnections || 10,
      timeout: config.timeout || 30000,
      ...config
    };
    
    this.server = null;
    this.connections = new Map();
    this.httpClient = new HttpClient();
    this.isRunning = false;
    this.stats = {
      connections: 0,
      requests: 0,
      errors: 0,
      startTime: null
    };
  }

  async start() {
    console.log(chalk.blue('🚀 Starting Mock iOS BLE Service...'));
    console.log(chalk.gray('Simulating iOS BLE peripheral using TCP sockets'));
    
    this.server = net.createServer();
    this.server.maxConnections = this.config.maxConnections;
    
    this.server.on('connection', (socket) => {
      this.handleConnection(socket);
    });
    
    this.server.on('error', (error) => {
      console.error(chalk.red('Server error:'), error.message);
    });
    
    await new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    this.isRunning = true;
    this.stats.startTime = new Date();
    
    console.log(chalk.green(`✓ Mock iOS service listening on ${this.config.host}:${this.config.port}`));
    console.log(chalk.yellow('Ready to accept connections from Windows proxy'));
    console.log(chalk.gray(`Max connections: ${this.config.maxConnections}`));
    console.log(chalk.gray(`Request timeout: ${this.config.timeout}ms`));
    console.log();
    console.log(chalk.yellow('To use mock mode, start Windows proxy with:'));
    console.log(chalk.yellow('  MOCK_MODE=true npm start'));
  }

  handleConnection(socket) {
    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    
    console.log(chalk.green(`📱 New connection: ${connectionId} from ${clientAddress}`));
    
    this.stats.connections++;
    
    const connectionData = {
      id: connectionId,
      socket,
      address: clientAddress,
      connectedAt: new Date(),
      receiving: false,
      expectedLength: 0,
      receivedLength: 0,
      chunks: []
    };
    
    this.connections.set(connectionId, connectionData);
    
    // Set socket options
    socket.setTimeout(this.config.timeout);
    socket.setKeepAlive(true, 30000);
    
    // Handle incoming data
    socket.on('data', (data) => {
      this.handleData(connectionId, data);
    });
    
    // Handle disconnection
    socket.on('close', () => {
      console.log(chalk.yellow(`📱 Connection closed: ${connectionId}`));
      this.connections.delete(connectionId);
    });
    
    socket.on('error', (error) => {
      console.error(chalk.red(`Connection error ${connectionId}:`), error.message);
      this.connections.delete(connectionId);
    });
    
    socket.on('timeout', () => {
      console.warn(chalk.yellow(`Connection timeout ${connectionId}`));
      socket.end();
      this.connections.delete(connectionId);
    });
  }

  handleData(connectionId, data) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    try {
      if (!connection.receiving) {
        // First chunk should contain length header
        if (data.length < 4) {
          console.error(chalk.red(`Invalid header from ${connectionId}`));
          return;
        }
        
        connection.expectedLength = data.readUInt32LE(0);
        connection.receivedLength = 0;
        connection.chunks = [];
        connection.receiving = true;
        
        console.log(chalk.gray(`📨 Receiving ${connection.expectedLength} bytes from ${connectionId}`));
        
        // Process remaining data from first chunk
        const remainingData = data.slice(4);
        if (remainingData.length > 0) {
          connection.chunks.push(remainingData);
          connection.receivedLength += remainingData.length;
        }
      } else {
        // Subsequent chunks
        connection.chunks.push(data);
        connection.receivedLength += data.length;
      }
      
      // Check if we have all data
      if (connection.receivedLength >= connection.expectedLength) {
        const fullData = Buffer.concat(connection.chunks).slice(0, connection.expectedLength);
        console.log(chalk.gray(`📨 Received complete request: ${fullData.length} bytes`));
        
        // Reset receiving state
        connection.receiving = false;
        connection.chunks = [];
        connection.receivedLength = 0;
        
        // Process the request
        this.processRequest(connectionId, fullData);
      }
      
    } catch (error) {
      console.error(chalk.red(`Data handling error ${connectionId}:`), error.message);
      this.stats.errors++;
    }
  }

  async processRequest(connectionId, compressedData) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    try {
      this.stats.requests++;
      
      // Decompress request data
      const requestData = await this.decompressData(compressedData);
      const request = JSON.parse(requestData);
      
      console.log(chalk.cyan(`🔄 Processing ${request.method} ${request.url} [${connectionId}]`));
      
      let response;
      
      if (request.isConnect) {
        // Handle HTTPS CONNECT
        response = await this.handleConnectRequest(request);
      } else {
        // Handle regular HTTP request
        response = await this.httpClient.makeRequest(request);
      }
      
      // Add request ID to response
      response.id = request.id;
      
      // Compress and send response
      const responseData = JSON.stringify(response);
      const compressedResponse = await this.compressData(responseData);
      
      await this.sendResponse(connectionId, compressedResponse);
      
      console.log(chalk.green(`✅ Response sent: ${response.statusCode} [${connectionId}]`));
      
    } catch (error) {
      console.error(chalk.red(`Request processing error ${connectionId}:`), error.message);
      this.stats.errors++;
      
      // Send error response
      try {
        const errorResponse = {
          id: request?.id || 'unknown',
          statusCode: 500,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from(`Mock iOS error: ${error.message}`).toString('base64')
        };
        
        const responseData = JSON.stringify(errorResponse);
        const compressedResponse = await this.compressData(responseData);
        await this.sendResponse(connectionId, compressedResponse);
        
      } catch (sendError) {
        console.error(chalk.red(`Failed to send error response: ${sendError.message}`));
      }
    }
  }

  async handleConnectRequest(request) {
    // For HTTPS CONNECT, we'll return a simple success
    // In a real implementation, this would establish a tunnel
    console.log(chalk.blue(`🔒 HTTPS CONNECT to ${request.url}`));
    
    return {
      id: request.id,
      isConnect: true,
      success: true,
      statusCode: 200,
      headers: {}
    };
  }

  async sendResponse(connectionId, compressedData) {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.socket) return;
    
    // Add length header
    const totalLength = compressedData.length;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(totalLength, 0);
    
    // Combine header and data
    const fullData = Buffer.concat([header, compressedData]);
    
    // Send data
    connection.socket.write(fullData);
    console.log(chalk.gray(`📤 Sent ${fullData.length} bytes to ${connectionId}`));
  }

  async compressData(data) {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(data);
      zlib.gzip(buffer, { level: 6 }, (err, compressed) => {
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

  printStats() {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0;
    const uptimeStr = this.formatUptime(uptime);
    
    console.log();
    console.log(chalk.blue('📊 Mock iOS Service Stats:'));
    console.log(chalk.gray(`  Uptime: ${uptimeStr}`));
    console.log(chalk.gray(`  Total connections: ${this.stats.connections}`));
    console.log(chalk.gray(`  Active connections: ${this.connections.size}`));
    console.log(chalk.gray(`  Total requests: ${this.stats.requests}`));
    console.log(chalk.gray(`  Total errors: ${this.stats.errors}`));
    
    if (this.connections.size > 0) {
      console.log(chalk.blue('Active Connections:'));
      for (const [id, conn] of this.connections.entries()) {
        const connectedFor = Date.now() - conn.connectedAt.getTime();
        console.log(chalk.gray(`  ${id}: ${conn.address} (${this.formatUptime(connectedFor)})`));
      }
    }
  }

  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  async stop() {
    console.log(chalk.blue('Stopping Mock iOS service...'));
    this.isRunning = false;
    
    // Close all connections
    for (const [id, conn] of this.connections.entries()) {
      conn.socket.end();
    }
    this.connections.clear();
    
    // Close server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    this.printStats();
    console.log(chalk.blue('Mock iOS service stopped'));
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.blue('\nShutting down gracefully...'));
  if (global.mockService) {
    await global.mockService.stop();
  }
  process.exit(0);
});

// Start stats timer
let statsInterval;
process.on('SIGUSR1', () => {
  if (global.mockService) {
    global.mockService.printStats();
  }
});

// Start the service if this file is run directly
if (require.main === module) {
  const mockService = new MockIOSService();
  global.mockService = mockService;
  
  mockService.start().then(() => {
    // Print stats every 60 seconds
    statsInterval = setInterval(() => {
      if (mockService.isRunning) {
        mockService.printStats();
      }
    }, 60000);
    
  }).catch(error => {
    console.error(chalk.red('Failed to start mock service:'), error);
    process.exit(1);
  });
}

module.exports = MockIOSService; 