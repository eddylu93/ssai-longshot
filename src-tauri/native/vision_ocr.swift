import Foundation
import ImageIO
import Vision

struct TextBox: Encodable {
    let text: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

enum OCRFailure: Error { case invalidImage, limits, languages }

let tileHeight = 1600
let tileOverlap = 96

func normalizedText(_ text: String) -> String {
    text.components(separatedBy: .whitespacesAndNewlines).joined().lowercased()
}

func duplicate(_ a: TextBox, _ b: TextBox, seamY: Int) -> Bool {
    let intersectionWidth = max(0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x))
    let intersectionHeight = max(0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))
    let intersection = Double(intersectionWidth * intersectionHeight)
    let smallerArea = Double(min(a.width * a.height, b.width * b.height))
    guard intersection >= smallerArea * 0.75 else { return false }
    let first = normalizedText(a.text)
    let second = normalizedText(b.text)
    let compatible = !first.isEmpty && !second.isEmpty && (first.contains(second) || second.contains(first))
    // Cropped glyphs can produce different OCR text. Require near-containment and
    // contact with an internal crop edge before deduplicating such fragments.
    let clipped = b.y <= seamY + 1 || a.y + a.height >= seamY + tileOverlap - 1
    let sameClippedLine = clipped && intersection >= smallerArea * 0.9
        && Double(intersectionWidth) >= Double(min(a.width, b.width)) * 0.9
    return compatible || sameClippedLine
}

func merged(_ a: TextBox, _ b: TextBox, seamY: Int) -> TextBox {
    let x = min(a.x, b.x)
    let y = min(a.y, b.y)
    let aClipped = a.y + a.height >= seamY + tileOverlap - 1
    let bClipped = b.y <= seamY + 1
    let text: String
    if aClipped != bClipped {
        text = aClipped ? b.text : a.text
    } else {
        text = normalizedText(a.text).count >= normalizedText(b.text).count ? a.text : b.text
    }
    return TextBox(text: text,
        x: x, y: y, width: max(a.x + a.width, b.x + b.width) - x,
        height: max(a.y + a.height, b.y + b.height) - y)
}

func recognizeTile(_ image: CGImage, offsetY: Int, languages: [String]) throws -> [TextBox] {
    let width = image.width
    let height = image.height
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.001
    request.recognitionLanguages = languages
    try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
    let observations = request.results ?? []
    guard observations.count <= 10000 else { throw OCRFailure.limits }
    return try observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty else { return nil }
        guard candidate.string.utf8.count <= 16384 else { throw OCRFailure.limits }
        let box = observation.boundingBox
        // Convert using this tile's actual height, then restore original-image Y.
        let x = max(0, min(width, Int(floor(box.minX * Double(width)))))
        let y = max(0, min(height, Int(floor((1 - box.maxY) * Double(height)))))
        let right = max(x, min(width, Int(ceil(box.maxX * Double(width)))))
        let bottom = max(y, min(height, Int(ceil((1 - box.minY) * Double(height)))))
        guard right > x, bottom > y else { return nil }
        return TextBox(text: candidate.string, x: x, y: offsetY + y, width: right - x, height: bottom - y)
    }
}

func recognize() throws -> [TextBox] {
    let limit = 16 * 1024 * 1024
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
        guard data.count + chunk.count <= limit else { throw OCRFailure.limits }
        data.append(chunk)
    }
    guard data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          CGImageSourceGetCount(source) == 1,
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = props[kCGImagePropertyPixelWidth] as? Int,
          let height = props[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 32768, height <= 32768,
          width * height <= 40_000_000,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw OCRFailure.invalidImage }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let supported = try request.supportedRecognitionLanguages()
    // Fail closed rather than silently missing Chinese chat text on an old OS.
    guard supported.contains("zh-Hans"), supported.contains("en-US") else {
        throw OCRFailure.languages
    }
    let languages = ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
    var boxes: [TextBox] = []
    var previousOverlap: [Int] = []
    var offsetY = 0
    var observationCount = 0
    while offsetY < height {
        let cropHeight = min(tileHeight, height - offsetY)
        let incoming = try autoreleasepool { () throws -> [TextBox] in
            guard let tile = image.cropping(to: CGRect(x: 0, y: offsetY, width: width, height: cropHeight))
            else { throw OCRFailure.invalidImage }
            return try recognizeTile(tile, offsetY: offsetY, languages: languages)
        }
        observationCount += incoming.count
        guard observationCount <= 10000 else { throw OCRFailure.limits }
        for box in incoming {
            if let index = previousOverlap.first(where: { duplicate(boxes[$0], box, seamY: offsetY) }) {
                boxes[index] = merged(boxes[index], box, seamY: offsetY)
            } else {
                boxes.append(box)
            }
        }
        if offsetY + cropHeight == height { break }
        offsetY += tileHeight - tileOverlap
        previousOverlap = boxes.indices.filter { boxes[$0].y + boxes[$0].height > offsetY }
    }
    return boxes.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
}

do {
    let result = try autoreleasepool { try recognize() }
    let json = try JSONEncoder().encode(result)
    guard json.count <= 4 * 1024 * 1024 else { throw OCRFailure.limits }
    FileHandle.standardOutput.write(json)
} catch {
    // Never emit input, recognized text, framework errors or paths to logs.
    FileHandle.standardError.write(Data("Vision OCR failed\n".utf8))
    exit(1)
}
