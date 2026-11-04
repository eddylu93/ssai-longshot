// Synthetic chat fixture only; never bundled or used by the application.
import AppKit

let dark = CommandLine.arguments.contains("dark")
let scale: CGFloat = CommandLine.arguments.contains("scale2") ? 2 : 1
let width = 900, height = 1800
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(CGFloat(width) * scale), pixelsHigh: Int(CGFloat(height) * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current!.cgContext.scaleBy(x: scale, y: scale)
let background = dark ? NSColor(calibratedWhite: 0.11, alpha: 1) : NSColor(calibratedWhite: 0.95, alpha: 1)
let bodyColor = dark ? NSColor.white : NSColor.black
let labelColor = dark ? NSColor(calibratedWhite: 0.65, alpha: 1) : NSColor(calibratedWhite: 0.43, alpha: 1)
let bubbleColor = dark ? NSColor(calibratedWhite: 0.22, alpha: 1) : NSColor.white
func rect(_ x: CGFloat, _ top: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: NSColor) {
    color.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: CGFloat(height) - top - h, width: w, height: h), xRadius: 6, yRadius: 6).fill()
}
func text(_ value: String, _ x: CGFloat, _ top: CGFloat, _ size: CGFloat = 18, _ color: NSColor? = nil) {
    (value as NSString).draw(at: NSPoint(x: x, y: CGFloat(height) - top - size - 4),
        withAttributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color ?? bodyColor])
}
func avatar(_ top: CGFloat, _ letter: String, _ right: Bool = false) {
    let x: CGFloat = right ? 824 : 24
    rect(x, top, 52, 52, NSColor(calibratedRed: right ? 0.25 : 0.18, green: 0.5, blue: 0.46, alpha: 1))
    text(letter, x + 15, top + 12, 22, .white)
}
func photo(_ top: CGFloat) {
    rect(96, top, 420, 180, NSColor(calibratedRed: 0.42, green: 0.68, blue: 0.8, alpha: 1))
    rect(120, top + 80, 190, 70, NSColor(calibratedRed: 0.3, green: 0.5, blue: 0.38, alpha: 1))
    rect(330, top + 45, 160, 105, NSColor(calibratedRed: 0.65, green: 0.47, blue: 0.3, alpha: 1))
}
background.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
text("协作测试群 (8)", 24, 22, 24)
text("今天 10:28", 390, 90, 18, labelColor)
avatar(140, "周")
text("测试成员 小周", 96, 140, 18, labelColor)
rect(96, 174, 390, 90, bubbleColor)
text("这是一条与昵称同字号的正文。", 112, 192)
text("普通消息不应该被遮住。", 112, 224)
avatar(340, "林")
text("设计组 小林", 96, 340, 18, labelColor)
photo(374)
avatar(620, "陈")
text("仓库 小陈 📦", 96, 620, 18, labelColor)
rect(96, 654, 120, 110, NSColor(calibratedRed: 0.85, green: 0.65, blue: 0.25, alpha: 1))
text("🙂", 120, 675, 56)
avatar(850, "我", true)
text("测试成员 自己", 694, 850, 18, labelColor)
rect(470, 884, 340, 90, dark ? NSColor(calibratedRed: 0.16, green: 0.37, blue: 0.27, alpha: 1) : NSColor(calibratedRed: 0.68, green: 0.9, blue: 0.64, alpha: 1))
text("右侧消息正文应当保持可读。", 486, 905)
avatar(1080, "物")
text("物流组昵称比较长的测试成员用于验证昵称不会只遮住一半", 96, 1080, 18, labelColor)
rect(96, 1114, 650, 90, bubbleColor)
text("正文中提到小周，不应被误判为群昵称。", 112, 1134)
avatar(1330, "周")
text("测试成员 小周", 96, 1330, 18, labelColor)
photo(1364)
avatar(1620, "普")
rect(96, 1620, 500, 100, bubbleColor)
text("没有昵称的两行普通消息。", 112, 1638)
text("不能把第一行正文当成用户名。", 112, 1670)
NSGraphicsContext.restoreGraphicsState()
FileHandle.standardOutput.write(bitmap.representation(using: .png, properties: [:])!)
