import AppKit

let width = 720, height = 1100
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.translateBy(x: 0, y: CGFloat(height))
context.cgContext.scaleBy(x: 1, y: -1)
func rect(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ color: NSColor) {
    color.setFill(); NSBezierPath(rect: NSRect(x: x, y: y, width: w, height: h)).fill()
}
func text(_ string: String, _ x: Int, _ y: Int, _ size: CGFloat, _ color: NSColor = .black) {
    context.cgContext.saveGState()
    context.cgContext.translateBy(x: CGFloat(x), y: CGFloat(y))
    context.cgContext.scaleBy(x: 1, y: -1)
    (string as NSString).draw(at: NSPoint(x: 0, y: -size * 1.25), withAttributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color])
    context.cgContext.restoreGState()
}
rect(0, 0, width, height, NSColor(white: 0.94, alpha: 1))
text("聊天记录回归样本", 250, 18, 20)
text("2026年11月3日 18:25", 260, 76, 14, .darkGray)
for i in 0..<6 {
    let y = 120 + i * 150, left = i % 2 == 0
    let x = left ? 24 : 652
    rect(x, y, 44, 44, left ? NSColor(calibratedRed: 0.1, green: 0.4, blue: 0.35, alpha: 1) : NSColor(calibratedRed: 0.3, green: 0.35, blue: 0.6, alpha: 1))
    text(left ? "甲" : "乙", x + 10, y + 10, 20, .white)
    let bx = left ? 84 : 340
    text(left ? "三笙" : "小林", left ? bx : 608, y + 1, 12, .darkGray)
    rect(bx, y + 25, 296, 68, left ? .white : NSColor(calibratedRed: 0.73, green: 0.9, blue: 0.8, alpha: 1))
    text("第\(i + 1)条：明天整理完整清单。", bx + 12, y + 35, 18)
    text("数量 \(258 + i * 11)，请确认。", bx + 12, y + 62, 18)
}
text("18:28", 330, 1040, 14, .darkGray)
NSGraphicsContext.restoreGraphicsState()
FileHandle.standardOutput.write(bitmap.representation(using: .png, properties: [:])!)
