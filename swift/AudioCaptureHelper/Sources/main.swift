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

    func startCapturing() {
        outputLock.lock()
        isCapturing = true
        outputLock.unlock()
    }

    func stopCapturing() {
        outputLock.lock()
        isCapturing = false
        outputLock.unlock()
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

        // Write raw float32 PCM data to stdout (interleaved stereo)
        // ScreenCaptureKit provides interleaved audio in mBuffers.mData
        // We need to write all channels, not just floatChannelData[0]
        let frameCount = Int(audioBuffer.frameLength)
        let channelCount = Int(audioBuffer.format.channelCount)
        let bytesPerFrame = channelCount * MemoryLayout<Float>.size
        let totalBytes = frameCount * bytesPerFrame

        // Get interleaved data directly from the audio buffer
        if audioBuffer.format.isInterleaved {
            // Interleaved format - data is already in the correct format
            if let channelData = audioBuffer.floatChannelData?[0] {
                let data = Data(bytes: channelData, count: totalBytes)
                FileHandle.standardOutput.write(data)
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
        }

        sampleCount += 1
        if sampleCount == 1 {
            sendStatus("first_sample", message: "Received first audio sample")
        }
    }

    private func extractAudioBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamBasicDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }

        let audioFormat = AVAudioFormat(streamDescription: streamBasicDescription.pointee)
        guard let audioFormat = audioFormat else { return nil }

        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return nil }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: AVAudioFrameCount(numSamples)) else {
            return nil
        }
        pcmBuffer.frameLength = AVAudioFrameCount(numSamples)

        // Get the audio buffer list
        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList()
        var audioBufferListSize = MemoryLayout<AudioBufferList>.size

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

        guard status == noErr else { return nil }

        // Copy audio data to PCM buffer
        let srcBuffer = audioBufferList.mBuffers
        if let srcData = srcBuffer.mData, let dstData = pcmBuffer.floatChannelData?[0] {
            memcpy(dstData, srcData, Int(srcBuffer.mDataByteSize))
        }

        return pcmBuffer
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

    init(config: Config) {
        self.config = config
    }

    func start() async throws {
        sendStatus("initializing", message: "Getting shareable content...")

        // Get available content to capture
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw NSError(domain: "AudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        sendStatus("configuring", message: "Setting up audio capture...")

        // Create content filter - capture entire display but only audio
        let filter = SCContentFilter(display: display, excludingWindows: [])

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
            throw NSError(domain: "AudioCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create stream"])
        }

        // Add stream output for audio
        try stream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio.capture.queue"))

        sendStatus("starting", message: "Starting audio capture...")

        // Start capture
        delegate.startCapturing()
        try await stream.startCapture()
        isRunning = true

        sendReady()
        sendStatus("recording", message: "Desktop audio capture active")
    }

    func stop() async {
        guard isRunning else { return }
        isRunning = false

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

    // Check macOS version
    if #available(macOS 13.0, *) {
        // OK
    } else {
        sendError("macOS 13.0 or later required for ScreenCaptureKit audio capture")
        exit(1)
    }

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

    // Keep running
    RunLoop.main.run()
}

// Run main
if #available(macOS 13.0, *) {
    // Start main async task - RunLoop.main.run() inside main() keeps it alive
    Task {
        await main()
    }
    // Keep the main thread alive to process events
    dispatchMain()
} else {
    sendError("macOS 13.0 or later required")
    exit(1)
}
