import Foundation

/// Schema 1: meters, radians through transforms; matrices are column-major.
/// Eye transforms and lookAtPoint are face-local; face and camera are world poses.
struct PhoneFrame: Encodable {
    let type = "iphone_frame"
    let schema = 1
    var sessionId: String
    var seq: Int
    var timestamp: Double
    var tracked: Bool
    var cameraTransform: [Float]?
    var faceTransform: [Float]?
    var leftEyeTransform: [Float]?
    var rightEyeTransform: [Float]?
    var lookAtPoint: [Float]?
    var intrinsics: [Float]?
    var imageSize: [Int]?
    var blinkLeft: Float?
    var blinkRight: Float?
    var depthAvailable = false
    var depthTimestamp: Double?
    var depthCentralM: Float?
    var reason: String?
    var image: PhoneCameraImage?
}

/// Optional research image from the exact ARFrame carrying these numeric observations.
/// Sensor coordinates, without display rotation or mirroring; intrinsics use image pixels.
struct PhoneCameraImage: Encodable {
    let encoding = "jpeg"
    var data: String
    var width: Int
    var height: Int
    var intrinsics: [Float]
    let mirrored = false
    let orientation = "sensor"

    static func dimensions(width: Int, height: Int) -> (width: Int, height: Int)? {
        guard width > 0, height > 0 else { return nil }
        let scale = min(1.0, 1280.0 / Double(max(width, height)))
        return (max(1, Int(Double(width) * scale)), max(1, Int(Double(height) * scale)))
    }

    static func scaledIntrinsics(_ source: [Float], sourceWidth: Int, sourceHeight: Int,
                                 width: Int, height: Int) -> [Float]? {
        guard source.count == 9, source.allSatisfy({ $0.isFinite }),
              sourceWidth > 0, sourceHeight > 0, width > 0, height > 0 else { return nil }
        let sx = Float(width) / Float(sourceWidth), sy = Float(height) / Float(sourceHeight)
        // K' = diag(sx, sy, 1) * K, flattened in column-major order.
        return source.enumerated().map { index, value in
            value * (index % 3 == 0 ? sx : index % 3 == 1 ? sy : 1)
        }
    }
}
