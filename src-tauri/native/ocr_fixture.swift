// Test-only synthetic image. This script is never shipped or used at runtime.
import AppKit

let isLong = CommandLine.arguments.contains("long")
let height = isLong ? 12000 : 360
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1000, pixelsHigh: height,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 1000, height: height).fill()
if isLong {
    let style: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.black]
    func line(_ text: String, top: Int) {
        (text as NSString).draw(at: NSPoint(x: 40, y: height - top - 20), withAttributes: style)
    }
    line("TOP 13800138000", top: 40)
    line("聊天隐私测试", top: 80)
    line("LEADING 13700137000", top: 1498)
    line("REPEATED 13500135000", top: 1540)
    line("CROSSING 13600136000", top: 1592)
    line("REPEATED 13500135000", top: 7540)
    line("BOTTOM 13900139000", top: 11920)
    line("底部隐私测试", top: 11960)
} else if !CommandLine.arguments.contains("blank") {
    let style: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.black]
    ("Privacy Test 13800138000" as NSString).draw(at: NSPoint(x: 40, y: 240), withAttributes: style)
    ("聊天隐私测试" as NSString).draw(at: NSPoint(x: 40, y: 140), withAttributes: style)
}
NSGraphicsContext.restoreGraphicsState()
FileHandle.standardOutput.write(bitmap.representation(using: .png, properties: [:])!)
