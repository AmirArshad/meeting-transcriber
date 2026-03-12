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

func sendStatus(_ status: String, message: String? = nil, extra: [String: Any] = [:]) {
    var dict: [String: Any] = ["type": "status", "status": status]
    if let msg = message {
        dict["message"] = msg
    }
    for (key, value) in extra {
        dict[key] = value
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
    private let expectedChannels: Int
    private var isCapturing = false
    private let outputLock = NSLock()
    private let queueLock = NSLock()
    private var sampleCount: Int = 0
    private var totalBytesWritten: Int = 0
    private var firstAudioTime: Date?
    private var lastAudioTime: Date?
    private var silencePeriodLogged = false
    private let silenceThreshold: TimeInterval = 5.0  // Log when silence exceeds 5 seconds

    // Audio format logging state (protected by outputLock)
    private var hasLoggedAudioFormat = false
    private var extractionErrorCount = 0
    private let maxExtractionErrors = 5  // Only log first N errors to avoid spam
    private var pendingAudioChunks: [Data] = []
    private var pendingChunkStartIndex = 0
    private var pendingChunkBytes = 0
    private var droppedChunkCount = 0
    private let maxQueuedBytes = 4 * 1024 * 1024
    private let queueDropWarningInterval = 25
    private let writerSignal = DispatchSemaphore(value: 0)
    private let writerCompletionGroup = DispatchGroup()
    private let writerQueue = DispatchQueue(label: "audio.capture.writer.queue", qos: .userInitiated)
    private var writerIsRunning = false

    private struct EnqueueResult {
        let queuedBytes: Int
        let droppedChunkCount: Int
        let droppedDuringEnqueue: Bool
    }

    init(expectedChannels: Int) {
        self.expectedChannels = expectedChannels
        super.init()
    }

    func startCapturing() {
        outputLock.lock()
        isCapturing = true
        sampleCount = 0
        totalBytesWritten = 0
        firstAudioTime = nil
        lastAudioTime = nil
        silencePeriodLogged = false
        hasLoggedAudioFormat = false
        extractionErrorCount = 0
        outputLock.unlock()

        queueLock.lock()
        pendingAudioChunks.removeAll(keepingCapacity: true)
        pendingChunkStartIndex = 0
        pendingChunkBytes = 0
        droppedChunkCount = 0
        queueLock.unlock()

        ensureWriterLoopStarted()
    }

    func stopCapturing() {
        outputLock.lock()
        isCapturing = false
        outputLock.unlock()

        writerSignal.signal()
        waitForWriterDrain(timeout: 2.0)

        outputLock.lock()
        let finalSampleCount = sampleCount
        let finalBytes = totalBytesWritten
        let finalFirstAudioTimestamp = firstAudioTime?.timeIntervalSince1970
        let finalLastAudioTimestamp = lastAudioTime?.timeIntervalSince1970
        outputLock.unlock()

        queueLock.lock()
        let finalDroppedChunks = droppedChunkCount
        let finalQueuedBytes = pendingChunkBytes
        queueLock.unlock()

        // Log final stats
        sendJSON([
            "type": "capture_stats",
            "totalSamples": finalSampleCount,
            "totalBytes": finalBytes,
            "droppedChunks": finalDroppedChunks,
            "queuedBytesRemaining": finalQueuedBytes,
            "firstAudioTimestamp": finalFirstAudioTimestamp as Any,
            "lastAudioTimestamp": finalLastAudioTimestamp as Any,
        ])
    }

    // SCStreamOutput protocol - receives audio samples
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

        outputLock.lock()
        let capturing = isCapturing
        outputLock.unlock()

        guard capturing else { return }

        // Extract interleaved float32 audio data from the sample buffer.
        // This normalizes planar/non-interleaved buffers into the helper's
        // stdout contract so Python always sees one consistent format.
        guard let audioData = extractInterleavedAudioData(from: sampleBuffer) else {
            return
        }

        // Check for audio resuming after silence (important for meetings where audio starts late)
        let now = Date()
        var shouldLogAudioResumed = false
        var silenceDuration: TimeInterval = 0

        // Single lock region for state updates
        outputLock.lock()
        if firstAudioTime == nil {
            firstAudioTime = now
        }
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

        let enqueueResult = enqueueAudioData(audioData)

        // Single lock region for counter updates
        outputLock.lock()
        sampleCount += 1
        let currentSampleCount = sampleCount
        let currentBytesWritten = totalBytesWritten
        outputLock.unlock()

        if enqueueResult.droppedDuringEnqueue &&
            (enqueueResult.droppedChunkCount == 1 || enqueueResult.droppedChunkCount % queueDropWarningInterval == 0) {
            sendJSON([
                "type": "warning",
                "code": "stdout_backpressure",
                "message": "Audio output queue overflow; dropped \(enqueueResult.droppedChunkCount) chunks",
                "droppedChunks": enqueueResult.droppedChunkCount,
                "queuedBytes": enqueueResult.queuedBytes,
            ])
        }

        if currentSampleCount == 1 {
            sendStatus(
                "first_sample",
                message: "Received first audio sample (\(audioData.count) bytes)",
                extra: ["timestamp": now.timeIntervalSince1970]
            )
        }

        // Log periodic status every ~10 seconds (assuming ~100 samples/sec)
        if currentSampleCount % 1000 == 0 {
            sendJSON([
                "type": "progress",
                "samples": currentSampleCount,
                "bytesWritten": currentBytesWritten,
                "queuedBytes": enqueueResult.queuedBytes,
                "droppedChunks": enqueueResult.droppedChunkCount,
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

    private func ensureWriterLoopStarted() {
        outputLock.lock()
        let shouldStart = !writerIsRunning
        if shouldStart {
            writerIsRunning = true
            writerCompletionGroup.enter()
        }
        outputLock.unlock()

        guard shouldStart else { return }

        writerQueue.async { [weak self] in
            self?.writerLoop()
        }
    }

    private func writerLoop() {
        defer {
            outputLock.lock()
            writerIsRunning = false
            outputLock.unlock()
            writerCompletionGroup.leave()
        }

        while true {
            writerSignal.wait()

            while let chunk = dequeueAudioChunk() {
                FileHandle.standardOutput.write(chunk)

                outputLock.lock()
                totalBytesWritten += chunk.count
                outputLock.unlock()
            }

            if shouldStopWriterLoop() {
                break
            }
        }
    }

    private func enqueueAudioData(_ data: Data) -> EnqueueResult {
        queueLock.lock()
        var droppedDuringEnqueue = false

        while pendingChunkBytes + data.count > maxQueuedBytes && pendingChunkStartIndex < pendingAudioChunks.count {
            let dropped = pendingAudioChunks[pendingChunkStartIndex]
            pendingChunkStartIndex += 1
            pendingChunkBytes -= dropped.count
            droppedChunkCount += 1
            droppedDuringEnqueue = true
        }
        compactPendingAudioChunksIfNeededLocked()

        if pendingChunkBytes + data.count > maxQueuedBytes {
            droppedChunkCount += 1
            let result = EnqueueResult(
                queuedBytes: pendingChunkBytes,
                droppedChunkCount: droppedChunkCount,
                droppedDuringEnqueue: true
            )
            queueLock.unlock()
            return result
        }

        pendingAudioChunks.append(data)
        pendingChunkBytes += data.count

        let result = EnqueueResult(
            queuedBytes: pendingChunkBytes,
            droppedChunkCount: droppedChunkCount,
            droppedDuringEnqueue: droppedDuringEnqueue
        )
        queueLock.unlock()

        writerSignal.signal()
        return result
    }

    private func dequeueAudioChunk() -> Data? {
        queueLock.lock()
        defer { queueLock.unlock() }

        guard pendingChunkStartIndex < pendingAudioChunks.count else {
            compactPendingAudioChunksIfNeededLocked()
            return nil
        }

        let chunk = pendingAudioChunks[pendingChunkStartIndex]
        pendingChunkStartIndex += 1
        pendingChunkBytes -= chunk.count
        compactPendingAudioChunksIfNeededLocked()
        return chunk
    }

    private func compactPendingAudioChunksIfNeededLocked() {
        if pendingChunkStartIndex == pendingAudioChunks.count {
            pendingAudioChunks.removeAll(keepingCapacity: true)
            pendingChunkStartIndex = 0
            return
        }

        if pendingChunkStartIndex > 32 && pendingChunkStartIndex * 2 >= pendingAudioChunks.count {
            pendingAudioChunks.removeFirst(pendingChunkStartIndex)
            pendingChunkStartIndex = 0
        }
    }

    private func shouldStopWriterLoop() -> Bool {
        outputLock.lock()
        let capturing = isCapturing
        outputLock.unlock()

        queueLock.lock()
        let queueEmpty = pendingChunkStartIndex >= pendingAudioChunks.count
        queueLock.unlock()

        return !capturing && queueEmpty
    }

    private func waitForWriterDrain(timeout: TimeInterval) {
        let result = writerCompletionGroup.wait(timeout: .now() + timeout)
        if result == .timedOut {
            sendJSON([
                "type": "warning",
                "code": "writer_drain_timeout",
                "message": "Timed out waiting for audio writer queue to drain"
            ])
        }
    }

    private func extractInterleavedAudioData(from sampleBuffer: CMSampleBuffer) -> Data? {
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

        guard audioFormat.commonFormat == .pcmFormatFloat32 else {
            logExtractionError("Unsupported audio format: \(audioFormat.commonFormat)")
            return nil
        }

        let sourceChannels = Int(audioFormat.channelCount)
        let isInterleaved = audioFormat.isInterleaved

        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        // Empty buffers are normal during silence - don't log as errors
        guard numSamples > 0 else { return nil }

        // Get the audio buffer list
        var blockBuffer: CMBlockBuffer?
        let maxBuffers = max(1, sourceChannels)
        let audioBufferListSize = MemoryLayout<AudioBufferList>.size +
            max(0, maxBuffers - 1) * MemoryLayout<AudioBuffer>.size
        let audioBufferListStorage = UnsafeMutableRawPointer.allocate(
            byteCount: audioBufferListSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        audioBufferListStorage.initializeMemory(as: UInt8.self, repeating: 0, count: audioBufferListSize)
        defer {
            audioBufferListStorage.deallocate()
        }
        let audioBufferList = audioBufferListStorage.assumingMemoryBound(to: AudioBufferList.self)

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList,
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

        let audioBuffers = UnsafeMutableAudioBufferListPointer(audioBufferList)

        if shouldLogFormat {
            let desc = streamBasicDescription.pointee
            sendJSON([
                "type": "audio_format",
                "sampleRate": desc.mSampleRate,
                "channels": desc.mChannelsPerFrame,
                "bitsPerChannel": desc.mBitsPerChannel,
                "bytesPerFrame": desc.mBytesPerFrame,
                "formatFlags": desc.mFormatFlags,
                "bufferCount": audioBuffers.count,
                "interleaved": isInterleaved,
                "expectedChannels": expectedChannels,
            ])
        }

        guard !audioBuffers.isEmpty else {
            logExtractionError("Audio buffer list was empty")
            return nil
        }

        if isInterleaved {
            return interleavedDataFromSingleBuffer(
                audioBuffers[0],
                frameCount: numSamples,
                sourceChannels: sourceChannels,
                outputChannels: expectedChannels
            )
        }

        return interleavedDataFromPlanarBuffers(
            audioBuffers,
            frameCount: numSamples,
            sourceChannels: sourceChannels,
            outputChannels: expectedChannels
        )
    }

    private func interleavedDataFromSingleBuffer(
        _ audioBuffer: AudioBuffer,
        frameCount: Int,
        sourceChannels: Int,
        outputChannels: Int
    ) -> Data? {
        guard let sourceData = audioBuffer.mData else {
            logExtractionError("Interleaved audio buffer mData is nil")
            return nil
        }

        let sourceSampleCount = frameCount * sourceChannels
        let expectedBytes = sourceSampleCount * MemoryLayout<Float>.size
        let availableBytes = Int(audioBuffer.mDataByteSize)

        if availableBytes < expectedBytes {
            logExtractionError("Interleaved buffer size mismatch: have \(availableBytes) bytes, need \(expectedBytes)")
            return nil
        }

        if sourceChannels == outputChannels {
            return Data(bytes: sourceData, count: expectedBytes)
        }

        let samples = sourceData.bindMemory(to: Float.self, capacity: sourceSampleCount)
        var normalized = [Float](repeating: 0, count: frameCount * outputChannels)

        for frame in 0..<frameCount {
            for outputChannel in 0..<outputChannels {
                let sourceChannel = min(outputChannel, sourceChannels - 1)
                normalized[frame * outputChannels + outputChannel] = samples[frame * sourceChannels + sourceChannel]
            }
        }

        return normalized.withUnsafeBufferPointer { pointer in
            guard let baseAddress = pointer.baseAddress else {
                return Data()
            }
            return Data(bytes: baseAddress, count: pointer.count * MemoryLayout<Float>.size)
        }
    }

    private func interleavedDataFromPlanarBuffers(
        _ audioBuffers: UnsafeMutableAudioBufferListPointer,
        frameCount: Int,
        sourceChannels: Int,
        outputChannels: Int
    ) -> Data? {
        if audioBuffers.count < sourceChannels {
            logExtractionError("Planar buffer count mismatch: have \(audioBuffers.count), need \(sourceChannels)")
            return nil
        }

        var normalized = [Float](repeating: 0, count: frameCount * outputChannels)
        var channelPointers: [UnsafePointer<Float>] = []
        channelPointers.reserveCapacity(sourceChannels)

        for channel in 0..<sourceChannels {
            let buffer = audioBuffers[channel]
            guard let channelData = buffer.mData else {
                logExtractionError("Planar channel \(channel) buffer mData is nil")
                return nil
            }

            let availableFrames = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            if availableFrames < frameCount {
                logExtractionError("Planar channel \(channel) size mismatch: have \(availableFrames) frames, need \(frameCount)")
                return nil
            }

            channelPointers.append(channelData.bindMemory(to: Float.self, capacity: frameCount))
        }

        for frame in 0..<frameCount {
            for outputChannel in 0..<outputChannels {
                let sourceChannel = min(outputChannel, sourceChannels - 1)
                normalized[frame * outputChannels + outputChannel] = channelPointers[sourceChannel][frame]
            }
        }

        return normalized.withUnsafeBufferPointer { pointer in
            guard let baseAddress = pointer.baseAddress else {
                return Data()
            }
            return Data(bytes: baseAddress, count: pointer.count * MemoryLayout<Float>.size)
        }
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
        delegate = AudioCaptureDelegate(expectedChannels: config.channels)

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

        if let stream = stream {
            do {
                try await stream.stopCapture()
                sendStatus("stopped", message: "Audio capture stopped")
            } catch {
                sendError("Error stopping capture: \(error.localizedDescription)")
            }
        }

        delegate?.stopCapturing()

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
        case "--check-permission":
            if #available(macOS 13.0, *) {
                Task {
                    do {
                        _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                        sendJSON(["type": "permission_check", "granted": true])
                        exit(0)
                    } catch {
                        let nsError = error as NSError
                        let permissionDenied = nsError.code == -3801 ||
                            nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" ||
                            nsError.localizedDescription.lowercased().contains("permission") ||
                            nsError.localizedDescription.lowercased().contains("denied") ||
                            nsError.localizedDescription.lowercased().contains("not authorized")
                        if permissionDenied {
                            sendJSON([
                                "type": "permission_check",
                                "granted": false,
                                "error": "Screen Recording permission not granted",
                                "help": "Open System Settings > Privacy & Security > Screen Recording and enable this app"
                            ])
                        } else {
                            sendJSON([
                                "type": "permission_check",
                                "granted": false,
                                "error": "Failed to check Screen Recording permission: \(error.localizedDescription)"
                            ])
                        }
                        exit(1)
                    }
                }
                dispatchMain()
            } else {
                sendJSON([
                    "type": "permission_check",
                    "granted": false,
                    "error": "macOS 13.0 or later required"
                ])
                exit(1)
            }
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
