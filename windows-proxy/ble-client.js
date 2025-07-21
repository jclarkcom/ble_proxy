const noble = require('@abandonware/noble');
const EventEmitter = require('events');
const chalk = require('chalk');

class BLEClient extends EventEmitter {
  constructor(config) {
    super();
    
    this.config = config;
    this.peripheral = null;
    this.requestCharacteristic = null;
    this.responseCharacteristic = null;
    this.controlCharacteristic = null;
    this.connected = false;
    this.connecting = false;
    
    // BLE packet size limitations
    this.maxChunkSize = 20; // BLE characteristic max size
    this.sendQueue = [];
    this.receiving = false;
    this.receivedChunks = [];
    
    this.setupNobleHandlers();
  }

  setupNobleHandlers() {
    noble.on('stateChange', (state) => {
      console.log(chalk.blue(`BLE state changed: ${state}`));
      
      if (state === 'poweredOn') {
        this.startScanning();
      } else {
        console.log(chalk.yellow('BLE not ready, waiting...'));
        this.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      this.handlePeripheralDiscovery(peripheral);
    });

    // Handle noble warnings
    process.on('warning', (warning) => {
      if (warning.name === 'MaxListenersExceededWarning') {
        // Ignore noble's MaxListenersExceededWarning
        return;
      }
      console.warn(warning);
    });
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('BLE initialization timeout'));
      }, 10000);

      const checkState = () => {
        if (noble.state === 'poweredOn') {
          clearTimeout(timeout);
          resolve();
        } else if (noble.state === 'unsupported') {
          clearTimeout(timeout);
          reject(new Error('BLE not supported on this system'));
        }
      };

      noble.on('stateChange', checkState);
      checkState(); // Check immediately
    });
  }

  startScanning() {
    if (this.connected || this.connecting) return;
    
    console.log(chalk.blue('Scanning for BLE Proxy iOS device...'));
    
    // Scan for devices advertising our service UUID
    noble.startScanning([this.config.bleServiceUUID], false);
    
    // Also scan for devices with local name
    noble.startScanning([], false);
  }

  stopScanning() {
    noble.stopScanning();
  }

  async handlePeripheralDiscovery(peripheral) {
    const deviceName = peripheral.advertisement.localName || 'Unknown';
    const serviceUUIDs = peripheral.advertisement.serviceUuids || [];
    
    // Check if this is our iOS proxy device
    const hasOurService = serviceUUIDs.includes(this.config.bleServiceUUID);
    const hasProxyName = deviceName.includes('BLE-Proxy') || deviceName.includes('Proxy');
    
    if (!hasOurService && !hasProxyName) {
      return; // Not our device
    }
    
    console.log(chalk.green(`Found potential iOS proxy device: ${deviceName} (${peripheral.address})`));
    
    if (this.connecting || this.connected) return;
    
    this.connecting = true;
    this.stopScanning();
    
    try {
      await this.connectToPeripheral(peripheral);
    } catch (error) {
      console.error(chalk.red('Connection failed:'), error.message);
      this.connecting = false;
      setTimeout(() => this.startScanning(), 2000);
    }
  }

  async connectToPeripheral(peripheral) {
    this.peripheral = peripheral;
    
    // Set up peripheral event handlers
    peripheral.on('disconnect', () => {
      console.log(chalk.yellow('Peripheral disconnected'));
      this.handleDisconnection();
    });

    peripheral.on('connect', () => {
      console.log(chalk.green('Connected to peripheral'));
    });

    // Connect to peripheral
    console.log(chalk.blue('Connecting to iOS device...'));
    await this.promisify(peripheral.connect.bind(peripheral));
    
    // Discover services
    console.log(chalk.blue('Discovering services...'));
    const { services } = await this.promisify(peripheral.discoverServices.bind(peripheral), [this.config.bleServiceUUID]);
    
    if (services.length === 0) {
      throw new Error('Proxy service not found');
    }
    
    const proxyService = services[0];
    console.log(chalk.green('Found proxy service'));
    
    // Discover characteristics
    console.log(chalk.blue('Discovering characteristics...'));
    const { characteristics } = await this.promisify(proxyService.discoverCharacteristics.bind(proxyService));
    
    // Map characteristics
    for (const char of characteristics) {
      switch (char.uuid) {
        case this.config.requestCharUUID.replace(/-/g, ''):
          this.requestCharacteristic = char;
          console.log(chalk.green('Found request characteristic'));
          break;
        case this.config.responseCharUUID.replace(/-/g, ''):
          this.responseCharacteristic = char;
          console.log(chalk.green('Found response characteristic'));
          break;
        case this.config.controlCharUUID.replace(/-/g, ''):
          this.controlCharacteristic = char;
          console.log(chalk.green('Found control characteristic'));
          break;
      }
    }
    
    if (!this.requestCharacteristic || !this.responseCharacteristic) {
      throw new Error('Required characteristics not found');
    }
    
    // Subscribe to response characteristic
    this.responseCharacteristic.on('data', (data) => {
      this.handleResponseData(data);
    });
    
    await this.promisify(this.responseCharacteristic.subscribe.bind(this.responseCharacteristic));
    console.log(chalk.green('Subscribed to response notifications'));
    
    // Subscribe to control characteristic if available
    if (this.controlCharacteristic) {
      await this.promisify(this.controlCharacteristic.subscribe.bind(this.controlCharacteristic));
    }
    
    this.connected = true;
    this.connecting = false;
    
    console.log(chalk.green('✓ BLE connection established'));
    this.emit('connected');
  }

  handleDisconnection() {
    this.connected = false;
    this.connecting = false;
    this.peripheral = null;
    this.requestCharacteristic = null;
    this.responseCharacteristic = null;
    this.controlCharacteristic = null;
    
    this.emit('disconnected');
    
    // Try to reconnect after a delay
    setTimeout(() => {
      if (!this.connected) {
        this.startScanning();
      }
    }, 3000);
  }

  async disconnect() {
    if (this.peripheral && this.connected) {
      try {
        await this.promisify(this.peripheral.disconnect.bind(this.peripheral));
      } catch (error) {
        // Ignore disconnect errors
      }
    }
    
    this.stopScanning();
    this.connected = false;
    this.connecting = false;
  }

  isConnected() {
    return this.connected;
  }

  async sendRequest(data) {
    if (!this.connected || !this.requestCharacteristic) {
      throw new Error('Not connected to BLE device');
    }

    try {
      await this.sendChunkedData(data, this.requestCharacteristic);
    } catch (error) {
      console.error(chalk.red('Failed to send request:'), error.message);
      throw error;
    }
  }

  async sendChunkedData(data, characteristic) {
    // Add header with total length
    const totalLength = data.length;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(totalLength, 0);
    
    // Combine header and data
    const fullData = Buffer.concat([header, data]);
    
    // Send in chunks
    for (let i = 0; i < fullData.length; i += this.maxChunkSize) {
      const chunk = fullData.slice(i, i + this.maxChunkSize);
      
      try {
        await this.promisify(characteristic.write.bind(characteristic), [chunk, false]);
        
        // Small delay between chunks to prevent overwhelming the peripheral
        if (i + this.maxChunkSize < fullData.length) {
          await this.sleep(10);
        }
      } catch (error) {
        throw new Error(`Failed to send chunk at offset ${i}: ${error.message}`);
      }
    }
    
    console.log(chalk.gray(`Sent ${fullData.length} bytes in ${Math.ceil(fullData.length / this.maxChunkSize)} chunks`));
  }

  handleResponseData(data) {
    if (!this.receiving) {
      // First chunk should contain the length header
      if (data.length < 4) {
        console.error(chalk.red('Invalid response header'));
        return;
      }
      
      this.expectedLength = data.readUInt32LE(0);
      this.receivedChunks = [];
      this.receivedLength = 0;
      this.receiving = true;
      
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
      console.log(chalk.gray(`Received ${fullData.length} bytes`));
      
      // Reset receiving state
      this.receiving = false;
      this.receivedChunks = [];
      this.receivedLength = 0;
      
      // Emit the response
      this.emit('response', fullData);
    }
  }

  // Helper method to promisify callback-based methods
  promisify(fn, args = []) {
    return new Promise((resolve, reject) => {
      fn(...args, (error, ...results) => {
        if (error) {
          reject(error);
        } else {
          resolve(results.length === 1 ? results[0] : results);
        }
      });
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BLEClient; 