const config = {
  // HTTP Proxy Settings
  proxy: {
    host: process.env.PROXY_HOST || '127.0.0.1',
    port: parseInt(process.env.PROXY_PORT) || 8080,
    timeout: 30000, // 30 seconds
    maxConcurrentRequests: 50
  },

  // BLE Settings  
  ble: {
    serviceUUID: process.env.BLE_SERVICE_UUID || 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
    requestCharUUID: process.env.BLE_REQUEST_CHAR_UUID || 'a1b2c3d4-e5f6-7890-1234-567890abcd01', 
    responseCharUUID: process.env.BLE_RESPONSE_CHAR_UUID || 'a1b2c3d4-e5f6-7890-1234-567890abcd02',
    controlCharUUID: process.env.BLE_CONTROL_CHAR_UUID || 'a1b2c3d4-e5f6-7890-1234-567890abcd03',
    
    // Connection settings
    scanTimeout: 30000, // 30 seconds
    connectTimeout: 15000, // 15 seconds
    reconnectDelay: 3000, // 3 seconds
    maxReconnectAttempts: 5,
    
    // Data transfer settings
    maxChunkSize: 20, // BLE characteristic limit
    chunkDelay: 10, // ms between chunks
    responseTimeout: 30000 // 30 seconds
  },

  // Compression settings
  compression: {
    level: 6, // gzip compression level (1-9)
    threshold: 100 // minimum bytes to compress
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
    colors: true,
    timestamps: true
  },

  // Development/Debug
  debug: {
    enabled: process.env.NODE_ENV === 'development',
    logBLEData: false, // Log raw BLE data (verbose)
    logHTTPRequests: true, // Log HTTP request details
    skipCompression: false // Skip compression for debugging
  }
};

module.exports = config; 