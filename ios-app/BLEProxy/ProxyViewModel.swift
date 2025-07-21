import Foundation
import SwiftUI
import CoreBluetooth
import Compression
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
        stopProxy()
    }
    
    // MARK: - Public Methods
    func initialize() {
        logger.info("Initializing proxy system")
        // Initialization will be triggered by UI
    }
    
    func startProxy() {
        guard !isProxyActive else {
            logger.info("Proxy already active")
            return
        }
        
        logger.info("Starting BLE proxy service")
        
        startTime = Date()
        isProxyActive = true
        connectionStatus = "Starting..."
        
        // Start background audio to keep app active
        audioManager.startSilentAudio()
        
        // Start BLE advertising
        bleManager.startAdvertising()
        
        // Start uptime timer
        startUptimeTimer()
        
        logger.info("BLE proxy service started")
    }
    
    func stopProxy() {
        guard isProxyActive else {
            logger.info("Proxy already stopped")
            return
        }
        
        logger.info("Stopping BLE proxy service")
        
        isProxyActive = false
        connectionStatus = "Stopped"
        
        // Stop BLE advertising
        bleManager.stopAdvertising()
        
        // Stop background audio
        audioManager.stopSilentAudio()
        
        // Stop uptime timer
        stopUptimeTimer()
        
        // Reset stats
        startTime = nil
        uptime = 0
        
        logger.info("BLE proxy service stopped")
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
        uptimeTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
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
        do {
            // Decompress the request
            let decompressedData = try await decompressData(data)
            
            // Parse JSON
            let decoder = JSONDecoder()
            let proxyRequest = try decoder.decode(ProxyRequest.self, from: decompressedData)
            
            logger.info("Processing request: \(proxyRequest.method) \(proxyRequest.url)")
            
            // Make HTTP request
            let response = await httpClient.makeRequest(proxyRequest)
            
            logger.info("Received response: \(response.statusCode)")
            
            // Send response back via BLE
            await sendProxyResponse(response)
            
        } catch {
            logger.error("Error processing request: \(error.localizedDescription)")
            
            await MainActor.run {
                self.errorCount += 1
                self.lastError = "Request processing error: \(error.localizedDescription)"
            }
        }
    }
    
    private func sendProxyResponse(_ response: ProxyResponse) async {
        do {
            // Encode response to JSON
            let encoder = JSONEncoder()
            let responseData = try encoder.encode(response)
            
            // Compress response
            let compressedData = try await compressData(responseData)
            
            // Send via BLE to all connected centrals
            for central in bleManager.connectedCentrals {
                bleManager.sendResponse(compressedData, to: central)
            }
            
            logger.info("Response sent via BLE")
            
        } catch {
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
                    let compressedData = try data.compressed(using: .lzfse)
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
                    let decompressedData = try data.decompressed(using: .lzfse)
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
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManagerDidStopAdvertising(_ manager: BLEPeripheralManager) {
        Task { @MainActor in
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManager(_ manager: BLEPeripheralManager, didConnect central: CBCentral) {
        logger.info("Client connected: \(central.identifier)")
        Task { @MainActor in
            updateConnectionStatus()
        }
    }
    
    nonisolated func peripheralManager(_ manager: BLEPeripheralManager, didDisconnect central: CBCentral) {
        logger.info("Client disconnected: \(central.identifier)")
        Task { @MainActor in
            updateConnectionStatus()
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