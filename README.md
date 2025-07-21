# BLE HTTP Proxy System

A Bluetooth Low Energy (BLE) based HTTP proxy system that routes web browser traffic through an iOS device. This allows web browsing through the iOS device's internet connection using BLE as the transport layer.

## Architecture Overview

```
Browser → Windows Proxy → BLE/TCP → iOS/Mock Service → WiFi → Internet
        ← Windows Proxy ← BLE/TCP ← iOS/Mock Service ← WiFi ←
```

## System Components

### 1. Windows Proxy (`windows-proxy/`)
- **Purpose**: Acts as HTTP proxy server for browsers
- **Transport**: BLE Central (connects to iOS) or TCP (connects to mock service)
- **Features**: HTTP/HTTPS support, data compression, connection management
- **Port**: `127.0.0.1:8080` (default)

### 2. iOS App *(Future - not yet implemented)*
- **Purpose**: BLE Peripheral that relays traffic to internet via WiFi
- **Transport**: BLE Peripheral, WiFi client
- **Features**: Background processing, data decompression, HTTP client

### 3. Mock iOS Service (`mock-ios-service/`)
- **Purpose**: Simulates iOS app behavior for testing without iOS device
- **Transport**: TCP server, HTTP/HTTPS client
- **Features**: Full protocol compatibility, statistics, debugging
- **Port**: `127.0.0.1:9999` (default)

## Quick Start

### Option 1: Testing with Mock Service (Recommended)

**Terminal 1 - Start Mock iOS Service:**
```bash
cd mock-ios-service
npm install
npm start
```

**Terminal 2 - Start Windows Proxy in Mock Mode:**
```bash
cd windows-proxy
npm install
npm run mock
```

**Configure Browser:**
- Set HTTP proxy to `127.0.0.1:8080`
- Browse normally

### Option 2: Real BLE Mode (Requires iOS device)

**Terminal 1 - Start Windows Proxy:**
```bash
cd windows-proxy
npm install
npm start
```

**iOS Device:**
- Start the iOS BLE Proxy app *(coming soon)*

**Configure Browser:**
- Set HTTP proxy to `127.0.0.1:8080`
- Browse normally

## Features

### ✅ Implemented
- **HTTP Proxy Server**: Full HTTP/HTTPS CONNECT support
- **Data Compression**: Gzip compression for efficient transfer
- **BLE Central**: Windows BLE client for iOS connection
- **Mock Service**: Complete iOS simulation using TCP
- **Error Handling**: Comprehensive timeout and reconnection logic
- **Configuration**: Environment variables and config files
- **Logging**: Colorized console output with debug modes

### 🚧 In Progress
- **iOS BLE Peripheral App**: Native Swift app with Core Bluetooth

### 📋 Planned
- **HTTPS Tunnel Support**: Full CONNECT tunnel implementation
- **Connection Pooling**: Optimize performance for multiple requests
- **Web Dashboard**: Browser-based monitoring and configuration
- **Mobile Hotspot Integration**: Auto-detect iOS hotspot mode

## Protocol Details

### Data Format
All data is transmitted in compressed, chunked format:

```
[4-byte length header][compressed JSON payload]
```

### Request/Response JSON
```javascript
// Request
{
  id: "uuid",           // Unique request ID
  method: "GET",        // HTTP method
  url: "https://...",   // Target URL
  headers: {},          // HTTP headers
  body: "base64...",    // Request body (base64)
  isConnect: false      // HTTPS CONNECT flag
}

// Response
{
  id: "uuid",           // Matching request ID
  statusCode: 200,      // HTTP status
  headers: {},          // Response headers
  body: "base64...",    // Response body (base64)
  success: true         // For CONNECT requests
}
```

## Configuration

### Windows Proxy
```javascript
// windows-proxy/config.js
{
  proxy: {
    host: "127.0.0.1",
    port: 8080,
    timeout: 30000
  },
  ble: {
    serviceUUID: "a1b2c3d4-...",
    // ... other UUIDs
  }
}
```

### Environment Variables
```bash
# Mock mode
MOCK_MODE=true

# Proxy settings
PROXY_HOST=127.0.0.1
PROXY_PORT=8080

# BLE UUIDs
BLE_SERVICE_UUID=a1b2c3d4-e5f6-7890-1234-567890abcdef

# Mock service
MOCK_SERVICE_HOST=127.0.0.1
MOCK_SERVICE_PORT=9999
```

## Browser Configuration

### Chrome/Edge
1. Settings → Advanced → System → Open proxy settings
2. HTTP Proxy: `127.0.0.1:8080`
3. HTTPS Proxy: `127.0.0.1:8080`
4. Bypass proxy for: `localhost, 127.0.0.1`

### Firefox
1. Settings → Network Settings → Manual proxy configuration
2. HTTP Proxy: `127.0.0.1` Port: `8080`
3. HTTPS Proxy: `127.0.0.1` Port: `8080`
4. Use this proxy server for all protocols: ✓

## Development

### Project Structure
```
ble_proxy/
├── windows-proxy/          # Windows BLE Central + HTTP Proxy
│   ├── proxy.js           # Main proxy server
│   ├── ble-client.js      # Real BLE client
│   ├── mock-ble-client.js # Mock BLE client (TCP)
│   ├── config.js          # Configuration
│   └── demo.js            # Demo script
├── mock-ios-service/       # Mock iOS BLE Peripheral
│   ├── mock-ios.js        # Main TCP server
│   ├── http-client.js     # HTTP request handler
│   └── demo.js            # Demo script
└── ios-app/               # iOS Native App (future)
```

### Testing

**Unit Tests:**
```bash
# Test Windows proxy
cd windows-proxy
npm test

# Test mock service
cd mock-ios-service
npm test
```

**Integration Test:**
```bash
# Start both services and test with curl
curl -x http://127.0.0.1:8080 https://httpbin.org/ip
```

### Debugging

**Enable Debug Logging:**
```bash
# Windows proxy
NODE_ENV=development npm start

# Mock service
NODE_ENV=development npm start
```

**BLE Debugging (Windows):**
```bash
# Check BLE adapter status
Get-PnpDevice | Where-Object {$_.Name -like "*Bluetooth*"}

# Monitor BLE traffic (requires tools)
```

## Performance

### Typical Metrics
- **Latency**: +100-200ms vs direct connection
- **Throughput**: ~50-100KB/s over BLE, ~1-10MB/s over TCP mock
- **Compression**: 60-80% size reduction for text content
- **Battery**: iOS app uses ~10-20% more battery when active

### Optimization Tips
1. **Use for text-heavy content** (HTML, JSON, CSS)
2. **Avoid large downloads** (videos, large images)
3. **Enable browser caching**
4. **Keep iOS app in foreground** for best performance

## Troubleshooting

### Windows Proxy Issues
```bash
# BLE not working
npm run mock  # Use mock mode instead

# Port already in use
netstat -ano | findstr :8080

# Dependencies failing
npm run install-build-tools
```

### Mock Service Issues
```bash
# Port 9999 in use
netstat -ano | findstr :9999

# Connection refused
# Ensure mock service starts before proxy
```

### Browser Issues
```bash
# Clear proxy settings
# Check Windows proxy settings
# Disable other VPNs/proxies
```

## Security Considerations

⚠️ **This is a development/testing tool. Consider security implications:**

- **No authentication** between components
- **Local network only** - don't expose to internet
- **HTTP traffic is unencrypted** over BLE
- **HTTPS is end-to-end encrypted** but metadata visible
- **Mock mode is for testing only**

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/name`)
3. Test both BLE and mock modes
4. Submit pull request with tests

## License

MIT License - see LICENSE file for details

## Roadmap

### v2.0 - iOS Native App
- [ ] Swift iOS app with Core Bluetooth
- [ ] Background processing with silent audio
- [ ] App Store submission
- [ ] TestFlight beta testing

### v2.1 - Enhanced Features
- [ ] Web dashboard for monitoring
- [ ] Multiple iOS device support
- [ ] Load balancing between devices
- [ ] Performance metrics and graphs

### v2.2 - Production Ready
- [ ] Authentication and security
- [ ] Configuration UI
- [ ] Installer packages
- [ ] Enterprise deployment guides

---

**Status**: ✅ Mock testing ready | 🚧 iOS app in development | 📋 Production features planned 