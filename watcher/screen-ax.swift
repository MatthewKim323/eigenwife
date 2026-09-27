// Eve's screen sense (docs/SCREEN.md). A tiny, read-only macOS helper the core
// compiles once (swiftc -O) into ~/.eve/bin and runs every few seconds.
//
//   screen-ax perms                       {"accessibility":bool,"screenRecording":bool}
//   screen-ax dump [--pid N] [--max C]    the focused window's accessibility text as JSON
//   screen-ax at --x X --y Y              the thing under one screen point (desktop gaze)
//
// dump reads ONE window: the focused window of the frontmost app (or of --pid).
// It never walks other windows or apps. Secure text fields (AXSecureTextField)
// are skipped entirely: their value is never read, not even to discard it.
// It also reports the window's CGWindowID so the core can capture exactly that
// window (screencapture -l) for a one-off vision look. No network, no disk.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func out(_ obj: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: []), let s = String(data: data, encoding: .utf8) {
    print(s)
  } else {
    print("{\"ok\":false,\"error\":\"json\"}")
  }
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
  return err == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
  guard let v = attr(el, name) else { return nil }
  if let s = v as? String { return s }
  if let u = v as? URL { return u.absoluteString }
  if CFGetTypeID(v) == CFURLGetTypeID() { return (v as! CFURL as URL).absoluteString }
  return nil
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  guard CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}

func isSecure(_ role: String?, _ subrole: String?) -> Bool {
  return role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

var args = CommandLine.arguments.dropFirst()
let cmd = args.first ?? "dump"
args = args.dropFirst()
var opts: [String: String] = [:]
var key: String?
for a in args {
  if a.hasPrefix("--") { key = String(a.dropFirst(2)); opts[key!] = "1" } else if let k = key { opts[k] = a; key = nil }
}

if cmd == "perms" {
  out(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])
  exit(0)
}

// at --x X --y Y [--min-w W --min-h H] [--deny-hosts a,b]
// What's under one screen point (global top-left points, same space as eye serve).
// Walks up from the hit element to the first "thing a person looks at": a link,
// button, image, cell, row, heading, or any element at least min-w x min-h (the
// gaze error radius), so a 150pt-accurate gaze never resolves to one glyph.
// Secure fields and denylisted hosts return private:true with no text at all.
if cmd == "at" {
  guard AXIsProcessTrusted() else {
    out(["ok": false, "error": "accessibility"])
    exit(0)
  }
  guard let xs = opts["x"], let ys = opts["y"], let x = Double(xs), let y = Double(ys), x.isFinite, y.isFinite else {
    out(["ok": false, "error": "need --x and --y"])
    exit(2)
  }
  let minW = CGFloat(Double(opts["min-w"] ?? "") ?? 160)
  let minH = CGFloat(Double(opts["min-h"] ?? "") ?? 48)
  let hosts = (opts["deny-hosts"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
  func hostDenied(_ u: String) -> Bool {
    guard !hosts.isEmpty, let h = URL(string: u)?.host?.lowercased() else { return false }
    return hosts.contains { h == $0 || h.hasSuffix("." + $0) }
  }
  let sys = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(sys, 0.3)
  var hitRef: AXUIElement?
  guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &hitRef) == .success, let hit = hitRef else {
    out(["ok": true, "none": true])
    exit(0)
  }
  var hitPid: pid_t = 0
  AXUIElementGetPid(hit, &hitPid)
  let ra = NSRunningApplication(processIdentifier: hitPid)
  let base: [String: Any] = ["ok": true, "app": ra?.localizedName ?? "", "bundleId": ra?.bundleIdentifier ?? "", "pid": hitPid]
  func merged(_ extra: [String: Any]) -> [String: Any] { base.merging(extra) { _, b in b } }

  // Ancestors, hit first. Secure anywhere on the path = private.
  var path: [AXUIElement] = []
  var cur: AXUIElement? = hit
  while let c = cur, path.count < 30 {
    path.append(c)
    if isSecure(str(c, kAXRoleAttribute), str(c, kAXSubroleAttribute)) {
      out(merged(["private": true, "secure": true]))
      exit(0)
    }
    if let p = attr(c, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() { cur = (p as! AXUIElement) } else { cur = nil }
  }
  var pageUrl = ""
  var windowTitle = ""
  for el in path {
    let role = str(el, kAXRoleAttribute)
    if role == "AXWebArea" && pageUrl.isEmpty { pageUrl = str(el, kAXURLAttribute) ?? "" }
    if role == "AXWindow" && windowTitle.isEmpty { windowTitle = str(el, kAXTitleAttribute) ?? "" }
  }
  if hostDenied(pageUrl) {
    out(merged(["private": true]))
    exit(0)
  }

  let AT_TEXT: Set<String> = ["AXStaticText", "AXHeading", "AXLink", "AXImage", "AXCell", "AXTextArea", "AXTextField"]
  let SEMANTIC: Set<String> = ["AXLink", "AXButton", "AXImage", "AXCell", "AXRow", "AXHeading", "AXMenuItem", "AXTab", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXTextArea"]
  let STOP: Set<String> = ["AXWebArea", "AXWindow", "AXApplication", "AXScrollArea", "AXSplitGroup"]
  var pick = hit
  for el in path {
    let role = str(el, kAXRoleAttribute) ?? ""
    if STOP.contains(role) { break }
    pick = el
    if SEMANTIC.contains(role) { break }
    if let f = frame(el), f.width >= minW && f.height >= minH { break }
  }

  // Label: the element's own name, else the first few visible text descendants.
  func own(_ el: AXUIElement) -> String {
    for a in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
      if let s = str(el, a)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
    }
    return ""
  }
  var parts: [String] = []
  let ownLabel = own(pick)
  if !ownLabel.isEmpty { parts.append(ownLabel) }
  var q: [(AXUIElement, Int)] = [(pick, 0)]
  var seen = 0
  while !q.isEmpty && parts.joined(separator: " ").count < 240 && seen < 120 {
    let (el, d) = q.removeFirst()
    seen += 1
    let role = str(el, kAXRoleAttribute)
    if isSecure(role, str(el, kAXSubroleAttribute)) {
      out(merged(["private": true, "secure": true]))
      exit(0)
    }
    if d > 0, let r = role, AT_TEXT.contains(r) {
      let t = own(el)
      if !t.isEmpty && !parts.contains(t) { parts.append(t) }
    }
    if d < 6, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
      for k in kids.prefix(24) { q.append((k, d + 1)) }
    }
  }
  var label = parts.joined(separator: " · ")
  // Big text (terminals, editors, chat logs): the whole value is not what you're
  // looking at. Ask for the characters under the point and keep that line.
  var lineUnder = ""
  let pickRole = str(pick, kAXRoleAttribute) ?? ""
  if pickRole == "AXTextArea" || pickRole == "AXTextField" || pickRole == "AXStaticText" {
    var pt = CGPoint(x: x, y: y)
    var idxRange: AnyObject?
    if let ptVal = AXValueCreate(.cgPoint, &pt),
       AXUIElementCopyParameterizedAttributeValue(pick, kAXRangeForPositionParameterizedAttribute as CFString, ptVal, &idxRange) == .success,
       let rv = idxRange, CFGetTypeID(rv) == AXValueGetTypeID() {
      var hitR = CFRange(location: 0, length: 0)
      AXValueGetValue(rv as! AXValue, .cfRange, &hitR)
      var win = CFRange(location: max(0, hitR.location - 160), length: 320)
      var sv: AnyObject?
      if let wv = AXValueCreate(.cfRange, &win),
         AXUIElementCopyParameterizedAttributeValue(pick, kAXStringForRangeParameterizedAttribute as CFString, wv, &sv) == .success,
         let s = sv as? String {
        let off = min(s.count, max(0, hitR.location - win.location))
        let i = s.index(s.startIndex, offsetBy: off)
        let start = s[..<i].lastIndex(of: "\n").map { s.index(after: $0) } ?? s.startIndex
        let end = s[i...].firstIndex(of: "\n") ?? s.endIndex
        lineUnder = String(s[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
  }
  var coarse = false
  if !lineUnder.isEmpty {
    label = lineUnder
  } else if pickRole == "AXTextArea", let f = frame(pick), f.width * f.height > 60_000 {
    // A big text area that can't say what's under the point (e.g. a terminal): its value
    // starts wherever the scrollback does, which is not what you're looking at.
    label = ""
    coarse = true
  }
  if label.count > 240 { label = String(label.prefix(240)) }
  var result = merged([
    "role": str(pick, kAXRoleAttribute) ?? "", "subrole": str(pick, kAXSubroleAttribute) ?? "", "label": label,
    "url": pageUrl, "title": windowTitle, "coarse": coarse,
  ])
  if let f = frame(pick) { result["frame"] = ["x": f.origin.x, "y": f.origin.y, "w": f.width, "h": f.height] }
  if str(pick, kAXRoleAttribute) == "AXLink", let href = str(pick, kAXURLAttribute) { result["href"] = hostDenied(href) ? "" : href }
  out(result)
  exit(0)
}

guard cmd == "dump" else {
  out(["ok": false, "error": "unknown command \(cmd)"])
  exit(2)
}

guard AXIsProcessTrusted() else {
  out(["ok": false, "error": "accessibility"])
  exit(0)
}

let maxChars = Int(opts["max"] ?? "") ?? 8000
// Private sites: the walk stops the moment a web area on one of these hosts is
// found, and nothing read so far is returned.
let denyHosts = (opts["deny-hosts"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
func denied(_ u: String) -> Bool {
  guard !denyHosts.isEmpty, let h = URL(string: u)?.host?.lowercased() else { return false }
  return denyHosts.contains { h == $0 || h.hasSuffix("." + $0) }
}
let maxNodes = Int(opts["nodes"] ?? "") ?? 2500
var pid: pid_t = 0
var appName = ""
var bundleId = ""
if let p = opts["pid"], let n = Int32(p) {
  pid = n
  let ra = NSRunningApplication(processIdentifier: n)
  appName = ra?.localizedName ?? ""
  bundleId = ra?.bundleIdentifier ?? ""
} else if let front = NSWorkspace.shared.frontmostApplication {
  pid = front.processIdentifier
  appName = front.localizedName ?? ""
  bundleId = front.bundleIdentifier ?? ""
}
guard pid > 0 else {
  out(["ok": false, "error": "no frontmost app"])
  exit(0)
}

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.4)
guard let winObj = attr(app, kAXFocusedWindowAttribute) ?? attr(app, kAXMainWindowAttribute), CFGetTypeID(winObj) == AXUIElementGetTypeID() else {
  out(["ok": true, "app": appName, "bundleId": bundleId, "pid": pid, "texts": [], "noWindow": true])
  exit(0)
}
let win = winObj as! AXUIElement
let title = str(win, kAXTitleAttribute) ?? ""
let winFrame = frame(win)

// The CGWindowID of that window: the frontmost on-screen, normal-layer window
// of the pid, preferring one whose title and bounds match the AX window.
var windowId: Int = 0
func findWindow(_ opts: CGWindowListOption, strict: Bool) -> Int {
  guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return 0 }
  var best: Int = 0
  for w in list {
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
    let id = w[kCGWindowNumber as String] as? Int ?? 0
    let name = w[kCGWindowName as String] as? String ?? ""
    if !strict && best == 0 { best = id }
    if strict && !(name == title && !title.isEmpty) { continue }
    if let b = w[kCGWindowBounds as String] as? [String: CGFloat], let f = winFrame {
      let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
      if abs(r.origin.x - f.origin.x) < 2 && abs(r.origin.y - f.origin.y) < 2 && abs(r.width - f.width) < 2 && (name.isEmpty || name == title) {
        return id
      }
    }
  }
  return best
}
// On screen first; a window on another Space only when its title and bounds match exactly.
windowId = findWindow([.optionOnScreenOnly, .excludeDesktopElements], strict: false)
if windowId == 0 { windowId = findWindow([.optionAll, .excludeDesktopElements], strict: true) }

// Walk the window's tree (depth-first, capped). Text-bearing roles only.
let TEXT_ROLES: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXHeading", "AXLink", "AXCell", "AXComboBox", "AXSearchField"]
var texts: [[String: String]] = []
var chars = 0
var nodes = 0
var url = ""
var secureSeen = false
var stack: [(AXUIElement, Int)] = [(win, 0)]
while let (el, depth) = stack.popLast() {
  nodes += 1
  if nodes > maxNodes || chars > maxChars { break }
  let role = str(el, kAXRoleAttribute)
  let subrole = str(el, kAXSubroleAttribute)
  if isSecure(role, subrole) {
    secureSeen = true
    continue // never read a secure field, never descend into one
  }
  if role == "AXWebArea" && url.isEmpty {
    url = str(el, kAXURLAttribute) ?? ""
    if denied(url) {
      out(["ok": true, "app": appName, "bundleId": bundleId, "pid": pid, "private": true, "texts": []])
      exit(0)
    }
  }
  var visible = true
  if let wf = winFrame, let f = frame(el), f.width > 0, f.height > 0 { visible = wf.intersects(f) }
  if visible, let r = role, TEXT_ROLES.contains(r) {
    var t = str(el, kAXValueAttribute) ?? ""
    if t.isEmpty { t = str(el, kAXTitleAttribute) ?? "" }
    if t.isEmpty && r == "AXLink" { t = str(el, kAXDescriptionAttribute) ?? "" }
    t = t.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.isEmpty {
      let clip = String(t.prefix(maxChars))
      texts.append(["r": r, "t": clip])
      chars += clip.count
    }
  }
  if depth < 40, visible || role == "AXScrollArea" || role == "AXGroup", let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
    for k in kids.reversed() { stack.append((k, depth + 1)) }
  }
}

// Focused element: its selection and value, unless it's a secure field.
var selected = ""
var focusedValue = ""
var focusedRole = ""
var secureFocused = false
if let f = attr(app, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() {
  let fe = f as! AXUIElement
  let role = str(fe, kAXRoleAttribute)
  let subrole = str(fe, kAXSubroleAttribute)
  focusedRole = role ?? ""
  if isSecure(role, subrole) {
    secureSeen = true
    secureFocused = true
  } else {
    selected = String((str(fe, kAXSelectedTextAttribute) ?? "").prefix(1000))
    if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || role == "AXSearchField" {
      focusedValue = String((str(fe, kAXValueAttribute) ?? "").prefix(1000))
    }
  }
}
if url.isEmpty, let doc = str(win, kAXDocumentAttribute), doc.hasPrefix("http") { url = doc }
if denied(url) {
  out(["ok": true, "app": appName, "bundleId": bundleId, "pid": pid, "private": true, "texts": []])
  exit(0)
}

out([
  "ok": true, "app": appName, "bundleId": bundleId, "pid": pid, "windowId": windowId, "title": title, "url": url,
  "texts": texts, "selected": selected, "focusedValue": focusedValue, "focusedRole": focusedRole,
  "secureFocused": secureFocused, "secureSeen": secureSeen, "nodes": nodes,
])
