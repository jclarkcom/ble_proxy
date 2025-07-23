const noble = require('@stoprocent/noble');
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
    
    this.normalizedServiceUUID = config.bleServiceUUID.replace(/-/g, '').toLowerCase();
    this.generalScanMode = false;
    this.discoveredDevices = new Map();
    
    // Track Noble.js reset attempts
    this.nobleResetCount = 0;
    this.maxNobleResets = 2;
    
    this.setupNobleHandlers();
  }
  
  // Force complete Noble.js reset when cache clearing fails
  async forceNobleReset() {
    if (this.nobleResetCount >= this.maxNobleResets) {
      console.log(chalk.red(`❌ Maximum Noble.js resets reached (${this.maxNobleResets}), giving up`));
      throw new Error('Noble.js reset limit exceeded - fundamental BLE communication failure');
    }
    
    this.nobleResetCount++;
    console.log(chalk.yellow(`🔄 Forcing complete Noble.js reset (attempt ${this.nobleResetCount}/${this.maxNobleResets})`));
    
    try {
      // Stop all Noble.js operations
      if (this.noble.state === 'poweredOn') {
        console.log(chalk.gray(`  Stopping Noble.js scanning and operations...`));
        this.noble.stopScanning();
      }
      
      // Clear all internal state
      this.connected = false;
      this.connecting = false;
      this.peripheral = null;
      this.requestCharacteristic = null;
      this.responseCharacteristic = null;
      this.controlCharacteristic = null;
      this.discoveredDevices.clear();
      
      // Clear any timers
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.scanTimeout) {
        clearTimeout(this.scanTimeout);
        this.scanTimeout = null;
      }
      
      console.log(chalk.gray(`  Removing all Noble.js event listeners...`));
      this.noble.removeAllListeners();
      
      // Force garbage collection of Noble.js internal state
      console.log(chalk.gray(`  Forcing Noble.js internal cleanup...`));
      try {
        if (this.noble._peripherals && typeof this.noble._peripherals.clear === 'function') {
          this.noble._peripherals.clear();
        }
        if (this.noble._services && typeof this.noble._services.clear === 'function') {
          this.noble._services.clear();
        }
        if (this.noble._characteristics && typeof this.noble._characteristics.clear === 'function') {
          this.noble._characteristics.clear();
        }
      } catch (cleanupError) {
        console.log(chalk.gray(`    Internal cleanup warning: ${cleanupError.message}`));
      }
      
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Reinitialize Noble.js
      console.log(chalk.gray(`  Reinitializing Noble.js...`));
      delete require.cache[require.resolve('@abandonware/noble')];
      this.noble = require('@abandonware/noble');
      
      // Setup events again
      this.setupNobleEvents();
      
      // Wait for Noble.js to initialize
      console.log(chalk.gray(`  Waiting for Noble.js to power on...`));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Noble.js failed to power on after reset'));
        }, 10000);
        
        const checkState = () => {
          if (this.noble && this.noble.state === 'poweredOn') {
            clearTimeout(timeout);
            resolve();
          } else if (this.noble && this.noble.state && this.noble.state !== 'unknown') {
            // Noble.js is initialized but not powered on
            clearTimeout(timeout);
            reject(new Error(`Noble.js reset completed but Bluetooth not powered on: ${this.noble.state}`));
          }
        };
        
        // Check immediately
        checkState();
        
        // Also listen for state changes
        if (this.noble) {
          this.noble.once('stateChange', (state) => {
            clearTimeout(timeout);
            if (state === 'poweredOn') {
              resolve();
            } else {
              reject(new Error(`Noble.js powered on with unexpected state: ${state}`));
            }
          });
        }
      });
      
      console.log(chalk.green(`✅ Noble.js reset completed successfully`));
      
      // Start fresh scanning
      console.log(chalk.gray(`  Starting fresh scan after Noble.js reset...`));
      this.startScanning();
      
    } catch (error) {
      console.error(chalk.red(`❌ Noble.js reset failed: ${error.message}`));
      throw error;
    }
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
    if (this.connected || this.connecting) {
      console.log(chalk.yellow('⏳ Scanning blocked: already connected or connecting'));
      return;
    }
    
    console.log(chalk.blue('Scanning for BLE Proxy iOS device...'));
    
    // Use normalized 128-bit UUID without dashes per noble expectations  
    noble.startScanning([this.normalizedServiceUUID], false);
    
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
    
    if (this.connected || this.connecting) {
      console.log(chalk.yellow('⏳ General scan blocked: already connected or connecting'));
      return;
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
    
    // Reset Windows BLE stack before connection to clear any cache issues
    await this.resetWindowsBLEStack();
    
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
    const serviceUUIDs = (peripheral.advertisement.serviceUuids || []).map(u => u.replace(/-/g, '').toLowerCase());
    
    // Debug UUID comparison
    if (deviceName.includes('BLE-Proxy') && serviceUUIDs.length > 0) {
      console.log(chalk.gray(`   Raw advertised UUIDs: ${JSON.stringify(peripheral.advertisement.serviceUuids || [])}`));
      console.log(chalk.gray(`   Normalized advertised UUIDs: ${JSON.stringify(serviceUUIDs)}`));
      console.log(chalk.gray(`   Looking for normalized UUID: ${this.normalizedServiceUUID}`));
    }
    
    // Check if this is our iOS proxy device
    const hasOurService = serviceUUIDs.includes(this.normalizedServiceUUID);
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
    
    // Immediately stop scanning and set connecting state to prevent race conditions
    console.log(chalk.blue('🔄 Starting connection attempt...'));
    this.stopScanning();
    this.connecting = true;
    
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
    
    // Define connectionInProgress at the method level to avoid scope issues
    let connectionInProgress = true;
    
    try {
      // Set up peripheral event handlers
      
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
        console.error(chalk.red(`   Stack: ${error.stack || 'N/A'}`));
        this.bleLog(`🚨 Peripheral error: ${error.message}`, 'error');
      });
      
      // Add Noble.js specific event logging
      peripheral.on('servicesDiscover', (services) => {
        console.log(chalk.green(`🔍 Noble.js servicesDiscover event: found ${services.length} services`));
        this.bleLog(`🔍 Noble.js discovered ${services.length} services`, 'info');
      });
      
      peripheral.on('characteristicsDiscover', (characteristics) => {
        console.log(chalk.green(`🔍 Noble.js characteristicsDiscover event: found ${characteristics.length} characteristics`));
        this.bleLog(`🔍 Noble.js discovered ${characteristics.length} characteristics`, 'info');
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
      
      // Wait longer for connection to stabilize (Noble.js sometimes needs more time)
      console.log(chalk.gray('  Waiting for BLE stack to stabilize...'));
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Discover services with retry logic
      console.log(chalk.blue('Discovering services...'));
      this.bleLog('🔍 Starting service discovery...', 'info');
      console.log(chalk.gray(`  Looking for service: ${this.config.bleServiceUUID}`));
      console.log(chalk.gray(`  Peripheral state before discovery: ${peripheral.state}`));
      this.bleLog(`Peripheral state: ${peripheral.state}`, 'info');
      
      let services = null;
      let discoveryAttempts = 0;
      const maxDiscoveryAttempts = 3;
      
      while (!services && discoveryAttempts < maxDiscoveryAttempts) {
        discoveryAttempts++;
        console.log(chalk.gray(`  Service discovery attempt ${discoveryAttempts}/${maxDiscoveryAttempts}`));
        
        try {
          // Check connection state before each attempt
          if (peripheral.state !== 'connected') {
            throw new Error(`Peripheral disconnected before service discovery. State: ${peripheral.state}`);
          }
          
          const discoveryStartTime = Date.now();
          
          // Try service discovery with shorter timeout for retries
          const timeout = discoveryAttempts === 1 ? 15000 : 8000;
          
          // Clear basic Noble.js caches - but avoid internal structures
          console.log(chalk.gray(`    Clearing Noble.js caches safely...`));
          
          // Only clear the basic, safe cached data
          if (peripheral.services) {
            console.log(chalk.gray(`      Clearing cached services (${peripheral.services.length} found)`));
            peripheral.services = null;
          }
          
          // On first attempt, try with no service filter (discover all services)
          // This sometimes helps Noble.js properly initiate service discovery
          const serviceFilter = discoveryAttempts === 1 ? [] : [this.config.bleServiceUUID.replace(/-/g, '')];
          console.log(chalk.gray(`    Using service filter: ${serviceFilter.length === 0 ? 'none (discover all)' : serviceFilter.join(', ')}`));
          console.log(chalk.gray(`    Forcing fresh discovery (no cache)`));
          
          // Add a small delay to let Noble.js process the cache clearing
          await new Promise(resolve => setTimeout(resolve, 100));
          
          services = await this.promisify(peripheral.discoverServices.bind(peripheral), serviceFilter, timeout);
          
          const discoveryTime = Date.now() - discoveryStartTime;
          console.log(chalk.green(`✓ Service discovery completed in ${discoveryTime}ms`));
          this.bleLog(`✅ Service discovery completed in ${discoveryTime}ms`, 'success');
          
          break; // Success, exit retry loop
          
        } catch (error) {
          console.log(chalk.yellow(`⚠️ Service discovery attempt ${discoveryAttempts} failed: ${error.message}`));
          
          if (discoveryAttempts < maxDiscoveryAttempts) {
            console.log(chalk.gray(`  Waiting 1 second before retry...`));
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check if still connected
            if (peripheral.state !== 'connected') {
              throw new Error(`Peripheral disconnected during service discovery retries. State: ${peripheral.state}`);
            }
            
            // On the final attempt, force complete Noble.js reset
            if (discoveryAttempts === maxDiscoveryAttempts - 1) {
              console.log(chalk.gray(`  Final attempt: forcing complete Noble.js reset due to cache corruption...`));
              try {
                // Disconnect current peripheral first
                console.log(chalk.gray(`    Disconnecting current peripheral...`));
                await this.promisify(peripheral.disconnect.bind(peripheral), [], 5000);
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Force complete Noble.js reset to clear all corrupted cache
                await this.forceNobleReset();
                
                // The reset will start fresh scanning, so exit this connection attempt
                throw new Error('Noble.js reset completed - fresh connection will be attempted');
                
              } catch (resetError) {
                console.log(chalk.yellow(`    Noble.js reset failed: ${resetError.message}`));
                // Continue with the attempt anyway
              }
            }
          } else {
            throw new Error(`Service discovery failed after ${maxDiscoveryAttempts} attempts: ${error.message}`);
          }
        }
      }
      
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
        const serviceUUID = service.uuid.replace(/-/g, '').toLowerCase();
        console.log(chalk.gray(`    Comparing: ${service.uuid} === ${targetServiceUUID}`));
        return serviceUUID === targetServiceUUID;
      });
      
      if (!proxyService) {
        throw new Error(`Proxy service not found. Available services: ${services.map(s => s.uuid).join(', ')}`);
      }
      
      console.log(chalk.green(`✓ Found proxy service: ${proxyService.uuid}`));
      this.bleLog(`✓ Found proxy service: ${proxyService.uuid}`, 'success');
      
      // Also look for GAP service (1801) with Service Changed characteristic (2A05)
      // This is crucial for forcing iOS cache invalidation
      console.log(chalk.blue('🔍 Looking for GAP service (1801) with Service Changed characteristic...'));
      const gapService = services.find(service => {
        const serviceUUID = service.uuid.replace(/-/g, '').toLowerCase();
        return serviceUUID === '1801' || serviceUUID === '00001801' || service.uuid.toLowerCase().includes('1801');
      });
      
      if (gapService) {
        console.log(chalk.green(`✓ Found GAP service: ${gapService.uuid}`));
        this.bleLog(`✓ Found GAP service for cache invalidation`, 'success');
        
        try {
          // Discover characteristics in GAP service
          console.log(chalk.blue('🔍 Discovering GAP service characteristics...'));
          const gapCharacteristics = await this.promisify(gapService.discoverCharacteristics.bind(gapService), [], 10000);
          
          if (gapCharacteristics && gapCharacteristics.length > 0) {
            console.log(chalk.gray(`  Found ${gapCharacteristics.length} GAP characteristics:`));
            gapCharacteristics.forEach((char, index) => {
              console.log(chalk.gray(`    GAP Char ${index}: ${char.uuid} (properties: ${char.properties.join(', ')})`));
            });
            
            // Look for Service Changed characteristic (2A05)
            const serviceChangedChar = gapCharacteristics.find(char => {
              const charUUID = char.uuid.replace(/-/g, '').toLowerCase();
              return charUUID === '2a05' || charUUID === '00002a05' || char.uuid.toLowerCase().includes('2a05');
            });
            
            if (serviceChangedChar) {
              console.log(chalk.green(`✅ Found Service Changed characteristic: ${serviceChangedChar.uuid}`));
              this.bleLog(`✅ Found Service Changed characteristic - enabling cache invalidation`, 'success');
              
              // Subscribe to Service Changed characteristic
              // This will trigger iOS to send Service Changed indication and refresh cache
              console.log(chalk.blue('📡 Subscribing to Service Changed characteristic...'));
              await this.promisify(serviceChangedChar.subscribe.bind(serviceChangedChar), [], 5000);
              console.log(chalk.green('✅ Successfully subscribed to Service Changed characteristic'));
              this.bleLog('✅ Subscribed to Service Changed - iOS should refresh GATT cache now', 'success');
              
              // Set up notification handler
              serviceChangedChar.on('data', (data) => {
                console.log(chalk.green(`🔄 Service Changed indication received: ${data.toString('hex')}`));
                this.bleLog('🔄 Service Changed indication received - iOS cache refreshed', 'info');
              });
              
            } else {
              console.log(chalk.yellow('⚠️ Service Changed characteristic (2A05) not found in GAP service'));
              this.bleLog('⚠️ Service Changed characteristic not found - cache invalidation unavailable', 'warning');
            }
          } else {
            console.log(chalk.yellow('⚠️ No characteristics found in GAP service'));
          }
        } catch (gapError) {
          console.log(chalk.yellow(`⚠️ Failed to discover GAP service characteristics: ${gapError.message}`));
          this.bleLog(`⚠️ GAP service discovery failed: ${gapError.message}`, 'warning');
        }
      } else {
        console.log(chalk.yellow('⚠️ GAP service (1801) not found - Service Changed unavailable'));
        this.bleLog('⚠️ GAP service not found - cache invalidation unavailable', 'warning');
      }
      
      // Wait a moment before characteristic discovery
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check if we're still connected before characteristic discovery
      if (peripheral.state !== 'connected') {
        throw new Error(`Peripheral disconnected before characteristic discovery. State: ${peripheral.state}`);
      }
      
      // Discover characteristics with retry logic
      console.log(chalk.blue('Discovering characteristics...'));
      console.log(chalk.gray(`  Service UUID: ${proxyService.uuid}`));
      console.log(chalk.gray(`  Peripheral state: ${peripheral.state}`));
      
      let characteristics = null;
      let charDiscoveryAttempts = 0;
      const maxCharDiscoveryAttempts = 3;
      
      while (!characteristics && charDiscoveryAttempts < maxCharDiscoveryAttempts) {
        charDiscoveryAttempts++;
        console.log(chalk.gray(`  Characteristic discovery attempt ${charDiscoveryAttempts}/${maxCharDiscoveryAttempts}`));
        
        try {
          // Check connection state before each attempt
          if (peripheral.state !== 'connected') {
            throw new Error(`Peripheral disconnected before characteristic discovery. State: ${peripheral.state}`);
          }
          
          const charDiscoveryStartTime = Date.now();
          
          // Clear basic Noble.js caches for characteristics - but avoid internal structures
          console.log(chalk.gray(`    Clearing characteristic caches safely...`));
          
          // Only clear the basic, safe cached characteristic data
          if (proxyService.characteristics) {
            console.log(chalk.gray(`      Clearing cached characteristics (${proxyService.characteristics.length} found)`));
            proxyService.characteristics = null;
          }
          
          // Try characteristic discovery with shorter timeout for retries
          const timeout = charDiscoveryAttempts === 1 ? 10000 : 6000;
          console.log(chalk.gray(`    Using timeout: ${timeout}ms`));
          console.log(chalk.gray(`    Forcing fresh characteristic discovery (no cache)`));
          
          // Add a small delay to let Noble.js process the cache clearing
          await new Promise(resolve => setTimeout(resolve, 100));
          
          characteristics = await this.promisify(proxyService.discoverCharacteristics.bind(proxyService), [], timeout);
          
          const charDiscoveryTime = Date.now() - charDiscoveryStartTime;
          console.log(chalk.green(`✓ Characteristic discovery completed in ${charDiscoveryTime}ms`));
          
          break; // Success, exit retry loop
          
        } catch (error) {
          console.log(chalk.yellow(`⚠️ Characteristic discovery attempt ${charDiscoveryAttempts} failed: ${error.message}`));
          
          if (charDiscoveryAttempts < maxCharDiscoveryAttempts) {
            console.log(chalk.gray(`  Waiting 1 second before retry...`));
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check if still connected
            if (peripheral.state !== 'connected') {
              throw new Error(`Peripheral disconnected during characteristic discovery retries. State: ${peripheral.state}`);
            }
            
            // On the final attempt, force complete Noble.js reset
            if (charDiscoveryAttempts === maxCharDiscoveryAttempts - 1) {
              console.log(chalk.gray(`  Final attempt: forcing Noble.js reset for characteristic discovery...`));
              try {
                // Disconnect current peripheral first
                console.log(chalk.gray(`    Disconnecting peripheral for Noble.js reset...`));
                await this.promisify(peripheral.disconnect.bind(peripheral), [], 5000);
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Force complete Noble.js reset to clear all corrupted cache
                await this.forceNobleReset();
                
                // The reset will start fresh scanning, so exit this connection attempt
                throw new Error('Noble.js reset completed for characteristic discovery');
                
              } catch (resetError) {
                console.log(chalk.yellow(`    Characteristic discovery Noble.js reset failed: ${resetError.message}`));
                // Continue with the attempt anyway
              }
            }
          } else {
            throw new Error(`Characteristic discovery failed after ${maxCharDiscoveryAttempts} attempts: ${error.message}`);
          }
        }
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
      
      connectionInProgress = false;
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

  // Windows-specific BLE stack reset to clear cache corruption
  async resetWindowsBLEStack() {
    if (process.platform === 'win32') {
      console.log(chalk.blue('🔄 Resetting Windows BLE stack to clear cache...'));
      try {
        // Stop scanning first
        if (noble.state === 'poweredOn') {
          await new Promise(resolve => {
            noble.stopScanning();
            setTimeout(resolve, 1000);
          });
        }
        
        // Reset Noble
        noble.reset();
        
        // Wait for powered on state
        await new Promise((resolve) => {
          if (noble.state === 'poweredOn') {
            resolve();
          } else {
            noble.once('stateChange', (state) => {
              if (state === 'poweredOn') {
                resolve();
              }
            });
          }
        });
        
        console.log(chalk.green('✅ Windows BLE stack reset completed'));
        this.bleLog('✅ Windows BLE stack reset - cache cleared', 'success');
        
      } catch (error) {
        console.log(chalk.yellow(`⚠️ BLE stack reset failed: ${error.message}`));
        this.bleLog(`⚠️ BLE stack reset failed: ${error.message}`, 'warning');
      }
    }
  }
}

module.exports = BLEClient; 