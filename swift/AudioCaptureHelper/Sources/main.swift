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
import CoreAudio

// MARK: - Configuration

struct Config {
    var sampleRate: Int = 48000
    var channels: Int = 2
    var excludeCurrentApp: Bool = true
    var preferCoreAudioTap: Bool = true
}

// MARK: - JSON Output Helpers

var emittedStartupError = false

func sendJSON(_ dict: [String: Any]) {
    if let type = dict["type"] as? String, type == "error" {
        emittedStartupError = true
    }

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

func osStatusDescription(_ status: OSStatus) -> String {
    let raw = UInt32(bitPattern: status)
    let bytes = [
        UInt8((raw >> 24) & 0xff),
        UInt8((raw >> 16) & 0xff),
        UInt8((raw >> 8) & 0xff),
        UInt8(raw & 0xff),
    ]

    if bytes.allSatisfy({ $0 >= 32 && $0 <= 126 }),
       let fourCC = String(bytes: bytes, encoding: .ascii) {
        return "\(status) ('\(fourCC)')"
    }

    return "\(status)"
}

func makeCoreAudioError(_ message: String, status: OSStatus) -> NSError {
    NSError(
        domain: "AudioCaptureHelper.CoreAudio",
        code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "\(message) (OSStatus \(osStatusDescription(status)))"]
    )
}

protocol SystemAudioCaptureBackend: AnyObject {
    var running: Bool { get }
    func start() throws
    func stop()
    func checkForSilence()
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
    private var screenFrameCount = 0

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
        screenFrameCount = 0
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
        let finalScreenFrameCount = screenFrameCount
        let finalFirstAudioTimestamp = firstAudioTime?.timeIntervalSince1970
        let finalLastAudioTimestamp = lastAudioTime?.timeIntervalSince1970
        outputLock.unlock()

        queueLock.lock()
        let finalDroppedChunks = droppedChunkCount
        let finalQueuedBytes = pendingChunkBytes
        queueLock.unlock()

        // Log final stats
        var stats: [String: Any] = [
            "type": "capture_stats",
            "totalSamples": finalSampleCount,
            "totalBytes": finalBytes,
            "screenFrames": finalScreenFrameCount,
            "droppedChunks": finalDroppedChunks,
            "queuedBytesRemaining": finalQueuedBytes,
        ]
        if let finalFirstAudioTimestamp {
            stats["firstAudioTimestamp"] = finalFirstAudioTimestamp
        }
        if let finalLastAudioTimestamp {
            stats["lastAudioTimestamp"] = finalLastAudioTimestamp
        }
        sendJSON(stats)
    }

    // SCStreamOutput protocol - receives audio samples
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .screen {
            outputLock.lock()
            screenFrameCount += 1
            let currentScreenFrameCount = screenFrameCount
            outputLock.unlock()

            if currentScreenFrameCount == 1 {
                sendStatus(
                    "screen_sample",
                    message: "Received first screen sample; video frames are discarded",
                    extra: ["screenFrames": currentScreenFrameCount]
                )
            }
            return
        }

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

        if isInterleaved && audioBuffers.count == 1 {
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

// MARK: - CoreAudio Process Tap Capture

@available(macOS 14.2, *)
class CoreAudioTapCapture: SystemAudioCaptureBackend {
    private let config: Config
    private let outputLock = NSLock()
    private let queueLock = NSLock()
    private let writerSignal = DispatchSemaphore(value: 0)
    private let writerCompletionGroup = DispatchGroup()
    private let writerQueue = DispatchQueue(label: "audio.capture.coreaudio.writer.queue", qos: .userInitiated)
    private let callbackQueue = DispatchQueue(label: "audio.capture.coreaudio.io.queue", qos: .userInitiated)

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var streamFormat = AudioStreamBasicDescription()
    private var isRunning = false
    private var writerIsRunning = false
    private var pendingAudioChunks: [Data] = []
    private var pendingChunkStartIndex = 0
    private var pendingChunkBytes = 0
    private var droppedChunkCount = 0
    private var totalBuffers = 0
    private var totalBytesWritten = 0
    private var firstAudioTime: Date?
    private var lastAudioTime: Date?
    private var silencePeriodLogged = false
    private var audioFormatLogged = false
    private var extractionErrorCount = 0

    private let maxQueuedBytes = 4 * 1024 * 1024
    private let queueDropWarningInterval = 25
    private let silenceThreshold: TimeInterval = 5.0
    private let maxExtractionErrors = 5

    private struct EnqueueResult {
        let queuedBytes: Int
        let droppedChunkCount: Int
        let droppedDuringEnqueue: Bool
    }

    init(config: Config) {
        self.config = config
    }

    var running: Bool {
        outputLock.lock()
        let value = isRunning
        outputLock.unlock()
        return value
    }

    func start() throws {
        sendStatus("tap_initializing", message: "Starting CoreAudio process tap...")

        outputLock.lock()
        isRunning = true
        totalBuffers = 0
        totalBytesWritten = 0
        firstAudioTime = nil
        lastAudioTime = nil
        silencePeriodLogged = false
        audioFormatLogged = false
        extractionErrorCount = 0
        outputLock.unlock()

        queueLock.lock()
        pendingAudioChunks.removeAll(keepingCapacity: true)
        pendingChunkStartIndex = 0
        pendingChunkBytes = 0
        droppedChunkCount = 0
        queueLock.unlock()

        do {
            try createTapAndAggregateDevice()
            ensureWriterLoopStarted()
            try createAndStartIOProc()
        } catch {
            cleanupAfterFailedStart()
            throw error
        }

        sendReady()
        sendStatus("recording", message: "CoreAudio process tap active")
    }

    func stop() {
        outputLock.lock()
        let wasRunning = isRunning
        isRunning = false
        outputLock.unlock()

        if wasRunning {
            if let ioProcID {
                let stopStatus = AudioDeviceStop(aggregateDeviceID, ioProcID)
                if stopStatus != noErr {
                    sendJSON([
                        "type": "warning",
                        "code": "coreaudio_tap_stop_failed",
                        "message": "AudioDeviceStop failed with OSStatus \(osStatusDescription(stopStatus))",
                    ])
                }

                let destroyStatus = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
                if destroyStatus != noErr {
                    sendJSON([
                        "type": "warning",
                        "code": "coreaudio_tap_ioproc_destroy_failed",
                        "message": "AudioDeviceDestroyIOProcID failed with OSStatus \(osStatusDescription(destroyStatus))",
                    ])
                }
                self.ioProcID = nil
            }
        }

        writerSignal.signal()
        waitForWriterDrain(timeout: 2.0)
        destroyAggregateAndTap()

        outputLock.lock()
        let finalBuffers = totalBuffers
        let finalBytes = totalBytesWritten
        let finalFirstAudioTimestamp = firstAudioTime?.timeIntervalSince1970
        let finalLastAudioTimestamp = lastAudioTime?.timeIntervalSince1970
        outputLock.unlock()

        queueLock.lock()
        let finalDroppedChunks = droppedChunkCount
        let finalQueuedBytes = pendingChunkBytes
        queueLock.unlock()

        var stats: [String: Any] = [
            "type": "capture_stats",
            "captureBackend": "coreaudio_tap",
            "totalSamples": finalBuffers,
            "totalBytes": finalBytes,
            "screenFrames": 0,
            "droppedChunks": finalDroppedChunks,
            "queuedBytesRemaining": finalQueuedBytes,
        ]
        if let finalFirstAudioTimestamp {
            stats["firstAudioTimestamp"] = finalFirstAudioTimestamp
        }
        if let finalLastAudioTimestamp {
            stats["lastAudioTimestamp"] = finalLastAudioTimestamp
        }
        sendJSON(stats)
        sendStatus("stopped", message: "CoreAudio process tap stopped")
    }

    func checkForSilence() {
        outputLock.lock()
        guard isRunning, let lastTime = lastAudioTime else {
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
                "captureBackend": "coreaudio_tap",
                "duration": silenceDuration,
                "message": "No CoreAudio tap data received for \(String(format: "%.1f", silenceDuration)) seconds (this is normal if no audio is playing)"
            ])
        } else {
            outputLock.unlock()
        }
    }

    private func createTapAndAggregateDevice() throws {
        let excludedProcesses = config.excludeCurrentApp ? currentAudioProcessObjectIDs() : []
        let tapDescription = config.channels == 1
            ? CATapDescription(monoGlobalTapButExcludeProcesses: excludedProcesses)
            : CATapDescription(stereoGlobalTapButExcludeProcesses: excludedProcesses)

        let uuid = UUID()
        tapDescription.name = "AvaNevis System Audio"
        tapDescription.uuid = uuid
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = CATapMuteBehavior(rawValue: 0)!

        var createdTapID = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(tapDescription, &createdTapID)
        guard tapStatus == noErr else {
            throw makeCoreAudioError("AudioHardwareCreateProcessTap failed", status: tapStatus)
        }
        tapID = createdTapID

        try loadTapFormat()

        let aggregateUID = "com.avanevis.app.audiocapture-helper.tap.\(UUID().uuidString)"
        let aggregateDescription: [String: Any] = [
            String(kAudioAggregateDeviceUIDKey): aggregateUID,
            String(kAudioAggregateDeviceNameKey): "AvaNevis System Audio Capture",
            String(kAudioAggregateDeviceIsPrivateKey): true,
            String(kAudioAggregateDeviceTapListKey): [[String(kAudioSubTapUIDKey): uuid.uuidString]],
            String(kAudioAggregateDeviceTapAutoStartKey): false,
        ]

        var createdAggregateID = AudioObjectID(kAudioObjectUnknown)
        let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &createdAggregateID)
        guard aggregateStatus == noErr else {
            throw makeCoreAudioError("AudioHardwareCreateAggregateDevice failed", status: aggregateStatus)
        }
        aggregateDeviceID = createdAggregateID

        setAggregateNominalSampleRateIfPossible()
        try verifyAggregateNominalSampleRate()

        sendJSON([
            "type": "stream_config",
            "captureBackend": "coreaudio_tap",
            "capturesAudio": true,
            "sampleRate": config.sampleRate,
            "channelCount": config.channels,
            "tapSampleRate": streamFormat.mSampleRate,
            "tapChannels": streamFormat.mChannelsPerFrame,
            "tapFormatID": streamFormat.mFormatID,
            "tapFormatFlags": streamFormat.mFormatFlags,
            "tapBytesPerFrame": streamFormat.mBytesPerFrame,
            "tapFramesPerPacket": streamFormat.mFramesPerPacket,
            "excludedProcessCount": excludedProcesses.count,
        ])
    }

    private func createAndStartIOProc() throws {
        var procID: AudioDeviceIOProcID?
        let createStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateDeviceID, callbackQueue) { [weak self] _, inputData, _, _, _ in
            self?.handleInputData(inputData)
        }

        guard createStatus == noErr, let procID else {
            throw makeCoreAudioError("AudioDeviceCreateIOProcIDWithBlock failed", status: createStatus)
        }

        ioProcID = procID

        let startStatus = AudioDeviceStart(aggregateDeviceID, procID)
        guard startStatus == noErr else {
            _ = AudioDeviceDestroyIOProcID(aggregateDeviceID, procID)
            ioProcID = nil
            throw makeCoreAudioError("AudioDeviceStart failed", status: startStatus)
        }
    }

    private func handleInputData(_ inputData: UnsafePointer<AudioBufferList>) {
        outputLock.lock()
        let capturing = isRunning
        outputLock.unlock()
        guard capturing else { return }

        logTapAudioFormatIfNeeded(inputData)

        guard let audioData = extractInterleavedAudioData(inputData) else {
            return
        }

        let now = Date()
        var shouldLogAudioResumed = false
        var silenceDuration: TimeInterval = 0

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

        if shouldLogAudioResumed {
            sendJSON([
                "type": "audio_resumed",
                "captureBackend": "coreaudio_tap",
                "silenceDuration": silenceDuration,
                "message": "CoreAudio tap data resumed after \(String(format: "%.1f", silenceDuration)) seconds of silence"
            ])
        }

        let enqueueResult = enqueueAudioData(audioData)

        outputLock.lock()
        totalBuffers += 1
        let currentBufferCount = totalBuffers
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

        if currentBufferCount == 1 {
            sendStatus(
                "first_sample",
                message: "Received first CoreAudio tap sample (\(audioData.count) bytes)",
                extra: ["timestamp": now.timeIntervalSince1970, "captureBackend": "coreaudio_tap"]
            )
        }

        if currentBufferCount % 1000 == 0 {
            sendJSON([
                "type": "progress",
                "captureBackend": "coreaudio_tap",
                "samples": currentBufferCount,
                "bytesWritten": currentBytesWritten,
                "queuedBytes": enqueueResult.queuedBytes,
                "droppedChunks": enqueueResult.droppedChunkCount,
            ])
        }
    }

    private func currentAudioProcessObjectIDs() -> [AudioObjectID] {
        var pid = getpid()
        var processObjectID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = withUnsafePointer(to: &pid) { pidPointer in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                UInt32(MemoryLayout<pid_t>.size),
                pidPointer,
                &size,
                &processObjectID
            )
        }

        if status != noErr || processObjectID == kAudioObjectUnknown {
            sendJSON([
                "type": "warning",
                "code": "coreaudio_self_exclusion_unavailable",
                "message": "Could not resolve helper process object for CoreAudio tap exclusion",
                "osStatus": status,
                "osStatusText": osStatusDescription(status),
            ])
            return []
        }

        return [processObjectID]
    }

    private func loadTapFormat() throws {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format)
        guard status == noErr else {
            throw makeCoreAudioError("AudioObjectGetPropertyData(kAudioTapPropertyFormat) failed", status: status)
        }
        streamFormat = format
    }

    private func setAggregateNominalSampleRateIfPossible() {
        var sampleRate = Float64(config.sampleRate)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectSetPropertyData(
            aggregateDeviceID,
            &address,
            0,
            nil,
            UInt32(MemoryLayout<Float64>.size),
            &sampleRate
        )

        if status != noErr {
            sendJSON([
                "type": "warning",
                "code": "coreaudio_sample_rate_set_failed",
                "message": "Could not set CoreAudio tap aggregate sample rate; using tap format sample rate",
                "osStatus": status,
                "osStatusText": osStatusDescription(status),
                "tapSampleRate": streamFormat.mSampleRate,
            ])
        }
    }

    private func readAggregateNominalSampleRate() throws -> Float64 {
        var sampleRate = Float64(0)
        var size = UInt32(MemoryLayout<Float64>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            aggregateDeviceID,
            &address,
            0,
            nil,
            &size,
            &sampleRate
        )

        guard status == noErr else {
            throw makeCoreAudioError("AudioObjectGetPropertyData(kAudioDevicePropertyNominalSampleRate) failed", status: status)
        }
        return sampleRate
    }

    private func verifyAggregateNominalSampleRate() throws {
        let expectedSampleRate = Float64(config.sampleRate)
        var actualSampleRate = try readAggregateNominalSampleRate()
        for attempt in 0..<3 where abs(actualSampleRate - expectedSampleRate) > 1.0 {
            usleep(useconds_t((attempt + 1) * 10_000))
            actualSampleRate = try readAggregateNominalSampleRate()
        }
        guard abs(actualSampleRate - expectedSampleRate) <= 2.0 else {
            throw NSError(
                domain: "AudioCaptureHelper.CoreAudio",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "CoreAudio tap sample rate mismatch: expected \(config.sampleRate) Hz, got \(String(format: "%.1f", actualSampleRate)) Hz"]
            )
        }
    }

    private func logTapAudioFormatIfNeeded(_ inputData: UnsafePointer<AudioBufferList>) {
        outputLock.lock()
        let shouldLog = !audioFormatLogged
        if shouldLog {
            audioFormatLogged = true
        }
        outputLock.unlock()

        guard shouldLog else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        sendJSON([
            "type": "audio_format",
            "captureBackend": "coreaudio_tap",
            "sampleRate": streamFormat.mSampleRate,
            "channels": streamFormat.mChannelsPerFrame,
            "bitsPerChannel": streamFormat.mBitsPerChannel,
            "bytesPerFrame": streamFormat.mBytesPerFrame,
            "formatID": streamFormat.mFormatID,
            "formatFlags": streamFormat.mFormatFlags,
            "bufferCount": buffers.count,
            "interleaved": !isNonInterleaved(streamFormat),
            "expectedChannels": config.channels,
        ])
    }

    private func extractInterleavedAudioData(_ inputData: UnsafePointer<AudioBufferList>) -> Data? {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard !buffers.isEmpty else {
            logExtractionError("CoreAudio tap buffer list was empty")
            return nil
        }

        guard streamFormat.mFormatID == kAudioFormatLinearPCM,
              (streamFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0,
              streamFormat.mBitsPerChannel == 32 else {
            logExtractionError(
                "Unsupported CoreAudio tap format: formatID=\(streamFormat.mFormatID), flags=\(streamFormat.mFormatFlags), bits=\(streamFormat.mBitsPerChannel)"
            )
            return nil
        }

        if buffers.count > 1 || isNonInterleaved(streamFormat) {
            return interleavedDataFromPlanarBuffers(buffers)
        }

        return interleavedDataFromSingleBuffer(buffers[0])
    }

    private func interleavedDataFromSingleBuffer(_ audioBuffer: AudioBuffer) -> Data? {
        guard let sourceData = audioBuffer.mData else {
            return nil
        }

        let sourceChannels = max(1, Int(audioBuffer.mNumberChannels) > 0 ? Int(audioBuffer.mNumberChannels) : Int(streamFormat.mChannelsPerFrame))
        let outputChannels = max(1, config.channels)
        let availableBytes = Int(audioBuffer.mDataByteSize)
        guard availableBytes >= MemoryLayout<Float>.size * sourceChannels else {
            return nil
        }

        let sourceFrameCount = availableBytes / (MemoryLayout<Float>.size * sourceChannels)
        if sourceChannels == outputChannels {
            return Data(bytes: sourceData, count: sourceFrameCount * sourceChannels * MemoryLayout<Float>.size)
        }

        let sourceSampleCount = sourceFrameCount * sourceChannels
        let samples = sourceData.bindMemory(to: Float.self, capacity: sourceSampleCount)
        var normalized = [Float](repeating: 0, count: sourceFrameCount * outputChannels)

        for frame in 0..<sourceFrameCount {
            for outputChannel in 0..<outputChannels {
                let sourceChannel = min(outputChannel, sourceChannels - 1)
                normalized[frame * outputChannels + outputChannel] = samples[frame * sourceChannels + sourceChannel]
            }
        }

        return normalized.withUnsafeBufferPointer { pointer in
            guard let baseAddress = pointer.baseAddress else { return Data() }
            return Data(bytes: baseAddress, count: pointer.count * MemoryLayout<Float>.size)
        }
    }

    private func interleavedDataFromPlanarBuffers(_ audioBuffers: UnsafeMutableAudioBufferListPointer) -> Data? {
        let streamChannels = max(1, Int(streamFormat.mChannelsPerFrame))
        let sourceChannels = max(1, min(max(streamChannels, audioBuffers.count), audioBuffers.count))
        let outputChannels = max(1, config.channels)

        guard audioBuffers.count >= sourceChannels else {
            logExtractionError("CoreAudio tap planar buffer count mismatch: have \(audioBuffers.count), need \(sourceChannels)")
            return nil
        }

        let frameCount = Int(audioBuffers[0].mDataByteSize) / MemoryLayout<Float>.size
        guard frameCount > 0 else { return nil }

        var channelPointers: [UnsafePointer<Float>] = []
        channelPointers.reserveCapacity(sourceChannels)

        for channel in 0..<sourceChannels {
            let buffer = audioBuffers[channel]
            guard let channelData = buffer.mData else {
                return nil
            }

            let availableFrames = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            if availableFrames < frameCount {
                logExtractionError("CoreAudio tap planar channel \(channel) size mismatch: have \(availableFrames), need \(frameCount)")
                return nil
            }

            channelPointers.append(channelData.bindMemory(to: Float.self, capacity: frameCount))
        }

        var normalized = [Float](repeating: 0, count: frameCount * outputChannels)
        for frame in 0..<frameCount {
            for outputChannel in 0..<outputChannels {
                let sourceChannel = min(outputChannel, sourceChannels - 1)
                normalized[frame * outputChannels + outputChannel] = channelPointers[sourceChannel][frame]
            }
        }

        return normalized.withUnsafeBufferPointer { pointer in
            guard let baseAddress = pointer.baseAddress else { return Data() }
            return Data(bytes: baseAddress, count: pointer.count * MemoryLayout<Float>.size)
        }
    }

    private func isNonInterleaved(_ format: AudioStreamBasicDescription) -> Bool {
        (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    }

    private func logExtractionError(_ message: String) {
        outputLock.lock()
        extractionErrorCount += 1
        let currentCount = extractionErrorCount
        let maxErrors = maxExtractionErrors
        outputLock.unlock()

        if currentCount <= maxErrors {
            sendJSON(["type": "extraction_error", "captureBackend": "coreaudio_tap", "error": message, "count": currentCount])
        } else if currentCount == maxErrors + 1 {
            sendJSON(["type": "extraction_error", "captureBackend": "coreaudio_tap", "error": "Too many CoreAudio tap extraction errors, suppressing further logs", "count": currentCount])
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
        let capturing = isRunning
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
                "message": "Timed out waiting for CoreAudio tap writer queue to drain"
            ])
        }
    }

    private func cleanupAfterFailedStart() {
        outputLock.lock()
        isRunning = false
        outputLock.unlock()

        if let ioProcID {
            _ = AudioDeviceStop(aggregateDeviceID, ioProcID)
            _ = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }

        writerSignal.signal()
        waitForWriterDrain(timeout: 1.0)
        destroyAggregateAndTap()
    }

    private func destroyAggregateAndTap() {
        if aggregateDeviceID != kAudioObjectUnknown {
            let status = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            if status != noErr {
                sendJSON([
                    "type": "warning",
                    "code": "coreaudio_aggregate_destroy_failed",
                    "message": "AudioHardwareDestroyAggregateDevice failed with OSStatus \(osStatusDescription(status))",
                ])
            }
            aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        }

        if tapID != kAudioObjectUnknown {
            let status = AudioHardwareDestroyProcessTap(tapID)
            if status != noErr {
                sendJSON([
                    "type": "warning",
                    "code": "coreaudio_tap_destroy_failed",
                    "message": "AudioHardwareDestroyProcessTap failed with OSStatus \(osStatusDescription(status))",
                ])
            }
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}

// MARK: - Main Capture Class

@available(macOS 13.0, *)
class AudioCapture {
    private var stream: SCStream?
    private var delegate: AudioCaptureDelegate?
    private var coreAudioTapCapture: SystemAudioCaptureBackend?
    private var activeBackend: String?
    private var config: Config
    private var isRunning = false
    private var silenceCheckTimer: DispatchSourceTimer?

    private func displayDimension(_ display: SCDisplay, _ key: String, fallback: Int) -> Int {
        let mirror = Mirror(reflecting: display)
        for child in mirror.children {
            guard child.label == key else { continue }
            if let value = child.value as? Int {
                return value
            }
            if let value = child.value as? UInt32 {
                return Int(value)
            }
            if let value = child.value as? Double {
                return Int(value)
            }
        }
        return fallback
    }

    init(config: Config) {
        self.config = config
    }

    private func startSilenceCheckTimer() {
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 5.0, repeating: 5.0)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if self.activeBackend == "coreaudio_tap" {
                self.coreAudioTapCapture?.checkForSilence()
            } else {
                self.delegate?.checkForSilence()
            }
        }
        timer.resume()
        silenceCheckTimer = timer
    }

    private func stopSilenceCheckTimer() {
        silenceCheckTimer?.cancel()
        silenceCheckTimer = nil
    }

    func start() async throws {
        if config.preferCoreAudioTap {
            if #available(macOS 14.2, *) {
                let tapCapture = CoreAudioTapCapture(config: config)
                do {
                    try tapCapture.start()
                    coreAudioTapCapture = tapCapture
                    activeBackend = "coreaudio_tap"
                    isRunning = true
                    startSilenceCheckTimer()
                    sendJSON([
                        "type": "capture_backend",
                        "backend": "coreaudio_tap",
                        "message": "Using CoreAudio process tap for system audio capture"
                    ])
                    return
                } catch {
                    let nsError = error as NSError
                    sendJSON([
                        "type": "warning",
                        "code": "coreaudio_tap_start_failed",
                        "message": "CoreAudio process tap failed to start; falling back to ScreenCaptureKit",
                        "error": error.localizedDescription,
                        "nsErrorCode": nsError.code,
                        "nsErrorDomain": nsError.domain,
                    ])
                }
            } else {
                sendJSON([
                    "type": "status",
                    "status": "coreaudio_tap_unavailable",
                    "message": "CoreAudio process tap requires macOS 14.2 or later; using ScreenCaptureKit"
                ])
            }
        }

        activeBackend = "screencapturekit"
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

        let displays = content.displays
        let applications = content.applications
        let windows = content.windows

        sendJSON([
            "type": "content_info",
            "captureBackend": "screencapturekit",
            "displayCount": displays.count,
            "applicationCount": applications.count,
            "windowCount": windows.count,
        ])

        guard let display = displays.first else {
            sendJSON([
                "type": "error",
                "code": "no_display",
                "error": "No display found for screen capture"
            ])
            throw NSError(domain: "AudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let displayWidth = displayDimension(display, "width", fallback: 1920)
        let displayHeight = displayDimension(display, "height", fallback: 1080)

        sendStatus(
            "configuring",
            message: "Setting up audio capture for display: \(display.displayID)",
            extra: [
                "displayID": display.displayID,
                "displayWidth": displayWidth,
                "displayHeight": displayHeight,
            ]
        )

        // Create content filter for full-display capture. The simpler
        // excludingWindows initializer matches Apple's display-capture path and
        // avoids app-filter edge cases that can starve desktop audio callbacks.
        let filter = SCContentFilter(display: display, excludingWindows: [])

        // Configure stream. Screen frames are discarded, but using the real
        // display dimensions avoids ScreenCaptureKit silently starving outputs
        // on some macOS versions when given a tiny 1x1/2x2 video configuration.
        let streamConfig = SCStreamConfiguration()
        streamConfig.width = displayWidth
        streamConfig.height = displayHeight
        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: 1)  // 1 FPS minimum
        streamConfig.capturesAudio = true
        streamConfig.sampleRate = config.sampleRate
        streamConfig.channelCount = config.channels

        // Exclude current app from capture to avoid feedback
        if config.excludeCurrentApp {
            streamConfig.excludesCurrentProcessAudio = true
        }

        sendJSON([
            "type": "stream_config",
            "captureBackend": "screencapturekit",
            "width": streamConfig.width,
            "height": streamConfig.height,
            "capturesAudio": streamConfig.capturesAudio,
            "sampleRate": streamConfig.sampleRate,
            "channelCount": streamConfig.channelCount,
            "excludesCurrentProcessAudio": streamConfig.excludesCurrentProcessAudio,
        ])

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

        // Add a minimal screen output as well as audio. Some ScreenCaptureKit
        // paths start successfully but never deliver audio-only callbacks unless
        // a screen output is attached. The delegate immediately discards frames.
        do {
            try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: DispatchQueue(label: "screen.capture.discard.queue"))
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

        if activeBackend == "coreaudio_tap" || coreAudioTapCapture != nil {
            coreAudioTapCapture?.stop()
            coreAudioTapCapture = nil
            activeBackend = nil
            return
        }

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
        activeBackend = nil
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
        case "--screencapturekit":
            config.preferCoreAudioTap = false
        case "--coreaudio-tap":
            config.preferCoreAudioTap = true
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
      --coreaudio-tap            Prefer CoreAudio process tap on macOS 14.2+ (default)
      --screencapturekit         Force ScreenCaptureKit capture path
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
        "channels": config.channels,
        "preferCoreAudioTap": config.preferCoreAudioTap,
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
        if !emittedStartupError {
            sendJSON([
                "type": "error",
                "code": "capture_start_failed",
                "error": "Failed to start capture: \(error.localizedDescription)"
            ])
        }
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
