import SwiftUI

@main
struct EyePhoneApp: App {
    @StateObject private var tracker = PhoneTracker()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(tracker: tracker)
                .onChange(of: scenePhase) { phase in
                    if phase == .background { tracker.stop(message: "paused — tap connect when ready") }
                }
        }
    }
}

struct ContentView: View {
    @ObservedObject var tracker: PhoneTracker
    @AppStorage("receiverURL") private var endpoint = "ws://192.168.1.2:8766/iphone"
    @State private var token = ""
    @State private var includeCameraImages = false
    @State private var loadedLaunchPairing = false

    var body: some View {
        NavigationStack {
            Form {
                Section("connect to your Mac") {
                    TextField("receiver URL", text: $endpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).disabled(tracker.running)
                    SecureField("pairing token from Mac", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(tracker.running)
                    Toggle("include camera images for model research", isOn: $includeCameraImages)
                        .disabled(tracker.running)
                    Text("off by default. when enabled, camera images accompany tracking up to 5 times per second. the iPhone does not save images.").font(.footnote)
                    if tracker.running {
                        Button("stop", role: .destructive) { tracker.stop() }
                    } else {
                        Button("connect and start") { tracker.start(endpoint: endpoint, token: token, includeCameraImages: includeCameraImages) }
                            .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                Section("tracking") {
                    Text(tracker.status).accessibilityIdentifier("tracking-status")
                    LabeledContent("face", value: tracker.faceStatus)
                    LabeledContent("TrueDepth", value: tracker.depthStatus)
                    LabeledContent("frames sent", value: String(tracker.sentFrames))
                    LabeledContent("frames dropped", value: String(tracker.droppedFrames))
                }
                Section("position your phone") {
                    Text("mount the phone beside your laptop screen, front camera facing you. keep it fixed after screen calibration and look at the laptop, not this display.")
                    Text("this uses TrueDepth-backed ARKit estimates. numeric head, eye, camera and depth summaries go to your Mac. optional camera images are RGB, not raw infrared video. images are sent only when the research toggle is enabled.")
                    Text("use a trusted local network. the ws:// connection is unencrypted. leaving this app stops tracking; reconnect explicitly when you return.")
                        .font(.footnote)
                }
            }.navigationTitle("eye phone")
                .onAppear {
                    guard !loadedLaunchPairing else { return }
                    loadedLaunchPairing = true
                    // USB developer launch can prefill this receiver session.
                    // The token stays in memory; the user still starts tracking.
                    let environment = ProcessInfo.processInfo.environment
                    if let address = environment["EYE_RECEIVER_URL"],
                       let pairing = environment["EYE_PAIRING_TOKEN"] {
                        endpoint = address
                        token = pairing
                    }
                }
        }
    }
}
