# Mock iOS BLE Service

A Node.js service that simulates the iOS BLE peripheral app using TCP sockets. This allows complete end-to-end testing of the BLE proxy system without needing an actual iOS device.

## Purpose

This mock service replicates the behavior of the iOS BLE peripheral app by:
- Acting as a TCP server instead of BLE peripheral
- Receiving compressed HTTP requests from the Windows proxy
- Making actual HTTP requests to the internet
- Sending compressed responses back to the proxy

## Features

- **TCP Socket Server**: Listens for connections from Windows proxy
- **HTTP Client**: Makes real internet requests with full redirect support
- **Data Compression**: Gzip compression/decompression matching iOS app
- **Connection Management**: Handles multiple concurrent connections
- **Request Statistics**: Tracks requests, responses, and errors
- **Automatic Reconnection**: Handles connection drops gracefully

## Installation

1. Navigate to the mock-ios-service directory:
   ```bash
   cd mock-ios-service
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Starting the Mock Service

```bash
npm start
```

The service will start listening on `127.0.0.1:9999` by default.

### Demo Mode

```bash
npm run demo
```

This starts the service with enhanced logging and helpful instructions.

## Integration with Windows Proxy

### Step 1: Start Mock iOS Service
```bash
cd mock-ios-service
npm start
```

### Step 2: Start Windows Proxy in Mock Mode
```bash
cd ../windows-proxy
npm run mock
```

### Step 3: Configure Browser
- Set HTTP proxy to `127.0.0.1:8080`
- Browse normally - traffic routes through mock service

## Configuration

Default configuration can be overridden in the constructor:

```javascript
const mockService = new MockIOSService({
  port: 9999,           // TCP port to listen on
  host: '127.0.0.1',    // Interface to bind to
  timeout: 30000,       // Request timeout (ms)
  maxConnections: 10    // Max simultaneous connections
});
```

### Environment Variables

- `MOCK_SERVICE_HOST`: Override listening host (default: 127.0.0.1)
- `MOCK_SERVICE_PORT`: Override listening port (default: 9999)

## Architecture

```
Windows Proxy → TCP Socket → Mock iOS Service → HTTP/HTTPS → Internet
             ← TCP Socket ←                  ← HTTP/HTTPS ←
```

### Data Flow

1. **Windows Proxy** compresses HTTP request and sends via TCP
2. **Mock Service** receives, decompresses request
3. **HTTP Client** makes actual internet request
4. **Mock Service** compresses response and sends back via TCP
5. **Windows Proxy** decompresses and returns to browser

## Protocol Details

### Message Format
```
[4-byte length header][compressed data]
```

- **Length Header**: Little-endian uint32 indicating compressed data size
- **Compressed Data**: Gzip-compressed JSON containing request/response

### Request JSON Structure
```javascript
{
  id: "uuid",           // Unique request identifier
  method: "GET",        // HTTP method
  url: "https://...",   // Full URL
  headers: {},          // HTTP headers
  body: "base64...",    // Base64-encoded request body
  isConnect: false      // True for HTTPS CONNECT requests
}
```

### Response JSON Structure
```javascript
{
  id: "uuid",           // Matching request ID
  statusCode: 200,      // HTTP status code
  statusMessage: "OK",  // HTTP status message
  headers: {},          // Response headers
  body: "base64...",    // Base64-encoded response body
  isConnect: false,     // True for CONNECT responses
  success: true         // CONNECT success flag
}
```

## Development

### Stats and Monitoring

The service provides built-in statistics:

```bash
# Print current stats (send SIGUSR1)
kill -USR1 <pid>
```

Stats include:
- Uptime
- Total/active connections
- Request/response/error counts
- Per-connection details

### Debugging

Enable debug logging:
```bash
NODE_ENV=development npm start
```

## Troubleshooting

### Common Issues

**Port already in use:**
```bash
# Find process using port 9999
netstat -ano | findstr :9999
# Kill the process
taskkill /PID <pid> /F
```

**Connection refused:**
- Ensure mock service is running before starting Windows proxy
- Check Windows firewall settings

**Request timeout:**
- Check internet connectivity
- Verify target URLs are accessible
- Increase timeout in configuration

### Testing Connectivity

Test the mock service directly:
```bash
# Test TCP connection
telnet 127.0.0.1 9999
```

## Performance Notes

- **Compression**: Reduces data transfer by 60-80% typically
- **Concurrent Requests**: Supports multiple simultaneous requests
- **Memory Usage**: Minimal - only buffers data during processing
- **Latency**: Adds ~10-50ms overhead compared to direct requests

## Comparison with Real iOS App

| Feature | Mock Service | Real iOS App |
|---------|-------------|--------------|
| Transport | TCP Sockets | BLE |
| Data Compression | ✅ Gzip | ✅ Gzip |
| HTTP Client | ✅ Full HTTP/HTTPS | ✅ URLSession |
| Concurrent Requests | ✅ Multiple | ✅ Multiple |
| Error Handling | ✅ Complete | ✅ Complete |
| Reconnection | ✅ Automatic | ✅ BLE reconnect |
| Background Processing | N/A | ✅ Silent audio |

The mock service provides identical functionality to the iOS app for testing purposes. 