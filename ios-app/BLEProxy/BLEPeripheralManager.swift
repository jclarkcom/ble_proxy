import Foundation
import CoreBluetooth
import Compression
import os.log

protocol BLEPeripheralManagerDelegate: AnyObject {
    func peripheralManager(_ manager: BLEPeripheralManager, didReceiveRequest data: Data)
    func peripheralManagerDidStartAdvertising(_ manager: BLEPeripheralManager)
    func peripheralManagerDidStopAdvertising(_ manager: BLEPeripheralManager)
    func peripheralManager(_ manager: BLEPeripheralManager, didConnect central: CBCentral)
    func peripheralManager(_ manager: BLEPeripheralManager, didDisconnect central: CBCentral)
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
    private let serviceUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCDEF")
    private let requestCharacteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCD01")
    private let responseCharacteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCD02")
    private let controlCharacteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-7890-1234-567890ABCD03")
    
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
        logger.info("🚀 Initializing BLE Peripheral Manager...")
        logger.info("📋 Service UUID will be: \(self.serviceUUID.uuidString)")
        logger.info("📋 Request characteristic: \(self.requestCharacteristicUUID.uuidString)")
        logger.info("📋 Response characteristic: \(self.responseCharacteristicUUID.uuidString)")
        logger.info("📋 Control characteristic: \(self.controlCharacteristicUUID.uuidString)")
        
        peripheralManager = CBPeripheralManager(delegate: self, queue: DispatchQueue.global(qos: .userInitiated))
        
        logger.info("✅ BLE Peripheral Manager created")
        logger.info("⏳ Waiting for Bluetooth state change...")
    }
    
    private func setupService() {
        logger.info("🔧 Setting up BLE service and characteristics...")
        logger.info("🆔 Service UUID: \(self.serviceUUID.uuidString)")
        
        // Create characteristics
        logger.info("📝 Creating REQUEST characteristic...")
        requestCharacteristic = CBMutableCharacteristic(
            type: requestCharacteristicUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        logger.info("  • UUID: \(self.requestCharacteristicUUID.uuidString)")
        logger.info("  • Properties: write, writeWithoutResponse")
        
        logger.info("📝 Creating RESPONSE characteristic...")
        responseCharacteristic = CBMutableCharacteristic(
            type: responseCharacteristicUUID,
            properties: [.notify, .read],
            value: nil,
            permissions: [.readable]
        )
        logger.info("  • UUID: \(self.responseCharacteristicUUID.uuidString)")
        logger.info("  • Properties: notify, read")
        
        logger.info("📝 Creating CONTROL characteristic...")
        controlCharacteristic = CBMutableCharacteristic(
            type: controlCharacteristicUUID,
            properties: [.read, .write, .notify],
            value: nil,
            permissions: [.readable, .writeable]
        )
        logger.info("  • UUID: \(self.controlCharacteristicUUID.uuidString)")
        logger.info("  • Properties: read, write, notify")
        
        // Create service
        logger.info("🏗️ Creating BLE service...")
        proxyService = CBMutableService(type: serviceUUID, primary: true)
        proxyService.characteristics = [
            requestCharacteristic,
            responseCharacteristic,
            controlCharacteristic
        ]
        
        logger.info("✅ Service created with \(self.proxyService.characteristics?.count ?? 0) characteristics")
        
        // Add service
        logger.info("➕ Adding service to peripheral manager...")
        peripheralManager.add(proxyService)
        logger.info("✅ BLE service and characteristics setup completed")
    }
    
    // MARK: - Public Methods
    func startAdvertising() {
        guard peripheralManager.state == .poweredOn else {
            logger.error("Cannot start advertising - Bluetooth not powered on")
            lastError = "Bluetooth not available"
            return
        }
        
        logger.info("🚀 Starting BLE advertisement...")
        logger.info("📡 Service UUID to advertise: \(self.serviceUUID.uuidString)")
        logger.info("🏷️ Device name: BLE-Proxy")
        
        let advertisementData: [String: Any] = [
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: "BLE-Proxy"
        ]
        
        // Log the advertisement data being sent
        logger.info("📤 Advertisement data:")
        for (key, value) in advertisementData {
            if key == CBAdvertisementDataServiceUUIDsKey {
                if let uuids = value as? [CBUUID] {
                    logger.info("  • Service UUIDs: \(uuids.map { $0.uuidString }.joined(separator: ", "))")
                }
            } else {
                logger.info("  • \(key): \(String(describing: value))")
            }
        }
        
        peripheralManager.startAdvertising(advertisementData)
        logger.info("Started advertising BLE proxy service")
    }
    
    func stopAdvertising() {
        peripheralManager.stopAdvertising()
        DispatchQueue.main.async {
            self.isAdvertising = false
        }
        logger.info("Stopped advertising")
        delegate?.peripheralManagerDidStopAdvertising(self)
    }
    
    func sendResponse(_ data: Data, to central: CBCentral) {
        guard connectedCentrals.contains(central) else {
            logger.error("Cannot send response - central not connected")
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
            logger.debug("Sent chunk of \(chunk.count) bytes")
            
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
                logger.info("Response sent successfully")
            }
        } else {
            logger.warning("Failed to send chunk - will retry")
            pendingResponses[central] = [chunk] + chunks
        }
    }
    
    // MARK: - Data Processing
    private func handleIncomingData(_ data: Data, from central: CBCentral) {
        var receivingInfo = receivingData[central] ?? ReceivingData()
        
        if !receivingInfo.isReceiving {
            // First chunk - extract length header
            guard data.count >= 4 else {
                logger.error("Invalid data header - too short")
                return
            }
            
            receivingInfo.expectedLength = data.subdata(in: 0..<4).withUnsafeBytes { $0.load(as: UInt32.self) }
            receivingInfo.receivedLength = 0
            receivingInfo.chunks = []
            receivingInfo.isReceiving = true
            
            logger.info("Starting to receive \(receivingInfo.expectedLength) bytes")
            
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
            
            logger.info("Received complete request: \(finalData.count) bytes")
            
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
        logger.info("🔵 Peripheral manager state changed: \(stateString) (\(peripheral.state.rawValue))")
        
        switch peripheral.state {
        case .poweredOn:
            logger.info("✅ Bluetooth powered on - setting up service...")
            setupService()
        case .poweredOff:
            logger.warning("⚠️ Bluetooth powered off")
            DispatchQueue.main.async {
                self.lastError = "Bluetooth is turned off"
                self.isAdvertising = false
            }
        case .unauthorized:
            logger.error("❌ Bluetooth access unauthorized")
            DispatchQueue.main.async {
                self.lastError = "Bluetooth access denied"
            }
        case .unsupported:
            logger.error("❌ Bluetooth LE not supported")
            DispatchQueue.main.async {
                self.lastError = "Bluetooth LE not supported"
            }
        case .unknown:
            logger.warning("❓ Bluetooth state unknown")
            DispatchQueue.main.async {
                self.lastError = "Bluetooth state unknown"
            }
        case .resetting:
            logger.info("🔄 Bluetooth resetting...")
            DispatchQueue.main.async {
                self.lastError = "Bluetooth resetting"
            }
        @unknown default:
            logger.warning("❓ Unknown Bluetooth state: \(peripheral.state.rawValue)")
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
            logger.error("❌ Failed to add service: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.lastError = error.localizedDescription
            }
        } else {
            logger.info("✅ Service added successfully: \(service.uuid)")
            logger.info("📋 Characteristics added: \(service.characteristics?.count ?? 0)")
            for char in service.characteristics ?? [] {
                logger.info("  - \(char.uuid): properties=\(char.properties.rawValue)")
            }
            startAdvertising()
        }
    }
    
    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error = error {
            logger.error("❌ Failed to start advertising: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.lastError = error.localizedDescription
                self.isAdvertising = false
            }
        } else {
            logger.info("📡 BLE advertising started successfully")
            logger.info("🎯 Device name: BLE-Proxy")
            logger.info("🔑 Service UUID: \(self.serviceUUID.uuidString)")
            logger.info("👀 Waiting for Windows client to discover and connect...")
            DispatchQueue.main.async {
                self.isAdvertising = true
                self.lastError = nil
            }
            delegate?.peripheralManagerDidStartAdvertising(self)
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        logger.info("🔗 Central \(central.identifier) subscribed to characteristic \(characteristic.uuid)")
        logger.info("📊 Connection details - RSSI: unknown, Services discovered: yes")
        logger.info("✅ BLE connection established successfully")
        
        connectedCentrals.insert(central)
        DispatchQueue.main.async {
            self.isConnected = true
            self.connectionCount = self.connectedCentrals.count
        }
        
        delegate?.peripheralManager(self, didConnect: central)
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        logger.info("🔌 Central \(central.identifier) unsubscribed from characteristic \(characteristic.uuid)")
        logger.info("❓ Disconnect reason: Client initiated or connection lost")
        logger.info("🧹 Cleaning up connection data for client")
        
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
        logger.info("📝 Received \(requests.count) write request(s) from client")
        
        for request in requests {
            if request.characteristic == requestCharacteristic {
                if let data = request.value {
                    logger.info("📦 Processing \(data.count) bytes from client \(request.central.identifier)")
                    handleIncomingData(data, from: request.central)
                }
                peripheral.respond(to: request, withResult: .success)
            } else {
                logger.warning("⚠️ Unknown characteristic write attempt: \(request.characteristic.uuid)")
                peripheral.respond(to: request, withResult: .attributeNotFound)
            }
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        logger.info("📖 Windows client attempting service discovery!")
        logger.info("🔍 Read request from central: \(request.central.identifier)")
        logger.info("🔍 Requested characteristic: \(request.characteristic.uuid)")
        
        // Check which characteristic is being read
        if request.characteristic.uuid == requestCharacteristicUUID {
            logger.info("  → REQUEST characteristic (write-only)")
        } else if request.characteristic.uuid == responseCharacteristicUUID {
            logger.info("  → RESPONSE characteristic (notify/read)")
        } else if request.characteristic.uuid == controlCharacteristicUUID {
            logger.info("  → CONTROL characteristic (read/write/notify)")
        } else {
            logger.warning("  → ⚠️ UNKNOWN characteristic!")
        }
        
        // For response and control characteristics that support read, return empty value
        // For request characteristic (write-only), return not permitted
        if request.characteristic.uuid == responseCharacteristicUUID || 
           request.characteristic.uuid == controlCharacteristicUUID {
            request.value = Data() // Return empty data for readable characteristics
            peripheral.respond(to: request, withResult: .success)
            logger.info("✅ Responded with success (empty data)")
        } else {
            peripheral.respond(to: request, withResult: .readNotPermitted)
            logger.info("❌ Responded with readNotPermitted")
        }
    }
    
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        logger.info("🔄 Peripheral ready to update subscribers")
        // Continue sending pending data
        for central in connectedCentrals {
            if pendingResponses[central] != nil {
                sendNextChunk(to: central)
            }
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String : Any]) {
        logger.info("🔄 Peripheral manager will restore state: \(dict.keys)")
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
        if let error = error {
            logger.error("❌ Failed to publish L2CAP channel: \(error.localizedDescription)")
        } else {
            logger.info("✅ Published L2CAP channel: \(PSM)")
        }
    }
    
    func peripheralManager(_ peripheral: CBPeripheralManager, didUnpublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
        if let error = error {
            logger.error("❌ Failed to unpublish L2CAP channel: \(error.localizedDescription)")
        } else {
            logger.info("ℹ️ Unpublished L2CAP channel: \(PSM)")
        }
    }
    

} 