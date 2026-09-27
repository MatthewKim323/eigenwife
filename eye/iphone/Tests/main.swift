import Foundation

func require(_ assertion: @autoclosure () -> Bool, _ message: String) {
    guard assertion() else { fatalError(message) }
}
let encoder = JSONEncoder()
var packet = PhoneFrame(sessionId: "2965E913-74A8-4B86-B0CF-63E566E61A5B", seq: 0, timestamp: 12.5, tracked: false)
packet.reason = "camera_stalled"
let missing = try JSONSerialization.jsonObject(with: encoder.encode(packet)) as! [String: Any]
require(missing["type"] as? String == "iphone_frame", "wire type")
require(missing["schema"] as? Int == 1, "wire schema")
require(missing["tracked"] as? Bool == false, "loss is explicit")
require(missing["depthAvailable"] as? Bool == false, "no synthetic depth")
require(missing["faceTransform"] == nil && missing["intrinsics"] == nil, "missing samples omitted")
let identity: [Float] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
packet.seq = 1; packet.tracked = true; packet.reason = nil
packet.cameraTransform = identity; packet.faceTransform = identity
packet.leftEyeTransform = identity; packet.rightEyeTransform = identity
packet.lookAtPoint = [0, 0, 1]
packet.intrinsics = [500, 0, 0, 0, 500, 0, 320, 240, 1]
packet.imageSize = [640, 480]; packet.blinkLeft = 0.1; packet.blinkRight = 0.2
packet.depthAvailable = true; packet.depthTimestamp = 12.4; packet.depthCentralM = 0.6
let validData = try encoder.encode(packet)
let valid = try JSONSerialization.jsonObject(with: validData) as! [String: Any]
require((valid["leftEyeTransform"] as? [Double])?.count == 16, "matrix dimensions")
require((valid["intrinsics"] as? [Double])?.count == 9, "intrinsic dimensions")
require(valid["reason"] == nil, "valid frame is not marked lost")
require(valid["depthTimestamp"] as? Double == 12.4, "separate depth timestamp")
require(valid.keys.allSatisfy { !["image", "video", "capturedImage", "token"].contains($0) }, "numeric payload only")
let dimensions = PhoneCameraImage.dimensions(width: 1920, height: 1080)!
require(dimensions.width == 1280 && dimensions.height == 720, "image edge bounded")
let portrait = PhoneCameraImage.dimensions(width: 1080, height: 1920)!
require(portrait.width == 720 && portrait.height == 1280, "sensor orientation preserved")
require(PhoneCameraImage.dimensions(width: 0, height: 1080) == nil, "invalid dimensions rejected")
let small = PhoneCameraImage.dimensions(width: 640, height: 480)!
require(small.width == 640 && small.height == 480, "small input never upscaled")
let scaled = PhoneCameraImage.scaledIntrinsics([900, 3, 0, 6, 1000, 0, 960, 540, 1],
    sourceWidth: 1920, sourceHeight: 1080, width: 1280, height: 720)!
require(abs(scaled[0] - 600) < 0.001 && abs(scaled[4] - 666.6667) < 0.001, "focal lengths scaled")
require(scaled[1] == 2 && scaled[3] == 4 && scaled[6] == 640 && scaled[7] == 360 && scaled[8] == 1, "column-major rows scaled exactly")
require(PhoneCameraImage.scaledIntrinsics([.nan], sourceWidth: 1, sourceHeight: 1, width: 1, height: 1) == nil, "invalid intrinsics rejected")
let jpegFixture = Data([0xff, 0xd8, 0xff, 0xd9]) // Contract fixture, not a decodable image.
packet.imageSize = [1920, 1080]
packet.intrinsics = [900, 3, 0, 6, 1000, 0, 960, 540, 1]
packet.image = PhoneCameraImage(data: jpegFixture.base64EncodedString(), width: 1280, height: 720, intrinsics: scaled)
let imageData = try encoder.encode(packet)
let withImage = try JSONSerialization.jsonObject(with: imageData) as! [String: Any]
let image = withImage["image"] as! [String: Any]
require(image["encoding"] as? String == "jpeg" && image["orientation"] as? String == "sensor", "image metadata explicit")
require(image["mirrored"] as? Bool == false, "no mirror implied by front camera")
require(Data(base64Encoded: image["data"] as! String) == jpegFixture, "base64 bytes preserved")
require(withImage["timestamp"] as? Double == 12.5 && withImage["seq"] as? Int == 1, "image shares numeric frame timestamp")
require(withImage["imageSize"] as? [Int] == [1920, 1080], "source image dimensions kept separately")
if CommandLine.arguments.count > 2 { try imageData.write(to: URL(fileURLWithPath: CommandLine.arguments[2])) }
packet.lookAtPoint = [.nan, 0, 1]
var rejected = false
do { _ = try encoder.encode(packet) } catch { rejected = true }
require(rejected, "nonfinite tracking must not serialize")
if CommandLine.arguments.count > 1 {
    try validData.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
}
print("PhoneFrame protocol checks passed")
