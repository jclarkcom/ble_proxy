# BLE Proxy - iOS App

A native iOS app that acts as a Bluetooth Low Energy (BLE) peripheral to provide HTTP proxy services to Windows clients, allowing web browsing through the iOS device's internet connection.

## Features

- **BLE Peripheral**: Acts as BLE server advertising proxy services
- **HTTP Client**: Makes real internet requests via WiFi
- **Background Processing**: Stays active using silent audio playback
- **Data Compression**: Optimizes data transfer over BLE
- **Modern UI**: SwiftUI interface with real-time statistics
- **TestFlight Ready**: Automated deployment via GitHub Actions

## Architecture

```
Windows Client → BLE → iOS App → WiFi → Internet
              ← BLE ←         ← WiFi ←
```

## Prerequisites

### Development Requirements
- **Xcode 15.0+**
- **iOS 15.0+** target deployment
- **Apple Developer Account** (for TestFlight deployment)
- **macOS Monterey+** (for building)

### Device Requirements
- **iPhone/iPad** with iOS 15.0+
- **Bluetooth LE support** (all modern iOS devices)
- **WiFi connection** for internet access

## Project Structure

```
ios-app/
├── BLEProxy.xcodeproj/          # Xcode project
├── BLEProxy/                    # Source code
│   ├── BLEProxyApp.swift       # Main app entry point
│   ├── ContentView.swift       # SwiftUI main interface
│   ├── ProxyViewModel.swift    # Main coordinator/view model
│   ├── BLEPeripheralManager.swift  # Core Bluetooth peripheral
│   ├── HTTPClient.swift        # HTTP request handling
│   ├── BackgroundAudioManager.swift  # Silent audio for background
│   ├── Info.plist             # App configuration
│   └── Assets.xcassets/       # App icons and resources
└── README.md                   # This file
```

## Local Development

### 1. Open in Xcode
```bash
cd ios-app
open BLEProxy.xcodeproj
```

### 2. Configure Bundle Identifier
Update the bundle identifier in:
- Project settings → General → Bundle Identifier
- Change from `com.bleproxy.app` to your unique identifier

### 3. Configure Signing
- Project settings → Signing & Capabilities
- Select your development team
- Ensure automatic signing is enabled for development

### 4. Run on Device
- Connect iOS device via USB
- Select device in Xcode
- Build and run (⌘+R)

**Note**: BLE peripheral functionality requires a physical device (doesn't work in simulator)

## TestFlight Deployment via GitHub Actions

### Required GitHub Secrets

Set up the following secrets in your GitHub repository:

#### Code Signing Secrets

**`BUILD_CERTIFICATE_BASE64`**
```bash
# Export your distribution certificate as .p12 file
# Convert to base64:
base64 -i YourCertificate.p12 | pbcopy
```

**`P12_PASSWORD`**
```
# Password for your .p12 certificate file
```

**`PROVISIONING_PROFILE_BASE64`**
```bash
# Download your App Store provisioning profile (.mobileprovision)
# Convert to base64:
base64 -i YourProfile.mobileprovision | pbcopy
```

**`PROVISIONING_PROFILE_NAME`**
```
# Exact name of your provisioning profile (as shown in Apple Developer)
```

**`DEVELOPMENT_TEAM_ID`**
```
# Your Apple Developer Team ID (10 character string)
```

**`KEYCHAIN_PASSWORD`**
```
# Any secure password for temporary keychain (e.g., generated UUID)
```

#### App Store Connect API Secrets

**`APP_STORE_CONNECT_API_KEY_ID`**
```
# Key ID from App Store Connect API key (8-10 characters)
```

**`APP_STORE_CONNECT_API_ISSUER_ID`**
```
# Issuer ID from App Store Connect (UUID format)
```

**`APP_STORE_CONNECT_API_KEY`**
```bash
# Download .p8 file from App Store Connect
# Convert to base64:
base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
```

**`EXPORT_OPTIONS_PLIST`**
```bash
# Create exportOptions.plist:
cat > exportOptions.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>YOUR_TEAM_ID</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
EOF

# Convert to base64:
base64 -i exportOptions.plist | pbcopy
```

### Setting Up App Store Connect

1. **Create App Record**
   - Log into [App Store Connect](https://appstoreconnect.apple.com)
   - Apps → + → New App
   - Fill in app details, bundle ID, etc.

2. **Create API Key**
   - Users and Access → Keys → App Store Connect API
   - Generate new API key with Developer access
   - Download the .p8 file and note the Key ID and Issuer ID

3. **Create Provisioning Profile**
   - [Apple Developer Portal](https://developer.apple.com)
   - Certificates, Identifiers & Profiles → Profiles
   - Create App Store provisioning profile for your app

### Deployment Workflow

The GitHub Actions workflow automatically:

1. **Builds** the iOS app in Release configuration
2. **Signs** with distribution certificate and provisioning profile  
3. **Exports** IPA file ready for App Store
4. **Uploads** to TestFlight automatically on main branch pushes
5. **Manages** certificates and cleanup securely

### Manual Deployment

To manually trigger TestFlight deployment:

1. Go to your GitHub repository
2. Actions → iOS TestFlight Deployment
3. Run workflow → Check "Deploy to TestFlight"
4. Run workflow

### Monitoring Deployment

- Check GitHub Actions logs for build status
- Monitor App Store Connect for TestFlight processing
- TestFlight builds typically process within 10-30 minutes

## App Configuration

### Bluetooth Settings

The app uses these BLE identifiers (configurable in code):

```swift
Service UUID: A1B2C3D4-E5F6-7890-1234-567890ABCDEF
Request Char: A1B2C3D4-E5F6-7890-1234-567890ABCD01
Response Char: A1B2C3D4-E5F6-7890-1234-567890ABCD02
Control Char: A1B2C3D4-E5F6-7890-1234-567890ABCD03
Device Name: "BLE-Proxy"
```

### Permissions

The app requires these permissions (configured in Info.plist):

- **Bluetooth**: For BLE peripheral functionality
- **Background Audio**: For staying active when backgrounded
- **Network**: For making HTTP requests

### Background Modes

Enabled background modes:
- `audio` - Silent audio playback
- `bluetooth-peripheral` - BLE peripheral services
- `background-processing` - Request processing

## Usage

### 1. Start the iOS App
- Launch "BLE Proxy" on iOS device
- Tap "Start Proxy" 
- Grant Bluetooth permissions when prompted
- App will start advertising BLE services

### 2. Connect Windows Client
- Run the Windows Node.js proxy client
- It will automatically discover and connect to iOS device
- Connection status shown in both apps

### 3. Configure Browser
- Set browser proxy to `127.0.0.1:8080`
- Browse normally - traffic routes through iOS device

## Troubleshooting

### Build Issues

**"Code signing error"**
- Verify all certificates and provisioning profiles are valid
- Check bundle identifier matches provisioning profile
- Ensure development team is selected

**"BLE not working in simulator"**
- BLE peripheral requires physical device
- Always test on actual iPhone/iPad

### Runtime Issues

**"Bluetooth permission denied"**
- iOS Settings → BLE Proxy → Bluetooth → Enable
- Restart app after enabling permission

**"App stops working in background"**
- Ensure silent audio is playing (check app UI)
- iOS Settings → BLE Proxy → Background App Refresh → Enable
- Keep app in foreground for best performance

**"Connection drops frequently"**
- Keep devices within 10 meters
- Avoid Bluetooth interference (WiFi, other devices)
- Restart both iOS app and Windows client

### TestFlight Issues

**"Upload failed"**
- Verify all GitHub secrets are correct
- Check App Store Connect API key permissions
- Ensure bundle ID matches App Store record

**"Build not appearing in TestFlight"**
- Wait 10-30 minutes for Apple processing
- Check for email notifications about issues
- Review App Store Connect build status

## Performance

### Battery Usage
- **Active use**: ~10-20% additional battery drain
- **Background**: Silent audio uses minimal power
- **Recommendation**: Keep device plugged in for extended sessions

### Data Transfer
- **BLE throughput**: ~10-50 KB/s (varies by device/distance)
- **Compression**: 60-80% size reduction typical
- **Range**: ~10 meters optimal, up to 30 meters possible

### Optimization Tips
- Keep devices close together
- Use for text-heavy content (HTML, JSON)
- Avoid large downloads (images, videos)
- Monitor statistics in app for performance insights

## Security Considerations

⚠️ **This is a development/testing tool**

- HTTP traffic is visible to iOS app
- HTTPS is end-to-end encrypted but metadata visible
- No authentication between Windows and iOS
- Use only on trusted networks
- Not intended for production environments

## Support

For issues and questions:

1. Check troubleshooting section above
2. Review GitHub Actions logs for deployment issues
3. Check iOS device console logs for runtime issues
4. Verify all prerequisites are met

## License

MIT License - see main project LICENSE file. #   B L E   P r o x y   A p p   -   R e a d y   f o r   T e s t F l i g h t  
 