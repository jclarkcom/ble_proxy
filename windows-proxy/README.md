# BLE HTTP Proxy - Windows Client

A Node.js HTTP proxy that routes browser traffic through Bluetooth Low Energy (BLE) to an iOS companion app.

## Features

- **HTTP/HTTPS Proxy**: Acts as a local proxy server for web browsers
- **BLE Central**: Connects to iOS device acting as BLE peripheral  
- **Data Compression**: Gzips data for efficient BLE transfer
- **Automatic Reconnection**: Handles BLE connection drops gracefully
- **Chunked Data Transfer**: Manages BLE packet size limitations

## Prerequisites

### System Requirements
- **Windows 10/11** with BLE support
- **Node.js 14+**
- **Bluetooth adapter** that supports BLE Central mode

### Windows BLE Setup
1. Ensure Bluetooth is enabled in Windows settings
2. Install Visual C++ Build Tools (required for native BLE modules):
   ```bash
   npm install -g windows-build-tools
   ```

## Installation

1. Navigate to the windows-proxy directory:
   ```bash
   cd windows-proxy
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Starting the Proxy

```bash
npm start
```

The proxy will:
1. Initialize BLE adapter
2. Start scanning for iOS BLE Proxy device
3. Start HTTP proxy server on `127.0.0.1:8080`

### Browser Configuration

Configure your browser to use the HTTP proxy:

**Chrome/Edge:**
- Settings → Advanced → System → Open proxy settings
- HTTP Proxy: `127.0.0.1:8080`
- HTTPS Proxy: `127.0.0.1:8080`

**Firefox:**  
- Settings → Network Settings → Manual proxy configuration
- HTTP Proxy: `127.0.0.1` Port: `8080`
- HTTPS Proxy: `127.0.0.1` Port: `8080`

### Connection Flow

1. **Start Proxy**: Run `npm start`
2. **Wait for BLE**: Proxy will scan for iOS device
3. **iOS Connection**: iOS app should be running and advertising
4. **Browser Setup**: Configure browser proxy settings
5. **Browse**: All traffic will route through iOS device

## Configuration

The proxy can be configured by editing the config in `proxy.js`:

```javascript
const proxy = new BLEProxy({
  proxyPort: 8080,           // Local proxy port
  proxyHost: '127.0.0.1',    // Local proxy host
  bleServiceUUID: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
  requestCharUUID: 'a1b2c3d4-e5f6-7890-1234-567890abcd01',
  responseCharUUID: 'a1b2c3d4-e5f6-7890-1234-567890abcd02'
});
```

## Troubleshooting

### BLE Issues
- **"BLE not supported"**: Install Windows BLE drivers
- **Scanning timeout**: Ensure iOS app is running and advertising
- **Connection drops**: Check Bluetooth interference

### Proxy Issues  
- **503 Service Unavailable**: BLE device not connected
- **Browser not loading**: Check proxy configuration
- **Timeout errors**: Check iOS app network connectivity

### Development/Debug

Run with debug logging:
```bash
npm run dev
```

## Architecture

```
Browser → HTTP Proxy (127.0.0.1:8080) → BLE Client → iOS BLE Peripheral → WiFi → Internet
```

### Data Flow
1. Browser sends HTTP request to proxy
2. Proxy compresses request with gzip
3. Request sent via BLE in chunks to iOS
4. iOS decompresses, makes real HTTP request
5. iOS compresses response, sends back via BLE
6. Proxy decompresses, returns to browser

## Status Indicators

- 🔍 **Blue**: Scanning for iOS device
- ✅ **Green**: Connected and ready
- ⚠️ **Yellow**: Connection lost, reconnecting  
- ❌ **Red**: Error occurred

## Performance Notes

- BLE has ~20-byte packet limits, large requests are chunked
- Gzip compression typically reduces HTTP data by 60-80%
- Connection latency adds ~100-200ms per request
- Optimal for text-heavy content (HTML, JSON, CSS) 