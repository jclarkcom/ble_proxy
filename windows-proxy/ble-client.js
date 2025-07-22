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
    this.reconnectTimer = null;
    
    // BLE packet size limitations
    this.maxChunkSize = 20; // BLE characteristic max size
    this.sendQueue = [];
    this.receiving = false;
    this.receivedChunks = [];
    
    this.setupNobleHandlers();
  }
  
  // Emit log events for the UI
  bleLog(message, level = 'info') {
    this.emit('log', { message, level, source: 'BLE' });
  }

  setupNobleHandlers() {
    noble.on('stateChange', (state) => {
      console.log(chalk.blue(`BLE state changed: ${state}`));
      
      if (state === 'poweredOn') {
        // Don't auto-start scanning - let web interface control it
        this.emit('ready');
      } else {
        console.log(chalk.yellow('BLE not ready, waiting...'));
        this.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      if (this.generalScanMode) {
        // Web interface scan mode - emit all discovered devices
        this.handleGeneralDeviceDiscovery(peripheral);
      } else {
        // Original auto-connect mode
        this.handlePeripheralDiscovery(peripheral);
      }
    });

    // Handle noble warnings
    process.on('warning', (warning) => {
      if (warning.name === 'MaxListenersExceededWarning') {
        // Ignore noble's MaxListenersExceededWarning
        return;
      }
      console.warn(warning);
    });
    
    this.generalScanMode = false;
    this.discoveredDevices = new Map();
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('BLE initialization timeout'));
      }, 10000);

      const checkState = () => {
        if (noble.state === 'poweredOn') {
          clearTimeout(timeout);
          console.log(chalk.green('✓ BLE adapter ready for scanning'));
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

  // Check if the client supports scanning (for web interface)
  canScan() {
    return noble.state === 'poweredOn';
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

  // Web interface scanning methods
  async startScan() {
    if (noble.state !== 'poweredOn') {
      throw new Error('BLE adapter not ready');
    }
    
    console.log(chalk.blue('Starting general BLE device scan...'));
    this.generalScanMode = true;
    this.discoveredDevices.clear();
    
    this.emit('scanStart');
    
    // Scan for all devices (no service filter)
    noble.startScanning([], true); // Allow duplicates for RSSI updates
    
    // Stop scan after 30 seconds
    setTimeout(() => {
      if (this.generalScanMode) {
        this.stopGeneralScan();
      }
    }, 30000);
  }

  stopGeneralScan() {
    console.log(chalk.blue('Stopping general BLE device scan'));
    this.generalScanMode = false;
    noble.stopScanning();
    this.emit('scanStop');
  }

  handleGeneralDeviceDiscovery(peripheral) {
    const deviceId = peripheral.address || peripheral.id;
    const deviceName = peripheral.advertisement.localName || 
                      peripheral.advertisement.shortLocalName || 
                      'Unknown Device';
    
    // Create device info object
    const deviceInfo = {
      id: deviceId,
      address: peripheral.address,
      name: deviceName,
      rssi: peripheral.rssi,
      advertisement: {
        localName: peripheral.advertisement.localName,
        serviceUUIDs: peripheral.advertisement.serviceUuids || [],
        manufacturerData: peripheral.advertisement.manufacturerData,
        txPowerLevel: peripheral.advertisement.txPowerLevel,
        serviceData: peripheral.advertisement.serviceData
      },
      connectable: peripheral.connectable
    };
    
    // Store peripheral reference for later connection
    this.discoveredDevices.set(deviceId, peripheral);
    
    // Emit device discovered event
    this.emit('deviceDiscovered', deviceInfo);
    
    // Log discovery (commented out to reduce noise)
    // const serviceCount = deviceInfo.advertisement.serviceUUIDs.length;
    // console.log(chalk.gray(`📱 Discovered: ${deviceName} (${deviceId}) RSSI: ${peripheral.rssi}dBm, Services: ${serviceCount}`));
  }

  async connectToDevice(deviceId) {
    const peripheral = this.discoveredDevices.get(deviceId);
    if (!peripheral) {
      throw new Error('Device not found. Please scan first.');
    }
    
    if (this.connecting || this.connected) {
      throw new Error('Already connecting or connected to a device');
    }
    
    console.log(chalk.blue(`Connecting to device: ${peripheral.advertisement.localName || deviceId}...`));
    
    // Stop general scanning
    if (this.generalScanMode) {
      this.stopGeneralScan();
    }
    
    this.connecting = true;
    
    try {
      await this.connectToPeripheral(peripheral);
    } catch (error) {
      this.connecting = false;
      throw error;
    }
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
    
    console.log(chalk.green(`🎯 Found potential iOS proxy device: ${deviceName} (${peripheral.address})`));
    console.log(chalk.gray(`   RSSI: ${peripheral.rssi}dBm`));
    console.log(chalk.gray(`   Has our service: ${hasOurService}`));
    console.log(chalk.gray(`   Has proxy name: ${hasProxyName}`));
    console.log(chalk.gray(`   State: connected=${this.connected}, connecting=${this.connecting}`));
    
    if (this.connecting || this.connected) {
      console.log(chalk.yellow(`⏳ Already ${this.connecting ? 'connecting' : 'connected'}, skipping...`));
      return;
    }
    
    this.connecting = true;
    this.stopScanning();
    console.log(chalk.blue('🔄 Starting connection attempt...'));
    
    try {
      await this.connectToPeripheral(peripheral);
      console.log(chalk.green('🎉 Connection successful!'));
    } catch (error) {
      console.error(chalk.red('💥 Connection failed:'), error.message);
      this.connecting = false;
      console.log(chalk.yellow('⏰ Will retry in 2 seconds...'));
      setTimeout(() => {
        console.log(chalk.blue('🔄 Restarting scan after failed connection'));
        this.startScanning();
      }, 2000);
    }
  }

    async connectToPeripheral(peripheral) {
    this.peripheral = peripheral;
    
    try {
      // Set up peripheral event handlers
      let connectionInProgress = true;
      
      peripheral.on('disconnect', () => {
        console.log(chalk.yellow('🔌 Peripheral disconnected'));
        this.bleLog('🔌 BLE device disconnected', 'warning');
        console.log(chalk.gray(`   Device: ${peripheral.advertisement?.localName || 'Unknown'} (${peripheral.address})`));
        console.log(chalk.gray(`   Connection state: connected=${this.connected}, connecting=${this.connecting}`));
        console.log(chalk.gray(`   Connection in progress: ${connectionInProgress}`));
        
        if (connectionInProgress) {
          console.log(chalk.red('❌ Disconnection occurred during connection setup!'));
          this.bleLog('❌ Device disconnected during connection setup - this indicates an iOS app issue', 'error');
        }
        
        this.handleDisconnection();
      });

      peripheral.on('connect', () => {
        console.log(chalk.green('🔗 Connected to peripheral'));
        console.log(chalk.gray(`   Device: ${peripheral.advertisement?.localName || 'Unknown'} (${peripheral.address})`));
      });
      
      // Add error handler
      peripheral.on('error', (error) => {
        console.error(chalk.red('🚨 Peripheral error:'));
        console.error(chalk.red(`   Error: ${error.message}`));
        console.error(chalk.red(`   Code: ${error.code || 'N/A'}`));
      });

      // Connect to peripheral
      console.log(chalk.blue('Connecting to iOS device...'));
      this.bleLog('🔗 Starting BLE connection to iOS device...', 'info');
      console.log(chalk.gray(`  Target service UUID: ${this.config.bleServiceUUID}`));
      this.bleLog(`Target service UUID: ${this.config.bleServiceUUID}`, 'info');
      console.log(chalk.gray(`  Expected request char: ${this.config.requestCharUUID}`));
      console.log(chalk.gray(`  Expected response char: ${this.config.responseCharUUID}`));
      console.log(chalk.gray(`  Expected control char: ${this.config.controlCharUUID}`));
      
      await this.promisify(peripheral.connect.bind(peripheral));
      console.log(chalk.green('✓ Physical connection established'));
      this.bleLog('✅ Physical BLE connection established', 'success');
      
      // Wait a moment for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Discover services
      console.log(chalk.blue('Discovering services...'));
      this.bleLog('🔍 Starting service discovery...', 'info');
      console.log(chalk.gray(`  Looking for service: ${this.config.bleServiceUUID}`));
      console.log(chalk.gray(`  Peripheral state before discovery: ${peripheral.state}`));
      this.bleLog(`Peripheral state: ${peripheral.state}`, 'info');
      
      const discoveryStartTime = Date.now();
      const services = await this.promisify(peripheral.discoverServices.bind(peripheral), [], 15000);
      const discoveryTime = Date.now() - discoveryStartTime;
      
      console.log(chalk.green(`✓ Service discovery completed in ${discoveryTime}ms`));
      this.bleLog(`✅ Service discovery completed in ${discoveryTime}ms`, 'success');
      
      console.log(chalk.gray(`  Discovered ${services ? services.length : 0} services`));
      if (services) {
        services.forEach((service, index) => {
          console.log(chalk.gray(`    Service ${index}: ${service.uuid}`));
        });
      }
      
      if (!services || services.length === 0) {
        throw new Error('No services found');
      }
      
      // Find our proxy service
      const targetServiceUUID = this.config.bleServiceUUID.replace(/-/g, '').toLowerCase();
      console.log(chalk.gray(`  Looking for service UUID: ${targetServiceUUID}`));
      
      const proxyService = services.find(service => {
        const serviceUUID = service.uuid.toLowerCase();
        console.log(chalk.gray(`    Comparing: ${serviceUUID} === ${targetServiceUUID}`));
        return serviceUUID === targetServiceUUID;
      });
      
      if (!proxyService) {
        throw new Error(`Proxy service not found. Expected: ${this.config.bleServiceUUID}, found: ${services.map(s => s.uuid).join(', ')}`);
      }
      
      console.log(chalk.green(`✓ Found proxy service: ${proxyService.uuid}`));
      
      // Wait a moment before characteristic discovery
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check if we're still connected before characteristic discovery
      if (peripheral.state !== 'connected') {
        throw new Error(`Peripheral disconnected before characteristic discovery. State: ${peripheral.state}`);
      }
      
      // Discover characteristics
      console.log(chalk.blue('Discovering characteristics...'));
      console.log(chalk.gray(`  Service UUID: ${proxyService.uuid}`));
      console.log(chalk.gray(`  Peripheral state: ${peripheral.state}`));
      
      let characteristics;
      try {
        characteristics = await this.promisify(proxyService.discoverCharacteristics.bind(proxyService), [], 10000);
      } catch (error) {
        console.error(chalk.red(`❌ Characteristic discovery failed: ${error.message}`));
        console.error(chalk.red(`   Peripheral state: ${peripheral.state}`));
        throw new Error(`Characteristic discovery failed: ${error.message}`);
      }
      
      console.log(chalk.green(`✓ Characteristic discovery completed`));
      console.log(chalk.gray(`  Discovered ${characteristics ? characteristics.length : 0} characteristics`));
      console.log(chalk.gray(`  Peripheral state after discovery: ${peripheral.state}`));
      
      if (!characteristics || characteristics.length === 0) {
        throw new Error('No characteristics found');
      }
      
      // Log all discovered characteristics
      characteristics.forEach((char, index) => {
        console.log(chalk.gray(`    Characteristic ${index}: ${char.uuid} (properties: ${JSON.stringify(char.properties)})`));
      });
      
      console.log(chalk.blue(`Found ${characteristics.length} characteristics - mapping...`));
      
      // Map characteristics
      let foundRequest = false, foundResponse = false, foundControl = false;
      
      for (const char of characteristics) {
        const uuid = char.uuid.toLowerCase();
        const expectedRequest = this.config.requestCharUUID.replace(/-/g, '').toLowerCase();
        const expectedResponse = this.config.responseCharUUID.replace(/-/g, '').toLowerCase();
        const expectedControl = this.config.controlCharUUID.replace(/-/g, '').toLowerCase();
        
        console.log(chalk.gray(`  Checking characteristic: ${uuid}`));
        console.log(chalk.gray(`    Against request: ${expectedRequest}`));
        console.log(chalk.gray(`    Against response: ${expectedResponse}`));
        console.log(chalk.gray(`    Against control: ${expectedControl}`));
        
        if (uuid === expectedRequest) {
          this.requestCharacteristic = char;
          foundRequest = true;
          console.log(chalk.green('✓ Found request characteristic'));
        } else if (uuid === expectedResponse) {
          this.responseCharacteristic = char;
          foundResponse = true;
          console.log(chalk.green('✓ Found response characteristic'));
        } else if (uuid === expectedControl) {
          this.controlCharacteristic = char;
          foundControl = true;
          console.log(chalk.green('✓ Found control characteristic'));
        } else {
          console.log(chalk.yellow(`  No match for characteristic: ${uuid}`));
        }
      }
      
      console.log(chalk.blue('Characteristic mapping summary:'));
      console.log(chalk.gray(`  Request: ${foundRequest ? '✓' : '✗'}`));
      console.log(chalk.gray(`  Response: ${foundResponse ? '✓' : '✗'}`));
      console.log(chalk.gray(`  Control: ${foundControl ? '✓' : '✗'}`));
      
      if (!this.requestCharacteristic || !this.responseCharacteristic) {
        throw new Error(`Required characteristics not found. Request: ${this.requestCharacteristic ? '✓' : '✗'}, Response: ${this.responseCharacteristic ? '✓' : '✗'}`);
      }

      // Subscribe to response characteristic
      console.log(chalk.blue('Setting up response notifications...'));
      console.log(chalk.gray(`  Response characteristic UUID: ${this.responseCharacteristic.uuid}`));
      console.log(chalk.gray(`  Response characteristic properties: ${JSON.stringify(this.responseCharacteristic.properties)}`));
      
      this.responseCharacteristic.on('data', (data) => {
        console.log(chalk.cyan(`📨 Received data: ${data.length} bytes`));
        this.handleResponseData(data);
      });

      console.log(chalk.blue('Subscribing to response notifications...'));
      try {
        await this.promisify(this.responseCharacteristic.subscribe.bind(this.responseCharacteristic));
        console.log(chalk.green('✓ Subscribed to response notifications'));
      } catch (subscribeError) {
        console.error(chalk.red(`❌ Failed to subscribe to response notifications: ${subscribeError.message}`));
        throw subscribeError;
      }

      // Subscribe to control characteristic if available
      if (this.controlCharacteristic) {
        console.log(chalk.blue('Subscribing to control notifications...'));
        console.log(chalk.gray(`  Control characteristic UUID: ${this.controlCharacteristic.uuid}`));
        console.log(chalk.gray(`  Control characteristic properties: ${JSON.stringify(this.controlCharacteristic.properties)}`));
        
        try {
          await this.promisify(this.controlCharacteristic.subscribe.bind(this.controlCharacteristic));
          console.log(chalk.green('✓ Subscribed to control notifications'));
        } catch (controlSubscribeError) {
          console.error(chalk.yellow(`⚠️ Failed to subscribe to control notifications: ${controlSubscribeError.message}`));
          // Don't throw here as control characteristic might be optional
        }
      } else {
        console.log(chalk.gray('ℹ️ No control characteristic available'));
      }

      connectionInProgress = false;
      this.connected = true;
      this.connecting = false;
      console.log(chalk.green.bold('✅ BLE connection established successfully!'));
      this.bleLog('🎉 BLE connection and setup completed successfully!', 'success');
      this.emit('connected');
    } catch (error) {
              console.error(chalk.red('❌ Connection failed during setup:'));
        this.bleLog(`❌ BLE connection failed: ${error.message}`, 'error');
        console.error(chalk.red(`   Error: ${error.message}`));
        console.error(chalk.red(`   Stack: ${error.stack}`));
      
      this.connecting = false;
      
      // Reset characteristics
      this.requestCharacteristic = null;
      this.responseCharacteristic = null;
      this.controlCharacteristic = null;
      
      if (this.peripheral) {
        console.log(chalk.yellow('🔄 Attempting to disconnect peripheral...'));
        try {
          this.peripheral.disconnect();
          console.log(chalk.yellow('✓ Peripheral disconnected'));
        } catch (disconnectError) {
          console.error(chalk.yellow(`⚠️ Error disconnecting: ${disconnectError.message}`));
        }
      }
      
      throw new Error(`BLE connection failed: ${error.message}`);
    }
    
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
    this.reconnectTimer = setTimeout(() => {
      if (!this.connected) {
        this.startScanning();
      }
    }, 3000);
  }

  async disconnect() {
    // Clear reconnect timer if it exists
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
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
  promisify(fn, args = [], timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const timeout = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.error(chalk.red(`⏰ BLE operation timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`));
        reject(new Error(`BLE operation timed out after ${elapsed}ms`));
      }, timeoutMs);
      
      fn(...args, (error, ...results) => {
        const elapsed = Date.now() - startTime;
        clearTimeout(timeout);
        
        if (error) {
          console.error(chalk.red(`❌ BLE operation failed after ${elapsed}ms: ${error.message}`));
          reject(error);
        } else {
          console.log(chalk.gray(`✓ BLE operation completed in ${elapsed}ms`));
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