const net = require('net');
const EventEmitter = require('events');
const chalk = require('chalk');

class MockBLEClient extends EventEmitter {
  constructor(config) {
    super();
    
    this.config = config;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    
    // Mock service connection details
    this.mockServiceHost = process.env.MOCK_SERVICE_HOST || '127.0.0.1';
    this.mockServicePort = parseInt(process.env.MOCK_SERVICE_PORT) || 9999;
    
    // Data handling
    this.receiving = false;
    this.receivedChunks = [];
    this.receivedLength = 0;
    this.expectedLength = 0;
    
    this.reconnectDelay = 3000;
    this.reconnectTimer = null;
    this.connectionAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  async initialize() {
    console.log(chalk.blue('🔄 Initializing Mock BLE Client (TCP socket mode)...'));
    console.log(chalk.gray(`Will connect to mock iOS service at ${this.mockServiceHost}:${this.mockServicePort}`));
    
    // Start connection attempt
    await this.connectToMockService();
  }

  async connectToMockService() {
    if (this.connecting || this.connected) return;
    
    this.connecting = true;
    this.connectionAttempts++;
    
    console.log(chalk.blue(`🔌 Connecting to mock iOS service (attempt ${this.connectionAttempts})...`));
    
    try {
      this.socket = new net.Socket();
      
      // Set up socket event handlers
      this.setupSocketHandlers();
      
      // Connect to mock service
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);
        
        this.socket.connect(this.mockServicePort, this.mockServiceHost, () => {
          clearTimeout(timeout);
          resolve();
        });
        
        this.socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      this.connected = true;
      this.connecting = false;
      this.connectionAttempts = 0;
      
      console.log(chalk.green('✓ Connected to mock iOS service'));
      this.emit('connected');
      
    } catch (error) {
      this.connecting = false;
      console.error(chalk.red(`Connection failed: ${error.message}`));
      
      if (this.connectionAttempts < this.maxReconnectAttempts) {
        console.log(chalk.yellow(`⏳ Retrying connection in ${this.reconnectDelay}ms...`));
        this.scheduleReconnect();
      } else {
        console.error(chalk.red('Max reconnection attempts reached'));
        this.emit('error', new Error('Unable to connect to mock iOS service'));
      }
    }
  }

  setupSocketHandlers() {
    this.socket.on('data', (data) => {
      this.handleResponseData(data);
    });
    
    this.socket.on('close', () => {
      console.log(chalk.yellow('🔌 Connection to mock iOS service closed'));
      this.handleDisconnection();
    });
    
    this.socket.on('error', (error) => {
      console.error(chalk.red('Socket error:'), error.message);
      this.handleDisconnection();
    });
    
    this.socket.setKeepAlive(true, 30000);
  }

  handleDisconnection() {
    this.connected = false;
    this.connecting = false;
    
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    
    // Reset receiving state
    this.receiving = false;
    this.receivedChunks = [];
    this.receivedLength = 0;
    
    this.emit('disconnected');
    
    // Try to reconnect
    if (this.connectionAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    this.reconnectTimer = setTimeout(() => {
      if (!this.connected && !this.connecting) {
        this.connectToMockService();
      }
    }, this.reconnectDelay);
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.connectionAttempts = this.maxReconnectAttempts; // Prevent reconnection
    
    if (this.socket) {
      this.socket.end();
    }
    
    this.connected = false;
    this.connecting = false;
  }

  isConnected() {
    return this.connected;
  }

  async sendRequest(data) {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to mock iOS service');
    }

    try {
      // Add header with total length
      const totalLength = data.length;
      const header = Buffer.alloc(4);
      header.writeUInt32LE(totalLength, 0);
      
      // Combine header and data
      const fullData = Buffer.concat([header, data]);
      
      // Send data
      this.socket.write(fullData);
      console.log(chalk.gray(`📤 Sent ${fullData.length} bytes to mock iOS service`));
      
    } catch (error) {
      console.error(chalk.red('Failed to send request:'), error.message);
      throw error;
    }
  }

  handleResponseData(data) {
    if (!this.receiving) {
      // First chunk should contain the length header
      if (data.length < 4) {
        console.error(chalk.red('Invalid response header from mock service'));
        return;
      }
      
      this.expectedLength = data.readUInt32LE(0);
      this.receivedChunks = [];
      this.receivedLength = 0;
      this.receiving = true;
      
      console.log(chalk.gray(`📨 Receiving ${this.expectedLength} bytes from mock iOS service`));
      
      // Process remaining data from first chunk
      const remainingData = data.slice(4);
      if (remainingData.length > 0) {
        this.receivedChunks.push(remainingData);
        this.receivedLength += remainingData.length;
      }
    } else {
      // Subsequent chunks
      this.receivedChunks.push(data);
      this.receivedLength += data.length;
    }
    
    // Check if we have received all data
    if (this.receivedLength >= this.expectedLength) {
      const fullData = Buffer.concat(this.receivedChunks).slice(0, this.expectedLength);
      console.log(chalk.gray(`📨 Received complete response: ${fullData.length} bytes`));
      
      // Reset receiving state
      this.receiving = false;
      this.receivedChunks = [];
      this.receivedLength = 0;
      
      // Emit the response
      this.emit('response', fullData);
    }
  }

  // Mock the BLE scanning/discovery process
  startScanning() {
    console.log(chalk.blue('🔍 Mock BLE scanning started (connecting to TCP service instead)'));
    // Immediately try to connect since we're not actually scanning
    setTimeout(() => {
      this.connectToMockService();
    }, 1000);
  }

  stopScanning() {
    console.log(chalk.gray('🔍 Mock BLE scanning stopped'));
  }
}

module.exports = MockBLEClient; 