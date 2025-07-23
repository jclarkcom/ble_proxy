import Foundation
import SwiftUI
import CoreBluetooth
import Compression
import Combine
import os.log

@MainActor
class ProxyViewModel: ObservableObject {
    // MARK: - Published Properties
    @Published var isProxyActive = false
    @Published var connectionStatus = "Disconnected"
    @Published var requestCount = 0
    @Published var responseCount = 0
    @Published var errorCount = 0
    @Published var lastError: String?
    @Published var uptime: TimeInterval = 0
    @Published var debugLog: [DebugLogEntry] = []
    
    // MARK: - Managers
    private let bleManager = BLEPeripheralManager()
    private let httpClient = HTTPClient()
    private let audioManager = BackgroundAudioManager()
    
    // MARK: - State
    private var startTime: Date?
    private var uptimeTimer: Timer?
    
    // MARK: - Logging
    private let logger = Logger(subsystem: "com.bleproxy.app", category: "ProxyViewModel")
    
    init() {
        setupBindings()
        setupBLEDelegate()
    }
    
    deinit {
        // Cleanup will be handled by system
    }
    
    // MARK: - Public Methods
    func initialize() {
        logger.info("Initializing proxy system")
        
        // TEST ERROR MESSAGE - Verify logging system works
        addDebugLog("🧪 TEST ERROR MESSAGE - Debug logging system test", level: .error)
        addDebugLog("🚀 BLE Proxy iOS app initializing", level: .info)
        addDebugLog("📱 iOS BLE peripheral mode", level: .info)
        addDebugLog("🔵 Bluetooth state: checking", level: .info)
        addDebugLog("✅ Proxy system ready", level: .success)
    }
    
    func startProxy() {
        guard !isProxyActive else {
            logger.info("Proxy already active")
            addDebugLog("Proxy already active", level: .warning)
            return
        }
        
        logger.info("Starting BLE proxy service")
        addDebugLog("🚀 Starting BLE proxy service", level: .info)
        
        startTime = Date()
        isProxyActive = true
        connectionStatus = "Starting..."
        
        // Start background audio to keep app active
        audioManager.startSilentAudio()
        addDebugLog("🎵 Background audio started", level: .info)
        
        // Start BLE advertising
        bleManager.startAdvertising()
        addDebugLog("📡 BLE advertising started", level: .info)
        
        // Start uptime timer
        startUptimeTimer()
        
        logger.info("BLE proxy service started")
        addDebugLog("✅ BLE proxy service started", level: .success)
    }
    
    func stopProxy() {
        guard isProxyActive else {
            logger.info("Proxy already stopped")
            addDebugLog("Proxy already stopped", level: .warning)
            return
        }
        
        logger.info("Stopping BLE proxy service")
        addDebugLog("🛑 Stopping BLE proxy service", level: .info)
        
        isProxyActive = false
        connectionStatus = "Stopped"
        
        // Stop BLE advertising
        bleManager.stopAdvertising()
        addDebugLog("📡 BLE advertising stopped", level: .info)
        
        // Stop background audio
        audioManager.stopSilentAudio()
        addDebugLog("🎵 Background audio stopped", level: .info)
        
        // Stop uptime timer
        stopUptimeTimer()
        
        logger.info("BLE proxy service stopped")
        addDebugLog("✅ BLE proxy service stopped", level: .success)
    }
    
    // Force connected iOS clients to refresh their GATT cache
    func forceGATTCacheRefresh() {
        logger.info("Triggering GATT cache refresh for connected clients")
        addDebugLog("🔄 Forcing GATT cache refresh for iOS clients", level: .info)
        
        bleManager.triggerServiceChanged()
    }
    
    func resetStats() {
        logger.info("Resetting statistics")
        
        requestCount = 0
        responseCount = 0
        errorCount = 0
        lastError = nil
        
        if isProxyActive {
            startTime = Date()
            uptime = 0
        }
        
        self.addDebugLog("Statistics reset", level: .info)
    }
    
    func clearDebugLog() {
        logger.info("Clearing debug log")
        debugLog.removeAll()
    }
    
    func addDebugLog(_ message: String, level: DebugLogEntry.LogLevel = .info) {
        let timestamp = DateFormatter.logTimeFormatter.string(from: Date())
        let entry = DebugLogEntry(timestamp: timestamp, level: level, message: message)
        
        DispatchQueue.main.async {
            self.debugLog.append(entry)
            
            // Limit log entries to prevent memory issues
            if self.debugLog.count > 100 {
                self.debugLog.removeFirst(self.debugLog.count - 100)
            }
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
    
    // MARK: - Private Methods
    private func setupBindings() {
        // Bind BLE manager state
        bleManager.$isAdvertising
            .receive(on: DispatchQueue.main)
            .sink { [weak self] isAdvertising in
                self?.updateConnectionStatus()
            }
            .store(in: &cancellables)
        
        bleManager.$isConnected
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.updateConnectionStatus()
            }
            .store(in: &cancellables)
        
        bleManager.$connectionCount
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.updateConnectionStatus()
            }
            .store(in: &cancellables)
        
        bleManager.$requestCount
            .receive(on: DispatchQueue.main)
            .assign(to: \.requestCount, on: self)
            .store(in: &cancellables)
        
        bleManager.$responseCount
            .receive(on: DispatchQueue.main)
            .assign(to: \.responseCount, on: self)
            .store(in: &cancellables)
        
        bleManager.$lastError
            .receive(on: DispatchQueue.main)
            .assign(to: \.lastError, on: self)
            .store(in: &cancellables)
        
        // Bind HTTP client stats
        httpClient.$errorCount
            .receive(on: DispatchQueue.main)
            .assign(to: \.errorCount, on: self)
            .store(in: &cancellables)
    }
    
    private var cancellables = Set<AnyCancellable>()
    
    private func setupBLEDelegate() {
        bleManager.delegate = self
    }
    
    private func updateConnectionStatus() {
        if !isProxyActive {
            connectionStatus = "Stopped"
        } else if !bleManager.isAdvertising {
            connectionStatus = "Starting..."
        } else if !bleManager.isConnected {
            connectionStatus = "Waiting for connection"
        } else {
            let count = bleManager.connectionCount
            connectionStatus = "Connected (\(count) client\(count == 1 ? "" : "s"))"
        }
    }
    
    private func startUptimeTimer() {
        uptimeTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor [weak self] in
                self?.updateUptime()
            }
        }
    }
    
    private func stopUptimeTimer() {
        uptimeTimer?.invalidate()
        uptimeTimer = nil
    }
    
    private func updateUptime() {
        guard let startTime = startTime else {
            uptime = 0
            return
        }
        
        uptime = Date().timeIntervalSince(startTime)
    }
    
    // MARK: - Data Processing
    private func processProxyRequest(_ data: Data) async {
        addDebugLog("🔄 Starting proxy request processing...", level: .info)
        addDebugLog("📊 Received data size: \(data.count) bytes", level: .info)
        
        do {
            // Step 1: Decompress the request
            addDebugLog("🗜️ Step 1: Attempting to decompress request data...", level: .info)
            let decompressedData = try await decompressData(data)
            addDebugLog("✅ Step 1: Decompression successful - \(decompressedData.count) bytes", level: .success)
            
            // Step 2: Parse JSON
            addDebugLog("📝 Step 2: Attempting to parse JSON...", level: .info)
            let decoder = JSONDecoder()
            let proxyRequest = try decoder.decode(ProxyRequest.self, from: decompressedData)
            addDebugLog("✅ Step 2: JSON parsing successful", level: .success)
            addDebugLog("🌐 Request details: \(proxyRequest.method) \(proxyRequest.url)", level: .info)
            addDebugLog("📋 Request ID: \(proxyRequest.id)", level: .info)
            
            logger.info("Processing request: \(proxyRequest.method) \(proxyRequest.url)")
            
            // Step 3: Make HTTP request
            addDebugLog("🌍 Step 3: Making HTTP request to \(proxyRequest.url)...", level: .info)
            let response = await httpClient.makeRequest(proxyRequest)
            addDebugLog("✅ Step 3: HTTP request completed", level: .success)
            addDebugLog("📊 HTTP response: \(response.statusCode) \(response.statusMessage)", level: .info)
            addDebugLog("📦 Response body size: \(response.body.count) bytes", level: .info)
            
            logger.info("Received response: \(response.statusCode)")
            
            // Step 4: Send response back via BLE
            addDebugLog("📡 Step 4: Sending response back via BLE...", level: .info)
            await sendProxyResponse(response)
            addDebugLog("✅ Step 4: BLE response sending completed", level: .success)
            addDebugLog("🎉 Proxy request processing completed successfully!", level: .success)
            
        } catch {
            addDebugLog("❌ ERROR in proxy request processing!", level: .error)
            addDebugLog("🔍 Error details: \(error.localizedDescription)", level: .error)
            addDebugLog("🔍 Error type: \(type(of: error))", level: .error)
            
            logger.error("Error processing request: \(error.localizedDescription)")
            
            await MainActor.run {
                self.errorCount += 1
                self.lastError = "Request processing error: \(error.localizedDescription)"
            }
        }
    }
    
    private func sendProxyResponse(_ response: ProxyResponse) async {
        addDebugLog("📤 Starting proxy response sending...", level: .info)
        addDebugLog("📋 Response ID: \(response.id)", level: .info)
        addDebugLog("📊 Response status: \(response.statusCode) \(response.statusMessage)", level: .info)
        addDebugLog("📦 Response body size: \(response.body.count) bytes", level: .info)
        
        do {
            // Step 1: Encode response to JSON
            addDebugLog("📝 Step 1: Encoding response to JSON...", level: .info)
            let encoder = JSONEncoder()
            let responseData = try encoder.encode(response)
            addDebugLog("✅ Step 1: JSON encoding successful - \(responseData.count) bytes", level: .success)
            
            // Step 2: Compress response
            addDebugLog("🗜️ Step 2: Compressing response data...", level: .info)
            let compressedData = try await compressData(responseData)
            addDebugLog("✅ Step 2: Compression successful - \(compressedData.count) bytes (ratio: \(String(format: "%.1f", Double(compressedData.count) / Double(responseData.count) * 100))%)", level: .success)
            
            // Step 3: Send via BLE to all connected centrals
            addDebugLog("📡 Step 3: Sending via BLE to connected clients...", level: .info)
            let connectedClients = bleManager.connectedClients
            addDebugLog("👥 Connected clients count: \(connectedClients.count)", level: .info)
            
            if connectedClients.isEmpty {
                addDebugLog("⚠️ No connected clients to send response to!", level: .warning)
                await MainActor.run {
                    self.lastError = "No connected clients to send response to"
                }
                return
            }
            
            for (index, central) in connectedClients.enumerated() {
                let shortId = String(central.identifier.uuidString.prefix(8))
                addDebugLog("📤 Sending to client \(index + 1)/\(connectedClients.count): \(shortId)", level: .info)
                bleManager.sendResponse(compressedData, to: central)
            }
            
            addDebugLog("✅ Step 3: BLE sending initiated for all clients", level: .success)
            
            logger.info("Response sent via BLE")
            addDebugLog("🎉 Proxy response sending completed successfully!", level: .success)
            
        } catch {
            addDebugLog("❌ ERROR in proxy response sending!", level: .error)
            addDebugLog("🔍 Error details: \(error.localizedDescription)", level: .error)
            addDebugLog("🔍 Error type: \(type(of: error))", level: .error)
            
            logger.error("Error sending response: \(error.localizedDescription)")
            
            await MainActor.run {
                self.errorCount += 1
                self.lastError = "Response sending error: \(error.localizedDescription)"
            }
        }
    }
    
    // MARK: - Compression
    private func compressData(_ data: Data) async throws -> Data {
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    // Use gzip compression for compatibility with Windows Node.js
                    let compressedData = try data.compressed(using: .zlib)
                    continuation.resume(returning: compressedData)
                } catch {
                    // Fallback to no compression if compression fails
                    continuation.resume(returning: data)
                }
            }
        }
    }
    
    private func decompressData(_ data: Data) async throws -> Data {
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    // Use gzip decompression for compatibility with Windows Node.js
                    let decompressedData = try data.decompressed(using: .zlib)
                    continuation.resume(returning: decompressedData)
                } catch {
                    // Try without decompression (might be uncompressed data)
                    continuation.resume(returning: data)
                }
            }
        }
    }
}

// MARK: - BLEPeripheralManagerDelegate
extension ProxyViewModel: BLEPeripheralManagerDelegate {
    nonisolated func peripheralManager(_ manager: BLEPeripheralManager, didReceiveRequest data: Data) {
        Task {
            await processProxyRequest(data)
        }
    }
    
    nonisolated func peripheralManagerDidStartAdvertising(_ manager: BLEPeripheralManager) {
        Task { @MainActor in
            addDebugLog("📡 BLE advertising started successfully", level: .success)
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManagerDidStopAdvertising(_ manager: BLEPeripheralManager) {
        Task { @MainActor in
            addDebugLog("📡 BLE advertising stopped", level: .info)
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManager(_ manager: BLEPeripheralManager, didConnect central: CBCentral) {
        logger.info("Client connected: \(central.identifier)")
        Task { @MainActor in
            let shortId = String(central.identifier.uuidString.prefix(8))
            addDebugLog("🔗 Windows client connected: \(shortId)", level: .success)
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManager(_ manager: BLEPeripheralManager, didDisconnect central: CBCentral) {
        logger.info("Client disconnected: \(central.identifier)")
        Task { @MainActor in
            let shortId = String(central.identifier.uuidString.prefix(8))
            addDebugLog("🔌 Windows client disconnected: \(shortId)", level: .warning)
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManager(_ manager: BLEPeripheralManager, didGenerateLog message: String, level: DebugLogEntry.LogLevel) {
        Task { @MainActor in
            addDebugLog(message, level: level)
        }
    }
}

// MARK: - Helper Extensions
import Combine

extension Data {
    func compressed(using algorithm: NSData.CompressionAlgorithm) throws -> Data {
        return try (self as NSData).compressed(using: algorithm) as Data
    }
    
    func decompressed(using algorithm: NSData.CompressionAlgorithm) throws -> Data {
        return try (self as NSData).decompressed(using: algorithm) as Data
    }
}

// MARK: - Formatting Helpers
extension ProxyViewModel {
    var formattedUptime: String {
        let hours = Int(uptime) / 3600
        let minutes = Int(uptime) % 3600 / 60
        let seconds = Int(uptime) % 60
        
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        } else {
            return String(format: "%d:%02d", minutes, seconds)
        }
    }
    
    var proxyStatusColor: Color {
        if !isProxyActive {
            return .gray
        } else if bleManager.isConnected {
            return .green
        } else if bleManager.isAdvertising {
            return .yellow
        } else {
            return .red
        }
    }
    
    var proxyStatusText: String {
        if !isProxyActive {
            return "Stopped"
        } else if bleManager.isConnected {
            return "Active"
        } else if bleManager.isAdvertising {
            return "Waiting"
        } else {
            return "Error"
        }
    }
}

// MARK: - DateFormatter Extension
extension DateFormatter {
    static let logTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
} 