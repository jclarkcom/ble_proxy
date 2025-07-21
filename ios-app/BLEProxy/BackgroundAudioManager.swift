import Foundation
import AVFoundation
import os.log

class BackgroundAudioManager: ObservableObject {
    @Published var isPlaying = false
    @Published var audioSessionActive = false
    @Published var lastError: String?
    
    private var audioPlayer: AVAudioPlayer?
    private let logger = Logger(subsystem: "com.bleproxy.app", category: "BackgroundAudio")
    
    init() {
        setupAudioSession()
        setupNotifications()
    }
    
    deinit {
        stopSilentAudio()
        NotificationCenter.default.removeObserver(self)
    }
    
    // MARK: - Public Methods
    func startSilentAudio() {
        guard !isPlaying else {
            logger.info("Silent audio already playing")
            return
        }
        
        logger.info("Starting silent audio playback")
        
        do {
            try activateAudioSession()
            try createSilentAudioPlayer()
            
            audioPlayer?.play()
            
            DispatchQueue.main.async {
                self.isPlaying = self.audioPlayer?.isPlaying ?? false
                self.lastError = nil
            }
            
            if isPlaying {
                logger.info("Silent audio started successfully")
            } else {
                logger.error("Failed to start silent audio playback")
                DispatchQueue.main.async {
                    self.lastError = "Failed to start audio playback"
                }
            }
            
        } catch {
            logger.error("Error starting silent audio: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.lastError = error.localizedDescription
                self.isPlaying = false
            }
        }
    }
    
    func stopSilentAudio() {
        logger.info("Stopping silent audio playback")
        
        audioPlayer?.stop()
        audioPlayer = nil
        
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            logger.warning("Error deactivating audio session: \(error.localizedDescription)")
        }
        
        DispatchQueue.main.async {
            self.isPlaying = false
            self.audioSessionActive = false
        }
        
        logger.info("Silent audio stopped")
    }
    
    // MARK: - Private Methods
    private func setupAudioSession() {
        do {
            let audioSession = AVAudioSession.sharedInstance()
            
            // Configure audio session for background audio
            try audioSession.setCategory(
                .playback,
                mode: .default,
                options: [.mixWithOthers, .duckOthers]
            )
            
            logger.info("Audio session configured")
            
        } catch {
            logger.error("Failed to setup audio session: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.lastError = error.localizedDescription
            }
        }
    }
    
    private func activateAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setActive(true)
        
        DispatchQueue.main.async {
            self.audioSessionActive = true
        }
        
        logger.info("Audio session activated")
    }
    
    private func createSilentAudioPlayer() throws {
        // Create silent audio data (1 second of silence)
        let silentAudioData = createSilentAudioData()
        
        // Create temporary file
        let tempURL = createTemporarySilentAudioFile(data: silentAudioData)
        
        // Create audio player
        audioPlayer = try AVAudioPlayer(contentsOf: tempURL)
        audioPlayer?.delegate = self
        audioPlayer?.numberOfLoops = -1 // Infinite loop
        audioPlayer?.volume = 0.0001 // Nearly silent but not completely muted
        audioPlayer?.prepareToPlay()
        
        logger.info("Silent audio player created")
    }
    
    private func createSilentAudioData() -> Data {
        // Create 1 second of silent audio data in WAV format
        let sampleRate: Int32 = 44100
        let channels: Int16 = 1
        let bitsPerSample: Int16 = 16
        let duration: Double = 1.0
        
        let sampleCount = Int(Double(sampleRate) * duration)
        let byteCount = sampleCount * Int(bitsPerSample / 8) * Int(channels)
        
        var wavData = Data()
        
        // WAV Header
        wavData.append("RIFF".data(using: .ascii)!) // ChunkID
        wavData.append(withUnsafeBytes(of: UInt32(36 + byteCount).littleEndian) { Data($0) }) // ChunkSize
        wavData.append("WAVE".data(using: .ascii)!) // Format
        
        // fmt Subchunk
        wavData.append("fmt ".data(using: .ascii)!) // Subchunk1ID
        wavData.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) }) // Subchunk1Size
        wavData.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) }) // AudioFormat (PCM)
        wavData.append(withUnsafeBytes(of: channels.littleEndian) { Data($0) }) // NumChannels
        wavData.append(withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Data($0) }) // SampleRate
        wavData.append(withUnsafeBytes(of: UInt32(sampleRate * Int32(channels * bitsPerSample / 8)).littleEndian) { Data($0) }) // ByteRate
        wavData.append(withUnsafeBytes(of: UInt16(channels * bitsPerSample / 8).littleEndian) { Data($0) }) // BlockAlign
        wavData.append(withUnsafeBytes(of: bitsPerSample.littleEndian) { Data($0) }) // BitsPerSample
        
        // data Subchunk
        wavData.append("data".data(using: .ascii)!) // Subchunk2ID
        wavData.append(withUnsafeBytes(of: UInt32(byteCount).littleEndian) { Data($0) }) // Subchunk2Size
        
        // Silent audio data (all zeros)
        wavData.append(Data(repeating: 0, count: byteCount))
        
        return wavData
    }
    
    private func createTemporarySilentAudioFile(data: Data) -> URL {
        let tempDirectory = FileManager.default.temporaryDirectory
        let tempURL = tempDirectory.appendingPathComponent("silence.wav")
        
        try? data.write(to: tempURL)
        
        return tempURL
    }
    
    private func setupNotifications() {
        // Listen for app state changes
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        
        // Listen for audio session interruptions
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioSessionInterrupted),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        
        // Listen for audio route changes
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioRouteChanged),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }
    
    @objc private func appDidEnterBackground() {
        logger.info("App entered background - ensuring silent audio continues")
        
        // Restart silent audio if it stopped
        if !isPlaying {
            startSilentAudio()
        }
    }
    
    @objc private func appWillEnterForeground() {
        logger.info("App entering foreground")
        
        // Update playing state
        DispatchQueue.main.async {
            self.isPlaying = self.audioPlayer?.isPlaying ?? false
        }
    }
    
    @objc private func audioSessionInterrupted(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }
        
        switch type {
        case .began:
            logger.info("Audio session interrupted")
            DispatchQueue.main.async {
                self.isPlaying = false
            }
            
        case .ended:
            logger.info("Audio session interruption ended")
            
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    logger.info("Resuming silent audio after interruption")
                    startSilentAudio()
                }
            }
            
        @unknown default:
            break
        }
    }
    
    @objc private func audioRouteChanged(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        
        logger.info("Audio route changed: \(reason.rawValue)")
        
        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable:
            // Restart audio if route changed
            if isPlaying {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.startSilentAudio()
                }
            }
        default:
            break
        }
    }
}

// MARK: - AVAudioPlayerDelegate
extension BackgroundAudioManager: AVAudioPlayerDelegate {
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        logger.info("Audio player finished playing - restarting")
        
        // Restart immediately (shouldn't happen with infinite loop, but just in case)
        startSilentAudio()
    }
    
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        logger.error("Audio player decode error: \(error?.localizedDescription ?? "Unknown")")
        
        DispatchQueue.main.async {
            self.lastError = error?.localizedDescription ?? "Audio decode error"
            self.isPlaying = false
        }
        
        // Try to restart
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            self.startSilentAudio()
        }
    }
} 