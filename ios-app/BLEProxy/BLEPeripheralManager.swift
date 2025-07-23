import Foundation
import CoreBluetooth
import Compression
import os.log
import SwiftUI

protocol BLEPeripheralManagerDelegate: AnyObject {
    func peripheralManager(_ manager: BLEPeripheralManager, didReceiveRequest data: Data)
    func peripheralManagerDidStartAdvertising(_ manager: BLEPeripheralManager)
    func peripheralManagerDidStopAdvertising(_ manager: BLEPeripheralManager)
    func peripheralManager(_ manager: BLEPeripheralManager, didConnect central: CBCentral)
    func peripheralManager(_ manager: BLEPeripheralManager, didDisconnect central: CBCentral)
    func peripheralManager(_ manager: BLEPeripheralManager, didGenerateLog message: String, level: DebugLogEntry.LogLevel)
}

class BLEPeripheralManager: NSObject, ObservableObject {
    // MARK: - Published Properties
    @Published var isAdvertising = false
    @Published var isConnected = false
    @Published var connectionCount = 0
    @Published var requestCount = 0
    @Published var responseCount = 0
    @Published var lastError: String?
    
    // MARK: - BLE Configuration
    // Service and characteristic UUIDs
    private let serviceUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCDEF")
    private let requestCharacteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCD01")
    private let responseCharacteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCD02")
    private let controlCharacteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCD03")
    
    // Generic Attribute Profile (GAP) service and Service Changed characteristic
    // This forces iOS clients to refresh their GATT cache
    private let gapServiceUUID = CBUUID(string: "1801") // Generic Attribute Profile
    private let serviceChangedCharacteristicUUID = CBUUID(string: "2A05") // Service Changed
    
    // Characteristics and services
    private var requestCharacteristic: CBMutableCharacteristic!
    private var responseCharacteristic: CBMutableCharacteristic!
    private var controlCharacteristic: CBMutableCharacteristic!
    private var serviceChangedCharacteristic: CBMutableCharacteristic!
    private var proxyService: CBMutableService!
    private var gapService: CBMutableService!
    
    // MARK: - Core Bluetooth
    private var peripheralManager: CBPeripheralManager!
    
    // MARK: - Data Management
    private var connectedCentrals: Set<CBCentral> = []
    private var receivingData: [CBCentral: ReceivingData] = [:]
    private var pendingResponses: [CBCentral: [Data]] = [:]
    
    // Public getter for connected centrals
    var connectedClients: Set<CBCentral> {
        return connectedCentrals
    }
    
    // MARK: - Delegate
    weak var delegate: BLEPeripheralManagerDelegate?
    
    // MARK: - Logging
    private let logger = Logger(subsystem: "com.bleproxy.app", category: "BLEPeripheral")
    
    // Helper method to send logs to both system logger and UI
    private func uiLog(_ message: String, level: DebugLogEntry.LogLevel = .info) {
        // Send to UI via delegate
        DispatchQueue.main.async {
            self.delegate?.peripheralManager(self, didGenerateLog: message, level: level)
        }
        
        // Also log to system logger for Xcode console
        switch level {
        case .error:
            logger.error("\(message)")
        case .warning:
            logger.info("⚠️ \(message)")
        case .success:
            logger.info("✅ \(message)")
        case .info:
            logger.info("\(message)")
        }
    }
    
    // MARK: - Data Structures
    private struct ReceivingData {
        var expectedLength: UInt32 = 0
        var receivedLength: UInt32 = 0
        var chunks: [Data] = []
        var isReceiving = false
    }
    
    override init() {
        super.init()
        setupPeripheralManager()
    }
    
    // MARK: - Setup
    private func setupPeripheralManager() {
        uiLog("🚀 Initializing BLE Peripheral Manager...", level: .info)
        uiLog("📋 Service UUID will be: \(self.serviceUUID.uuidString)", level: .info)
        uiLog("📋 Request characteristic: \(self.requestCharacteristicUUID.uuidString)", level: .info)
        uiLog("📋 Response characteristic: \(self.responseCharacteristicUUID.uuidString)", level: .info)
        uiLog("📋 Control characteristic: \(self.controlCharacteristicUUID.uuidString)", level: .info)
        
        peripheralManager = CBPeripheralManager(delegate: self, queue: DispatchQueue.global(qos: .userInitiated))
        
        uiLog("✅ BLE Peripheral Manager created", level: .success)
        uiLog("⏳ Waiting for Bluetooth state change...", level: .info)
    }
    
    private func setupService() {
        uiLog("🔧 Setting up BLE service and characteristics...", level: .info)
        uiLog("🆔 Service UUID: \(self.serviceUUID.uuidString)", level: .info)
        
        // Create main proxy service characteristics
        uiLog("📝 Creating REQUEST characteristic...", level: .info)
        requestCharacteristic = CBMutableCharacteristic(
            type: requestCharacteristicUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        uiLog("  • UUID: \(self.requestCharacteristicUUID.uuidString)", level: .info)
        uiLog("  • Properties: write, writeWithoutResponse", level: .info)
        
        uiLog("📝 Creating RESPONSE characteristic...", level: .info)
        responseCharacteristic = CBMutableCharacteristic(
            type: responseCharacteristicUUID,
            properties: [.notify, .read],
            value: nil,
            permissions: [.readable]
        )
        uiLog("  • UUID: \(self.responseCharacteristicUUID.uuidString)", level: .info)
        uiLog("  • Properties: notify, read", level: .info)
        
        uiLog("📝 Creating CONTROL characteristic...", level: .info)
        controlCharacteristic = CBMutableCharacteristic(
            type: controlCharacteristicUUID,
            properties: [.read, .write, .notify],
            value: nil,
            permissions: [.readable, .writeable]
        )
        uiLog("  • UUID: \(self.controlCharacteristicUUID.uuidString)", level: .info)
        uiLog("  • Properties: read, write, notify", level: .info)
        
        // Create Service Changed characteristic for cache invalidation
        uiLog("📝 Creating SERVICE CHANGED characteristic (for cache invalidation)...", level: .info)
        serviceChangedCharacteristic = CBMutableCharacteristic(
            type: serviceChangedCharacteristicUUID,
            properties: [.indicate],
            value: nil,
            permissions: []
        )
        uiLog("  • UUID: \(self.serviceChangedCharacteristicUUID.uuidString)", level: .info)
        uiLog("  • Properties: indicate (forces iOS cache refresh)", level: .info)
        
        // Create main proxy service
        uiLog("🏗️ Creating main BLE proxy service...", level: .info)
        proxyService = CBMutableService(type: serviceUUID, primary: true)
        proxyService.characteristics = [
            requestCharacteristic,
            responseCharacteristic,
            controlCharacteristic
        ]
        
        // Create Generic Attribute Profile (GAP) service
        uiLog("🏗️ Creating GAP service (Generic Attribute Profile)...", level: .info)
        gapService = CBMutableService(type: gapServiceUUID, primary: true)
        gapService.characteristics = [
            serviceChangedCharacteristic
        ]
        
        uiLog("✅ Main service created with \(self.proxyService.characteristics?.count ?? 0) characteristics", level: .success)
        uiLog("✅ GAP service created with Service Changed characteristic", level: .success)
        
        // Add both services
        uiLog("➕ Adding main proxy service to peripheral manager...", level: .info)
        peripheralManager.add(proxyService)
        
        uiLog("➕ Adding GAP service to peripheral manager...", level: .info)
        peripheralManager.add(gapService)
        
        uiLog("✅ BLE services and characteristics setup completed", level: .success)
        uiLog("🔄 Service Changed characteristic will force iOS cache refresh", level: .info)
    }
    
    // MARK: - Public Methods
    func startAdvertising() {
        guard peripheralManager.state == .poweredOn else {
            uiLog("Cannot start advertising - Bluetooth not powered on", level: .error)
            lastError = "Bluetooth not available"
            return
        }
        
        uiLog("🚀 Starting BLE advertisement...", level: .info)
        uiLog("📡 Service UUID to advertise: \(self.serviceUUID.uuidString)", level: .info)
        uiLog("🏷️ Device name: BLE-Proxy", level: .info)
        
        let advertisementData: [String: Any] = [
            CBAdvertisementDataServiceUUIDs: [serviceUUID, gapServiceUUID],
            CBAdvertisementDataLocalNameKey: "BLE-Proxy"
        ]
        
        // Log the advertisement data being sent
        uiLog("📋 Advertisement data:", level: .info)
        uiLog("  • Services: [\(self.serviceUUID.uuidString), \(self.gapServiceUUID.uuidString)]", level: .info)
        uiLog("  • Local Name: BLE-Proxy", level: .info)
        
        peripheralManager.startAdvertising(advertisementData)
    }
    
    func stopAdvertising() {
        uiLog("🛑 Stopping BLE advertisement...", level: .info)
        peripheralManager.stopAdvertising()
        uiLog("✅ Advertisement stopped", level: .success)
    }
    
    // Force iOS clients to refresh their GATT cache
    func triggerServiceChanged() {
        guard peripheralManager.state == .poweredOn else {
            uiLog("Cannot trigger Service Changed - Bluetooth not powered on", level: .warning)
            return
        }
        
        uiLog("🔄 Triggering Service Changed indication to refresh iOS cache...", level: .info)
        
        // Create indication data (start handle: 0x0001, end handle: 0xFFFF)
        // This indicates that all services may have changed
        let serviceChangedData = Data([0x01, 0x00, 0xFF, 0xFF])
        
        // Send indication to all subscribed centrals
        let success = peripheralManager.updateValue(
            serviceChangedData,
            for: serviceChangedCharacteristic,
            onSubscribedCentrals: nil
        )
        
        if success {
            uiLog("✅ Service Changed indication sent successfully", level: .success)
            uiLog("🔄 iOS clients should now refresh their GATT cache", level: .info)
        } else {
            uiLog("⚠️ Failed to send Service Changed indication", level: .warning)
        }
    }
    
    func sendResponse(_ data: Data, to central: CBCentral) {
        guard connectedCentrals.contains(central) else {
            uiLog("Cannot send response - central not connected", level: .error)
            return
        }
        
        // Add length header
        var totalLength = UInt32(data.count)
        var headerData = Data()
        headerData.append(Data(bytes: &totalLength, count: 4))
        let fullData = headerData + data
        
        // Split into chunks if necessary
        let chunks = chunkData(fullData, maxChunkSize: 20) // BLE characteristic limit
        
        // Store chunks for this central
        pendingResponses[central] = chunks
        
        // Send first chunk
        sendNextChunk(to: central)
    }
    
    private func chunkData(_ data: Data, maxChunkSize: Int) -> [Data] {
        var chunks: [Data] = []
        let totalLength = data.count
        
        for offset in stride(from: 0, to: totalLength, by: maxChunkSize) {
            let end = min(offset + maxChunkSize, totalLength)
            let chunk = data.subdata(in: offset..<end)
            chunks.append(chunk)
        }
        
        return chunks
    }
    
    private func sendNextChunk(to central: CBCentral) {
        guard var chunks = pendingResponses[central], !chunks.isEmpty else {
            return
        }
        
        let chunk = chunks.removeFirst()
        pendingResponses[central] = chunks
        
        let success = peripheralManager.updateValue(
            chunk,
            for: responseCharacteristic,
            onSubscribedCentrals: [central]
        )
        
        if success {
            uiLog("Sent chunk of \(chunk.count) bytes", level: .info)
            
            // If more chunks remain, send next one after a small delay
            if !chunks.isEmpty {
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.01) {
                    self.sendNextChunk(to: central)
                }
            } else {
                // All chunks sent
                pendingResponses[central] = nil
                DispatchQueue.main.async {
                    self.responseCount += 1
                }
                uiLog("Response sent successfully", level: .success)
            }
        } else {
            uiLog("Failed to send chunk - will retry", level: .warning)
            pendingResponses[central] = [chunk] + chunks
        }
    }
    
    // MARK: - Data Processing
    private func handleIncomingData(_ data: Data, from central: CBCentral) {
        var receivingInfo = receivingData[central] ?? ReceivingData()
        
        if !receivingInfo.isReceiving {
            // First chunk - extract length header
            guard data.count >= 4 else {
                uiLog("Invalid data header - too short", level: .error)
                return
            }
            
            receivingInfo.expectedLength = data.subdata(in: 0..<4).withUnsafeBytes { $0.load(as: UInt32.self) }
            receivingInfo.receivedLength = 0
            receivingInfo.chunks = []
            receivingInfo.isReceiving = true
            
            uiLog("Starting to receive \(receivingInfo.expectedLength) bytes", level: .info)
            
            // Process remaining data from first chunk
            let remainingData = data.subdata(in: 4..<data.count)
            if !remainingData.isEmpty {
                receivingInfo.chunks.append(remainingData)
                receivingInfo.receivedLength = UInt32(remainingData.count)
            }
        } else {
            // Subsequent chunks
            receivingInfo.chunks.append(data)
            receivingInfo.receivedLength += UInt32(data.count)
        }
        
        // Check if we have all data
        if receivingInfo.receivedLength >= receivingInfo.expectedLength {
            let fullData = receivingInfo.chunks.reduce(Data()) { $0 + $1 }
            let finalData = fullData.prefix(Int(receivingInfo.expectedLength))
            
            uiLog("Received complete request: \(finalData.count) bytes", level: .success)
            
            // Reset receiving state
            receivingData[central] = nil
            
            // Update stats
            DispatchQueue.main.async {
                self.requestCount += 1
            }
            
            // Notify delegate
            delegate?.peripheralManager(self, didReceiveRequest: finalData)
        } else {
            // Store updated receiving info
            receivingData[central] = receivingInfo
        }
    }
}

// MARK: - CBPeripheralManagerDelegate
extension BLEPeripheralManager: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        let stateString = self.stateString(for: peripheral.state)
        uiLog("🔵 Peripheral manager state changed: \(stateString) (\(peripheral.state.rawValue))", level: .info)
        
        switch peripheral.state {
        case .poweredOn:
            uiLog("✅ Bluetooth powered on - setting up service...", level: .success)
            setupService()
        case .poweredOff:
            uiLog("⚠️ Bluetooth powered off", level: .warning)
            DispatchQueue.main.async {
                self.lastError = "Bluetooth is turned off"
                self.isAdvertising = false
            }
        case .unauthorized:
            uiLog("❌ Bluetooth access unauthorized", level: .error)
            DispatchQueue.main.async {
                self.lastError = "Bluetooth access denied"
            }
        case .unsupported:
            uiLog("❌ Bluetooth LE not supported", level: .error)
            DispatchQueue.main.async {
                self.lastError = "Bluetooth LE not supported"
            }
        case .unknown:
            uiLog("❓ Bluetooth state unknown", level: .warning)
            DispatchQueue.main.async {
                self.lastError = "Bluetooth state unknown"
            }
        case .resetting:
            uiLog("🔄 Bluetooth resetting...", level: .info)
            DispatchQueue.main.async {
                self.lastError = "Bluetooth resetting"
            }
        @unknown default:
            uiLog("❓ Unknown Bluetooth state: \(peripheral.state.rawValue)", level: .warning)
            DispatchQueue.main.async {
                self.lastError = "Bluetooth not ready"
            }
        }
    }
    
    private func stateString(for state: CBManagerState) -> String {
        switch state {
        case .unknown: return "Unknown"
        case .resetting: return "Resetting"
        case .unsupported: return "Unsupported"
        case .unauthorized: return "Unauthorized"
        case .poweredOff: return "Powered Off"
        case .poweredOn: return "Powered On"
        @unknown default: return "Unknown State \(state.rawValue)"
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error {
            uiLog("❌ Failed to add service: \(error.localizedDescription)", level: .error)
            DispatchQueue.main.async {
                self.lastError = error.localizedDescription
            }
        } else {
            uiLog("✅ Service added successfully: \(service.uuid)", level: .success)
            uiLog("📋 Characteristics added: \(service.characteristics?.count ?? 0)", level: .info)
            for char in service.characteristics ?? [] {
                uiLog("  - \(char.uuid): properties=\(char.properties.rawValue)", level: .info)
            }
            startAdvertising()
        }
    }
    
    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error = error {
            uiLog("❌ Failed to start advertising: \(error.localizedDescription)", level: .error)
            DispatchQueue.main.async {
                self.lastError = error.localizedDescription
                self.isAdvertising = false
            }
        } else {
            uiLog("📡 BLE advertising started successfully", level: .success)
            uiLog("🎯 Device name: BLE-Proxy", level: .info)
            uiLog("🔑 Service UUID: \(self.serviceUUID.uuidString)", level: .info)
            uiLog("👀 Waiting for Windows client to discover and connect...", level: .info)
            DispatchQueue.main.async {
                self.isAdvertising = true
                self.lastError = nil
            }
            delegate?.peripheralManagerDidStartAdvertising(self)
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        uiLog("🚨 CRITICAL: Central subscribed! Connection successful!", level: .success)
        uiLog("🔗 Central: \(central.identifier.uuidString)", level: .info)
        uiLog("🔗 Characteristic: \(characteristic.uuid.uuidString)", level: .info)
        
        // Check if this is the Service Changed characteristic
        if characteristic.uuid == serviceChangedCharacteristicUUID {
            uiLog("🔄 Client subscribed to Service Changed characteristic", level: .info)
            uiLog("📡 This will enable GATT cache invalidation", level: .info)
            
            // Trigger Service Changed indication to force cache refresh
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.triggerServiceChanged()
            }
        } else {
            uiLog("📊 Connection details - RSSI: unknown, Services discovered: yes", level: .info)
            uiLog("✅ BLE connection established successfully", level: .success)
            
            connectedCentrals.insert(central)
            DispatchQueue.main.async {
                self.isConnected = true
                self.connectionCount = self.connectedCentrals.count
            }
            
            delegate?.peripheralManager(self, didConnect: central)
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        if characteristic.uuid == serviceChangedCharacteristicUUID {
            uiLog("🔄 Client unsubscribed from Service Changed characteristic", level: .info)
        } else {
            uiLog("🚨 CRITICAL: Central disconnected during setup!", level: .error)
            uiLog("🔌 Central: \(central.identifier.uuidString)", level: .error)
            uiLog("🔌 Characteristic: \(characteristic.uuid.uuidString)", level: .error)
            uiLog("❓ Disconnect reason: Client initiated or connection lost during service discovery", level: .error)
            uiLog("🧹 Cleaning up connection data for client", level: .info)
            uiLog("📊 Peripheral state: \(peripheral.state.rawValue)", level: .info)
            
            connectedCentrals.remove(central)
            receivingData[central] = nil
            pendingResponses[central] = nil
            
            DispatchQueue.main.async {
                self.connectionCount = self.connectedCentrals.count
                self.isConnected = !self.connectedCentrals.isEmpty
            }
            
            delegate?.peripheralManager(self, didDisconnect: central)
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        uiLog("📝 Received \(requests.count) write request(s) from client", level: .info)
        
        for request in requests {
            if request.characteristic == requestCharacteristic {
                if let data = request.value {
                    uiLog("📦 Processing \(data.count) bytes from client \(request.central.identifier)", level: .info)
                    handleIncomingData(data, from: request.central)
                }
                peripheral.respond(to: request, withResult: .success)
            } else {
                uiLog("⚠️ Unknown characteristic write attempt: \(request.characteristic.uuid)", level: .warning)
                peripheral.respond(to: request, withResult: .attributeNotFound)
            }
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        uiLog("🚨 CRITICAL: Windows service discovery read request!", level: .warning)
        uiLog("🔍 Central: \(request.central.identifier.uuidString)", level: .info)
        uiLog("🔍 Characteristic: \(request.characteristic.uuid.uuidString)", level: .info)
        uiLog("🔍 Offset: \(request.offset)", level: .info)
        uiLog("🔍 Peripheral state: \(peripheral.state.rawValue)", level: .info)
        
        // Check which characteristic is being read
        if request.characteristic.uuid == self.requestCharacteristicUUID {
            uiLog("  → REQUEST characteristic (write-only) - should deny read", level: .warning)
        } else if request.characteristic.uuid == self.responseCharacteristicUUID {
            uiLog("  → RESPONSE characteristic (notify/read) - should allow read", level: .info)
        } else if request.characteristic.uuid == self.controlCharacteristicUUID {
            uiLog("  → CONTROL characteristic (read/write/notify) - should allow read", level: .info)
        } else {
            uiLog("  → ⚠️ UNKNOWN characteristic!", level: .error)
            uiLog("  Expected UUIDs:", level: .info)
            uiLog("    Request:  \(self.requestCharacteristicUUID.uuidString)", level: .info)
            uiLog("    Response: \(self.responseCharacteristicUUID.uuidString)", level: .info)  
            uiLog("    Control:  \(self.controlCharacteristicUUID.uuidString)", level: .info)
        }
        
        // For response and control characteristics that support read, return empty value
        // For request characteristic (write-only), return not permitted
        if request.characteristic.uuid == self.responseCharacteristicUUID || 
           request.characteristic.uuid == self.controlCharacteristicUUID {
            uiLog("🚨 CRITICAL: Allowing read - returning empty data", level: .warning)
            request.value = Data() // Return empty data for readable characteristics
            peripheral.respond(to: request, withResult: .success)
            uiLog("✅ CRITICAL: Responded with .success (empty data)", level: .success)
        } else if request.characteristic.uuid == self.requestCharacteristicUUID {
            uiLog("🚨 CRITICAL: Denying read for write-only characteristic", level: .warning)
            peripheral.respond(to: request, withResult: .readNotPermitted)
            uiLog("❌ CRITICAL: Responded with .readNotPermitted", level: .error)
        } else {
            uiLog("🚨 CRITICAL: Unknown characteristic - returning attributeNotFound", level: .error)
            peripheral.respond(to: request, withResult: .attributeNotFound)
            uiLog("❌ CRITICAL: Responded with .attributeNotFound", level: .error)
        }
        
        uiLog("🔍 CRITICAL: Read request handled - current state:", level: .info)
        uiLog("   Peripheral state: \(peripheral.state.rawValue)", level: .info)
        uiLog("   Connected centrals: \(self.connectedCentrals.count)", level: .info)
        uiLog("   Is advertising: \(peripheral.isAdvertising)", level: .info)
    }
    
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        uiLog("🔄 Peripheral ready to update subscribers", level: .info)
        // Continue sending pending data
        for central in connectedCentrals {
            if pendingResponses[central] != nil {
                sendNextChunk(to: central)
            }
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String : Any]) {
        uiLog("🔄 Peripheral manager will restore state: \(dict.keys)", level: .info)
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
        if let error = error {
            uiLog("❌ Failed to publish L2CAP channel: \(error.localizedDescription)", level: .error)
        } else {
            uiLog("✅ Published L2CAP channel: \(PSM)", level: .success)
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didUnpublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
        if let error = error {
            uiLog("❌ Failed to unpublish L2CAP channel: \(error.localizedDescription)", level: .error)
        } else {
            uiLog("ℹ️ Unpublished L2CAP channel: \(PSM)", level: .info)
        }
    }
    

} 