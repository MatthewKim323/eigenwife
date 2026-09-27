import ARKit
import AVFoundation
import Foundation
import CoreImage
import SwiftUI
import UIKit

/// Tracking state and AR callbacks use the main queue; one background image encode at most.
/// Encoding and networking share one in-flight slot, so camera frames never queue.
final class PhoneTracker: NSObject, ObservableObject, ARSessionDelegate, URLSessionWebSocketDelegate {
    @Published private(set) var running = false
    @Published private(set) var status = "ready to connect"
    @Published private(set) var faceStatus = "not started"
    @Published private(set) var depthStatus = "not sampled"
    @Published private(set) var sentFrames = 0
    @Published private(set) var droppedFrames = 0
    private let arSession = ARSession()
    private var network: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var timer: Timer?
    private var sessionID = UUID().uuidString
    private var sequence = 0
    private var busy = false
    private var lastFrameTime = 0.0
    private var lastSendTime = 0.0
    private var lastUIUpdate = 0.0
    private var pendingSince = 0.0
    private var generation = 0
    private var opened = false
    private var includeCameraImages = false
    private var imageEncoding = false
    private var lastImageTime = -Double.infinity
    private let imageQueue = DispatchQueue(label: "eye.camera-image", qos: .userInitiated)
    private let imageContext = CIContext(options: [.cacheIntermediates: false])

    override init() {
        super.init()
        arSession.delegate = self
        arSession.delegateQueue = .main
    }

    func start(endpoint: String, token: String, includeCameraImages: Bool = false) {
        guard !running else { return }
        guard ARFaceTrackingConfiguration.isSupported,
              AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front) != nil else {
            status = "a front TrueDepth camera is required"; return
        }
        guard let url = URL(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.path == "/iphone", url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else {
            status = "enter the Mac receiver URL ending in /iphone"; return
        }
        let pairing = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pairing.isEmpty, !pairing.contains("\r"), !pairing.contains("\n") else {
            status = "enter the pairing token shown on the Mac"; return
        }
        self.includeCameraImages = includeCameraImages
        generation += 1
        let attempt = generation
        running = true
        status = "requesting camera access"
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.running, self.generation == attempt else { return }
                guard granted else { self.stop(message: "camera access denied — enable it in Settings"); return }
                self.connect(url: url, token: pairing)
            }
        }
    }

    private func connect(url: URL, token: String) {
        sessionID = UUID().uuidString
        sequence = 0; sentFrames = 0; droppedFrames = 0
        busy = false; opened = false
        lastSendTime = 0; lastUIUpdate = 0; lastImageTime = -Double.infinity
        lastFrameTime = ProcessInfo.processInfo.systemUptime
        pendingSince = lastFrameTime
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        network = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        socket = network?.webSocketTask(with: request)
        socket?.resume()
        status = "connecting to Mac"
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
        receive()
    }

    func stop(message: String = "stopped") {
        generation += 1
        running = false; opened = false; busy = false
        arSession.pause()
        timer?.invalidate(); timer = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        network?.invalidateAndCancel(); network = nil
        UIApplication.shared.isIdleTimerDisabled = false
        status = message; faceStatus = "not tracking"; depthStatus = "not sampled"
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        guard webSocketTask === socket, running else { return }
        opened = true
        lastFrameTime = ProcessInfo.processInfo.systemUptime
        let configuration = ARFaceTrackingConfiguration()
        configuration.maximumNumberOfTrackedFaces = 1
        configuration.isLightEstimationEnabled = false
        arSession.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        UIApplication.shared.isIdleTimerDisabled = true
        status = "connected — look at the laptop"
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === socket else { return }
        stop(message: "Mac disconnected (\(closeCode.rawValue)) — reconnect")
    }

    private func receive() {
        guard let task = socket else { return }
        task.receive { [weak self, weak task] result in
            DispatchQueue.main.async {
                guard let self, let task, task === self.socket, self.running else { return }
                switch result {
                case .success: self.receive()
                case .failure(let error): self.stop(message: "connection failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func checkHealth() {
        guard running else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if !opened {
            if now - pendingSince > 10 { stop(message: "connection timed out — check Mac address, token and local network permission") }
        } else if busy && now - pendingSince > 2 {
            stop(message: "connection stalled — reconnect")
        } else if now - lastFrameTime > 0.5 {
            faceStatus = "camera stalled"
            var packet = PhoneFrame(sessionId: sessionID, seq: sequence, timestamp: now, tracked: false)
            packet.reason = "camera_stalled"
            send(packet)
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running, opened else { return }
        let now = ProcessInfo.processInfo.systemUptime
        lastFrameTime = now
        guard now - lastSendTime >= 1.0 / 30.0 else { return }
        guard !busy else { droppedFrames += 1; return }
        lastSendTime = now
        let anchor = frame.anchors.compactMap { $0 as? ARFaceAnchor }.first
        let leftBlink = anchor?.blendShapes[.eyeBlinkLeft]?.floatValue
        let rightBlink = anchor?.blendShapes[.eyeBlinkRight]?.floatValue
        // The receiver requires both blink observations for every usable eye sample.
        // Do not silently invent zero closure when ARKit omits a coefficient.
        let faceTracked = anchor?.isTracked == true
        let tracked = faceTracked && leftBlink != nil && rightBlink != nil
        var packet = PhoneFrame(sessionId: sessionID, seq: sequence, timestamp: frame.timestamp, tracked: tracked)
        packet.cameraTransform = flatten(frame.camera.transform)
        packet.intrinsics = flatten(frame.camera.intrinsics)
        packet.imageSize = [Int(frame.camera.imageResolution.width), Int(frame.camera.imageResolution.height)]
        if let anchor, tracked {
            packet.faceTransform = flatten(anchor.transform)
            packet.leftEyeTransform = flatten(anchor.leftEyeTransform)
            packet.rightEyeTransform = flatten(anchor.rightEyeTransform)
            packet.lookAtPoint = [anchor.lookAtPoint.x, anchor.lookAtPoint.y, anchor.lookAtPoint.z]
            packet.blinkLeft = leftBlink
            packet.blinkRight = rightBlink
        } else { packet.reason = faceTracked ? "eye_data_unavailable" : "face_not_tracked" }
        if let depth = frame.capturedDepthData {
            packet.depthAvailable = true
            packet.depthTimestamp = frame.capturedDepthDataTimestamp
            packet.depthCentralM = centralDepth(depth)
        }
        if now - lastUIUpdate > 0.2 {
            lastUIUpdate = now
            faceStatus = tracked ? "tracked" : (faceTracked ? "eye data unavailable" : "face not found")
            depthStatus = packet.depthAvailable ? "depth frame received" : "no depth in this frame"
        }
        if includeCameraImages && !imageEncoding && now - lastImageTime >= 0.2
            && packet.imageSize == [CVPixelBufferGetWidth(frame.capturedImage), CVPixelBufferGetHeight(frame.capturedImage)] {
            lastImageTime = now
            imageEncoding = true
            busy = true; pendingSince = now
            let attempt = generation
            let pixelBuffer = frame.capturedImage
            let context = imageContext
            let sourceIntrinsics = packet.intrinsics ?? []
            let numericPacket = packet
            // Retain only this buffer. New AR callbacks drop while it is being encoded.
            imageQueue.async { [weak self] in
                let image = autoreleasepool {
                    encodeCameraImage(pixelBuffer, intrinsics: sourceIntrinsics, context: context)
                }
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.imageEncoding = false
                    guard self.running, self.generation == attempt else { return }
                    self.busy = false
                    var synchronizedPacket = numericPacket
                    synchronizedPacket.image = image
                    self.send(synchronizedPacket)
                }
            }
        } else { send(packet) }
    }

    func sessionWasInterrupted(_ session: ARSession) { stop(message: "camera interrupted — reconnect") }
    func session(_ session: ARSession, didFailWithError error: Error) {
        stop(message: "tracking failed: \(error.localizedDescription)")
    }

    private func send(_ packet: PhoneFrame) {
        guard let task = socket, opened, !busy else { return }
        do {
            let data = try JSONEncoder().encode(packet) // Rejects nonfinite values instead of uploading them.
            guard let text = String(data: data, encoding: .utf8) else { return }
            busy = true; pendingSince = ProcessInfo.processInfo.systemUptime
            sequence += 1
            task.send(.string(text)) { [weak self, weak task] error in
                DispatchQueue.main.async {
                    guard let self, let task, task === self.socket else { return }
                    self.busy = false
                    if let error { self.stop(message: "send failed: \(error.localizedDescription)") }
                    else { self.sentFrames += 1 }
                }
            }
        } catch { stop(message: "invalid tracking data — reconnect") }
    }
}

private func flatten(_ matrix: simd_float4x4) -> [Float] {
    (0..<4).flatMap { column in (0..<4).map { row in matrix[column][row] } }
}
private func flatten(_ matrix: simd_float3x3) -> [Float] {
    (0..<3).flatMap { column in (0..<3).map { row in matrix[column][row] } }
}

/// Median of valid center-patch pixels, a diagnostic distance, not face-segmented depth.
private func centralDepth(_ depth: AVDepthData) -> Float? {
    let map = depth.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32).depthDataMap
    CVPixelBufferLockBaseAddress(map, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
    let width = CVPixelBufferGetWidth(map), height = CVPixelBufferGetHeight(map)
    let stride = CVPixelBufferGetBytesPerRow(map) / MemoryLayout<Float>.stride
    guard width >= 5, height >= 5 else { return nil }
    let pixels = base.assumingMemoryBound(to: Float.self)
    var values: [Float] = []
    for y in (height / 2 - 2)...(height / 2 + 2) {
        for x in (width / 2 - 2)...(width / 2 + 2) {
            let value = pixels[y * stride + x]
            if value.isFinite && value > 0.1 && value < 3 { values.append(value) }
        }
    }
    guard values.count >= 5 else { return nil }
    values.sort()
    return values[values.count / 2]
}

/// CIImage(CVPixelBuffer:) preserves the ARFrame sensor raster: no orientation or mirroring.
private func encodeCameraImage(_ pixelBuffer: CVPixelBuffer, intrinsics: [Float], context: CIContext) -> PhoneCameraImage? {
    let sourceWidth = CVPixelBufferGetWidth(pixelBuffer), sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
    guard let size = PhoneCameraImage.dimensions(width: sourceWidth, height: sourceHeight),
          let scaled = PhoneCameraImage.scaledIntrinsics(intrinsics, sourceWidth: sourceWidth,
              sourceHeight: sourceHeight, width: size.width, height: size.height),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let sx = CGFloat(size.width) / CGFloat(sourceWidth)
    let sy = CGFloat(size.height) / CGFloat(sourceHeight)
    let transform = CGAffineTransform(scaleX: sx, y: sy)
    let bounds = CGRect(x: 0, y: 0, width: CGFloat(size.width), height: CGFloat(size.height))
    let image = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: transform).cropped(to: bounds)
    for quality in [0.75, 0.55, 0.35, 0.2] {
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]) else { return nil }
        if jpeg.count <= 300 * 1024 {
            return PhoneCameraImage(data: jpeg.base64EncodedString(), width: size.width,
                                    height: size.height, intrinsics: scaled)
        }
    }
    return nil // Image is optional: retain numeric observations if encoding exceeds the budget.
}
