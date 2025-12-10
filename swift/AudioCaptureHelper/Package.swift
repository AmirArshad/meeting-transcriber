// swift-tools-version:5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "AudioCaptureHelper",
    platforms: [
        .macOS(.v13)  // ScreenCaptureKit audio capture requires macOS 13+
    ],
    products: [
        .executable(name: "audiocapture-helper", targets: ["AudioCaptureHelper"])
    ],
    targets: [
        .executableTarget(
            name: "AudioCaptureHelper",
            dependencies: [],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("AVFoundation")
            ]
        )
    ]
)
