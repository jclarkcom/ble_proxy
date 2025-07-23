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
    private let serviceUUID = CBUUID(string: "a1b2c3d4-e5f6-7890-1234-567890abcdef")
    private let requestCharacteristicUUID = CBUUID(string: "a1b2c3d4-e5f6-7890-1234-567890abcd01")
    private let responseCharacteristicUUID = CBUUID(string: "a1b2c3d4-e5f6-7890-1234-567890abcd02")
    private let controlCharacteristicUUID = CBUUID(string: "a1b2c3d4-e5f6-7890-1234-567890abcd03")
    
    // MARK: - Core Bluetooth
    private var peripheralManager: CBPeripheralManager!
    private var proxyService: CBMutableService!
    private var requestCharacteristic: CBMutableCharacteristic!
    private var responseCharacteristic: CBMutableCharacteristic!
    private var controlCharacteristic: CBMutableCharacteristic!
    
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
        
        // Create characteristics
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
        
        // Create service
        uiLog("🏗️ Creating BLE service...", level: .info)
        proxyService = CBMutableService(type: serviceUUID, primary: true)
        proxyService.characteristics = [
            requestCharacteristic,
            responseCharacteristic,
            controlCharacteristic
        ]
        
        uiLog("✅ Service created with \(self.proxyService.characteristics?.count ?? 0) characteristics", level: .success)
        
        // Add service
        uiLog("➕ Adding service to peripheral manager...", level: .info)
        peripheralManager.add(proxyService)
        uiLog("✅ BLE service and characteristics setup completed", level: .success)
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
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: "BLE-Proxy"
        ]
        
        // Log the advertisement data being sent
        uiLog("📤 Advertisement data:", level: .info)
        for (key, value) in advertisementData {
            if key == CBAdvertisementDataServiceUUIDsKey {
                if let uuids = value as? [CBUUID] {
                    uiLog("  • Service UUIDs: \(uuids.map { $0.uuidString }.joined(separator: ", "))", level: .info)
                }
            } else {
                uiLog("  • \(key): \(String(describing: value))", level: .info)
            }
        }
        
        peripheralManager.startAdvertising(advertisementData)
        uiLog("Started advertising BLE proxy service", level: .success)
    }
    
    func stopAdvertising() {
        peripheralManager.stopAdvertising()
        DispatchQueue.main.async {
            self.isAdvertising = false
        }
        uiLog("Stopped advertising", level: .info)
        delegate?.peripheralManagerDidStopAdvertising(self)
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
        uiLog("📊 Connection details - RSSI: unknown, Services discovered: yes", level: .info)
        uiLog("✅ BLE connection established successfully", level: .success)
        
        connectedCentrals.insert(central)
        DispatchQueue.main.async {
            self.isConnected = true
            self.connectionCount = self.connectedCentrals.count
        }
        
        delegate?.peripheralManager(self, didConnect: central)
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
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