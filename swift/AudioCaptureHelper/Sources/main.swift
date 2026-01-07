/**
 * AudioCaptureHelper - Native Swift helper for capturing desktop audio on macOS
 *
 * This helper uses ScreenCaptureKit to capture system audio and streams it to stdout
 * as raw PCM float32 samples. This bypasses PyObjC issues with ScreenCaptureKit on macOS 15.
 *
 * Usage:
 *   audiocapture-helper --sample-rate 48000 --channels 2
 *
 * Output:
 *   - Raw PCM float32 audio data to stdout
 *   - JSON status messages to stderr
 *
 * Control:
 *   - Send "stop\n" to stdin to stop recording
 *   - Or send SIGTERM/SIGINT
 */

import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation

// MARK: - Configuration

struct Config {
    var sampleRate: Int = 48000
    var channels: Int = 2
    var excludeCurrentApp: Bool = true
}

// MARK: - JSON Output Helpers

func sendJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write("\(str)\n".data(using: .utf8)!)
    }
}

func sendStatus(_ status: String, message: String? = nil) {
    var dict: [String: Any] = ["type": "status", "status": status]
    if let msg = message {
        dict["message"] = msg
    }
    sendJSON(dict)
}

func sendError(_ error: String) {
    sendJSON(["type": "error", "error": error])
}

func sendReady() {
    sendJSON(["type": "ready"])
}

// MARK: - Audio Capture Delegate

@available(macOS 13.0, *)
class AudioCaptureDelegate: NSObject, SCStreamDelegate, SCStreamOutput {
    private var isCapturing = false
    private let outputLock = NSLock()
    private var sampleCount: Int = 0
    private var totalBytesWritten: Int = 0
    private var lastAudioTime: Date?
    private var silencePeriodLogged = false
    private let silenceThreshold: TimeInterval = 5.0  // Log when silence exceeds 5 seconds

    // Audio format logging state (protected by outputLock)
    private var hasLoggedAudioFormat = false
    private var extractionErrorCount = 0
    private let maxExtractionErrors = 5  // Only log first N errors to avoid spam

    func startCapturing() {
        outputLock.lock()
        isCapturing = true
        sampleCount = 0
        totalBytesWritten = 0
        lastAudioTime = nil
        silencePeriodLogged = false
        hasLoggedAudioFormat = false
        extractionErrorCount = 0
        outputLock.unlock()
    }

    func stopCapturing() {
        outputLock.lock()
        let finalSampleCount = sampleCount
        let finalBytes = totalBytesWritten
        isCapturing = false
        outputLock.unlock()

        // Log final stats
        sendJSON([
            "type": "capture_stats",
            "totalSamples": finalSampleCount,
            "totalBytes": finalBytes
        ])
    }

    // SCStreamOutput protocol - receives audio samples
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

        outputLock.lock()
        let capturing = isCapturing
        outputLock.unlock()

        guard capturing else { return }

        // Extract audio data from the sample buffer
        guard let audioBuffer = extractAudioBuffer(from: sampleBuffer) else {
            return
        }

        // Check for audio resuming after silence (important for meetings where audio starts late)
        let now = Date()
        var shouldLogAudioResumed = false
        var silenceDuration: TimeInterval = 0

        // Single lock region for state updates
        outputLock.lock()
        if let lastTime = lastAudioTime {
            silenceDuration = now.timeIntervalSince(lastTime)
            if silenceDuration > silenceThreshold && silencePeriodLogged {
                shouldLogAudioResumed = true
                silencePeriodLogged = false
            }
        }
        lastAudioTime = now
        outputLock.unlock()

        // Log outside of lock to avoid holding lock during I/O
        if shouldLogAudioResumed {
            sendJSON([
                "type": "audio_resumed",
                "silenceDuration": silenceDuration,
                "message": "Audio resumed after \(String(format: "%.1f", silenceDuration)) seconds of silence"
            ])
        }

        // Write raw float32 PCM data to stdout (interleaved stereo)
        // ScreenCaptureKit provides interleaved audio in mBuffers.mData
        // We need to write all channels, not just floatChannelData[0]
        let frameCount = Int(audioBuffer.frameLength)
        let channelCount = Int(audioBuffer.format.channelCount)
        let bytesPerFrame = channelCount * MemoryLayout<Float>.size
        let totalBytes = frameCount * bytesPerFrame

        // Track bytes written for this sample
        var bytesWrittenThisSample = 0

        // Get interleaved data directly from the audio buffer
        if audioBuffer.format.isInterleaved {
            // Interleaved format - data is already in the correct format
            if let channelData = audioBuffer.floatChannelData?[0] {
                let data = Data(bytes: channelData, count: totalBytes)
                FileHandle.standardOutput.write(data)
                bytesWrittenThisSample = totalBytes
            }
        } else {
            // Non-interleaved (planar) format - need to interleave manually
            guard let channelData = audioBuffer.floatChannelData else { return }

            var interleavedData = [Float](repeating: 0, count: frameCount * channelCount)
            for frame in 0..<frameCount {
                for channel in 0..<channelCount {
                    interleavedData[frame * channelCount + channel] = channelData[channel][frame]
                }
            }

            interleavedData.withUnsafeBytes { ptr in
                FileHandle.standardOutput.write(Data(ptr))
            }
            bytesWrittenThisSample = frameCount * channelCount * MemoryLayout<Float>.size
        }

        // Single lock region for counter updates
        outputLock.lock()
        totalBytesWritten += bytesWrittenThisSample
        sampleCount += 1
        let currentSampleCount = sampleCount
        let currentBytesWritten = totalBytesWritten
        outputLock.unlock()

        if currentSampleCount == 1 {
            sendStatus("first_sample", message: "Received first audio sample (\(totalBytes) bytes)")
        }

        // Log periodic status every ~10 seconds (assuming ~100 samples/sec)
        if currentSampleCount % 1000 == 0 {
            sendJSON([
                "type": "progress",
                "samples": currentSampleCount,
                "bytesWritten": currentBytesWritten
            ])
        }
    }

    // Called periodically to check for silence (call from a timer if needed)
    func checkForSilence() {
        outputLock.lock()
        guard isCapturing, let lastTime = lastAudioTime else {
            outputLock.unlock()
            return
        }
        let silenceDuration = Date().timeIntervalSince(lastTime)
        let alreadyLogged = silencePeriodLogged
        if silenceDuration > silenceThreshold && !alreadyLogged {
            silencePeriodLogged = true
            outputLock.unlock()
            sendJSON([
                "type": "silence_detected",
                "duration": silenceDuration,
                "message": "No audio received for \(String(format: "%.1f", silenceDuration)) seconds (this is normal if no audio is playing)"
            ])
        } else {
            outputLock.unlock()
        }
    }

    private func extractAudioBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        // Get format description
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            logExtractionError("No format description in sample buffer")
            return nil
        }

        guard let streamBasicDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            logExtractionError("Could not get stream basic description from format")
            return nil
        }

        // Log audio format on first successful extraction (thread-safe check)
        outputLock.lock()
        let shouldLogFormat = !hasLoggedAudioFormat
        if shouldLogFormat {
            hasLoggedAudioFormat = true
        }
        outputLock.unlock()

        if shouldLogFormat {
            let desc = streamBasicDescription.pointee
            sendJSON([
                "type": "audio_format",
                "sampleRate": desc.mSampleRate,
                "channels": desc.mChannelsPerFrame,
                "bitsPerChannel": desc.mBitsPerChannel,
                "bytesPerFrame": desc.mBytesPerFrame,
                "formatFlags": desc.mFormatFlags
            ])
        }

        let audioFormat = AVAudioFormat(streamDescription: streamBasicDescription)
        guard let audioFormat = audioFormat else {
            logExtractionError("Could not create AVAudioFormat from stream description")
            return nil
        }

        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        // Empty buffers are normal during silence - don't log as errors
        guard numSamples > 0 else { return nil }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: AVAudioFrameCount(numSamples)) else {
            logExtractionError("Could not create PCM buffer with capacity \(numSamples)")
            return nil
        }
        pcmBuffer.frameLength = AVAudioFrameCount(numSamples)

        // Get the audio buffer list
        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList()
        let audioBufferListSize = MemoryLayout<AudioBufferList>.size

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: audioBufferListSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )

        guard status == noErr else {
            logExtractionError("CMSampleBufferGetAudioBufferList failed with status: \(status)")
            return nil
        }

        // Copy audio data to PCM buffer
        let srcBuffer = audioBufferList.mBuffers
        guard let srcData = srcBuffer.mData else {
            logExtractionError("Audio buffer mData is nil")
            return nil
        }

        guard let dstData = pcmBuffer.floatChannelData?[0] else {
            logExtractionError("PCM buffer floatChannelData is nil")
            return nil
        }

        // Validate buffer sizes before copy
        let expectedBytes = Int(pcmBuffer.frameLength) * Int(audioFormat.channelCount) * MemoryLayout<Float>.size
        let availableBytes = Int(srcBuffer.mDataByteSize)

        if availableBytes < expectedBytes {
            // Buffer size mismatch - return nil to avoid corrupted audio
            // Copying partial data would leave frameLength incorrect
            logExtractionError("Buffer size mismatch: have \(availableBytes) bytes, need \(expectedBytes) - skipping frame")
            return nil
        }

        memcpy(dstData, srcData, expectedBytes)
        return pcmBuffer
    }

    private func logExtractionError(_ message: String) {
        // Thread-safe error counting
        outputLock.lock()
        extractionErrorCount += 1
        let currentCount = extractionErrorCount
        let maxErrors = maxExtractionErrors
        outputLock.unlock()

        // Log outside of lock to avoid holding lock during I/O
        if currentCount <= maxErrors {
            sendJSON(["type": "extraction_error", "error": message, "count": currentCount])
        } else if currentCount == maxErrors + 1 {
            sendJSON(["type": "extraction_error", "error": "Too many extraction errors, suppressing further logs", "count": currentCount])
        }
    }

    // SCStreamDelegate protocol
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        sendError("Stream stopped: \(error.localizedDescription)")
    }
}

// MARK: - Main Capture Class

@available(macOS 13.0, *)
class AudioCapture {
    private var stream: SCStream?
    private var delegate: AudioCaptureDelegate?
    private var config: Config
    private var isRunning = false
    private var silenceCheckTimer: DispatchSourceTimer?

    init(config: Config) {
        self.config = config
    }

    private func startSilenceCheckTimer() {
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 5.0, repeating: 5.0)
        timer.setEventHandler { [weak self] in
            self?.delegate?.checkForSilence()
        }
        timer.resume()
        silenceCheckTimer = timer
    }

    private func stopSilenceCheckTimer() {
        silenceCheckTimer?.cancel()
        silenceCheckTimer = nil
    }

    func start() async throws {
        sendStatus("initializing", message: "Getting shareable content...")

        // Get available content to capture
        // This call will fail if Screen Recording permission is not granted
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            // Check for specific permission-related errors
            let nsError = error as NSError

            // SCStreamError codes: userDeclined = -3801, failedToStart = -3802, etc.
            // Also check for common permission denial patterns
            if nsError.code == -3801 ||
               nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" ||
               nsError.localizedDescription.lowercased().contains("permission") ||
               nsError.localizedDescription.lowercased().contains("denied") ||
               nsError.localizedDescription.lowercased().contains("not authorized") {
                sendJSON([
                    "type": "error",
                    "code": "permission_denied",
                    "error": "Screen Recording permission not granted",
                    "help": "Open System Settings > Privacy & Security > Screen Recording and enable this app"
                ])
            } else {
                sendJSON([
                    "type": "error",
                    "code": "screencapture_failed",
                    "error": "Failed to access screen capture: \(error.localizedDescription)",
                    "nsErrorCode": nsError.code,
                    "nsErrorDomain": nsError.domain
                ])
            }
            throw error
        }

        guard let display = content.displays.first else {
            sendJSON([
                "type": "error",
                "code": "no_display",
                "error": "No display found for screen capture"
            ])
            throw NSError(domain: "AudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        sendStatus("configuring", message: "Setting up audio capture for display: \(display.displayID)")

        // Create content filter - capture entire display audio
        // Use excludingApplications API (preferred for audio capture) instead of excludingWindows
        // Empty array = capture audio from ALL applications (browsers, Zoom, Spotify, etc.)
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

        // Configure stream for audio only
        let streamConfig = SCStreamConfiguration()
        streamConfig.width = 2  // Minimal video (required but not used)
        streamConfig.height = 2
        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: 1)  // 1 FPS minimum
        streamConfig.capturesAudio = true
        streamConfig.sampleRate = config.sampleRate
        streamConfig.channelCount = config.channels

        // Exclude current app from capture to avoid feedback
        if config.excludeCurrentApp {
            streamConfig.excludesCurrentProcessAudio = true
        }

        // Create delegate
        delegate = AudioCaptureDelegate()

        // Create stream
        stream = SCStream(filter: filter, configuration: streamConfig, delegate: delegate)

        guard let stream = stream, let delegate = delegate else {
            sendJSON([
                "type": "error",
                "code": "stream_creation_failed",
                "error": "Failed to create SCStream"
            ])
            throw NSError(domain: "AudioCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create stream"])
        }

        // Add stream output for audio
        do {
            try stream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio.capture.queue"))
        } catch {
            sendJSON([
                "type": "error",
                "code": "stream_output_failed",
                "error": "Failed to add audio output: \(error.localizedDescription)"
            ])
            throw error
        }

        sendStatus("starting", message: "Starting audio capture...")

        // Start capture - this can also fail due to permission issues
        delegate.startCapturing()
        do {
            try await stream.startCapture()
        } catch {
            delegate.stopCapturing()
            let nsError = error as NSError

            if nsError.code == -3801 ||
               nsError.localizedDescription.lowercased().contains("permission") {
                sendJSON([
                    "type": "error",
                    "code": "permission_denied",
                    "error": "Screen Recording permission not granted",
                    "help": "Open System Settings > Privacy & Security > Screen Recording and enable this app"
                ])
            } else {
                sendJSON([
                    "type": "error",
                    "code": "capture_start_failed",
                    "error": "Failed to start capture: \(error.localizedDescription)",
                    "nsErrorCode": nsError.code,
                    "nsErrorDomain": nsError.domain
                ])
            }
            throw error
        }

        isRunning = true

        // Start timer to periodically check for silence
        startSilenceCheckTimer()

        sendReady()
        sendStatus("recording", message: "Desktop audio capture active")
    }

    func stop() async {
        guard isRunning else { return }
        isRunning = false

        // Stop the silence check timer
        stopSilenceCheckTimer()

        delegate?.stopCapturing()

        if let stream = stream {
            do {
                try await stream.stopCapture()
                sendStatus("stopped", message: "Audio capture stopped")
            } catch {
                sendError("Error stopping capture: \(error.localizedDescription)")
            }
        }

        stream = nil
        delegate = nil
    }
}

// MARK: - Command Line Interface

func parseArguments() -> Config {
    var config = Config()
    let args = CommandLine.arguments

    var i = 1
    while i < args.count {
        switch args[i] {
        case "--sample-rate", "-r":
            if i + 1 < args.count, let rate = Int(args[i + 1]) {
                config.sampleRate = rate
                i += 1
            }
        case "--channels", "-c":
            if i + 1 < args.count, let ch = Int(args[i + 1]) {
                config.channels = ch
                i += 1
            }
        case "--include-self":
            config.excludeCurrentApp = false
        case "--help", "-h":
            printUsage()
            exit(0)
        default:
            break
        }
        i += 1
    }

    return config
}

func printUsage() {
    let usage = """
    AudioCaptureHelper - Capture desktop audio using ScreenCaptureKit

    Usage: audiocapture-helper [options]

    Options:
      --sample-rate, -r <rate>   Sample rate in Hz (default: 48000)
      --channels, -c <num>       Number of channels (default: 2)
      --include-self             Include audio from this process
      --help, -h                 Show this help

    Output:
      - Raw PCM float32 audio data to stdout
      - JSON status messages to stderr

    Control:
      - Send "stop" to stdin to stop recording
      - Or send SIGTERM/SIGINT

    Example:
      audiocapture-helper --sample-rate 48000 --channels 2
    """
    FileHandle.standardError.write(usage.data(using: .utf8)!)
}

// MARK: - Main Entry Point

@available(macOS 13.0, *)
func main() async {
    let config = parseArguments()

    sendStatus("init", message: "AudioCaptureHelper starting")
    sendJSON([
        "type": "config",
        "sampleRate": config.sampleRate,
        "channels": config.channels
    ])

    let capture = AudioCapture(config: config)

    // Set up signal handlers for graceful shutdown
    let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    signalSource.setEventHandler {
        Task {
            await capture.stop()
            exit(0)
        }
    }
    signalSource.resume()
    signal(SIGTERM, SIG_IGN)

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    intSource.setEventHandler {
        Task {
            await capture.stop()
            exit(0)
        }
    }
    intSource.resume()
    signal(SIGINT, SIG_IGN)

    // Start capture
    do {
        try await capture.start()
    } catch {
        sendError("Failed to start capture: \(error.localizedDescription)")
        exit(1)
    }

    // Listen for "stop" command on stdin
    let stdinSource = DispatchSource.makeReadSource(fileDescriptor: FileHandle.standardInput.fileDescriptor, queue: .global())
    stdinSource.setEventHandler {
        let data = FileHandle.standardInput.availableData
        if let str = String(data: data, encoding: .utf8)?.lowercased() {
            if str.contains("stop") {
                Task {
                    await capture.stop()
                    exit(0)
                }
            }
        }
    }
    stdinSource.resume()

    // Note: dispatchMain() in the entry point keeps the process alive
    // This function returns but the process continues running
}

// Run main
if #available(macOS 13.0, *) {
    // Start main async task
    Task {
        await main()
    }
    // Keep the main thread alive to process events (never returns)
    dispatchMain()
} else {
    sendError("macOS 13.0 or later required")
    exit(1)
}
