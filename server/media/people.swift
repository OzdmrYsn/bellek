// Bir görseldeki kişileri macOS'un yerleşik Vision çerçevesiyle bulur.
// Anahtar ve ağ gerektirmez; server/media/people.ts tarafından derlenip çalıştırılır.
//
//   people <görsel yolu>   →   {"faces":[…], "poses":[…], "bodies":[…]}
//
// Kutular görsele göre 0–1 aralığındadır; başlangıç noktası sol üst köşedir.
// Birleştirme ve kişi kutularının kurulması TypeScript tarafında yapılır.

import Foundation
import Vision

struct Box: Codable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let confidence: Double
}

struct Output: Codable {
  var faces: [Box] = []
  var poses: [Box] = []
  var bodies: [Box] = []
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

// Vision'da başlangıç noktası sol alttır; arayüz sol üstü kullanır.
func box(_ r: CGRect, _ confidence: Double) -> Box {
  Box(x: Double(r.minX), y: Double(1 - r.maxY), w: Double(r.width), h: Double(r.height), confidence: confidence)
}

guard CommandLine.arguments.count > 1 else { fail("kullanım: people <görsel>") }
let url = URL(fileURLWithPath: CommandLine.arguments[1])

// Yol verildiğinde Vision, dosyadaki EXIF yönünü kendisi uygular; kutular ekranda görünen görsele göredir.
let handler = VNImageRequestHandler(url: url, options: [:])
var output = Output()

// 1) Yüzler: önce tüm kare, sonra örtüşen dört parça. Parçalar, kalabalık
//    fotoğraflardaki küçük yüzleri de yakalar; sonuçlar yine tüm görsele göredir.
let whole = VNDetectFaceRectanglesRequest()
do {
  try handler.perform([whole])
} catch {
  fail("Görsel okunamadı: \(error.localizedDescription)")
}
output.faces += (whole.results ?? []).map { box($0.boundingBox, Double($0.confidence)) }

let span = 0.6
for originX in [0.0, 1 - span] {
  for originY in [0.0, 1 - span] {
    let tile = CGRect(x: originX, y: originY, width: span, height: span)
    let request = VNDetectFaceRectanglesRequest()
    request.regionOfInterest = tile
    guard (try? handler.perform([request])) != nil else { continue }
    for face in request.results ?? [] {
      // Parçanın iç kenarına değen kutular yarım yüz olabilir; öbür parça tamamını verir.
      let b = face.boundingBox
      let margin = 0.012
      let cutLeft = originX > 0 && b.minX - tile.minX < margin
      let cutRight = originX == 0 && tile.maxX - b.maxX < margin
      let cutBottom = originY > 0 && b.minY - tile.minY < margin
      let cutTop = originY == 0 && tile.maxY - b.maxY < margin
      if cutLeft || cutRight || cutBottom || cutTop { continue }
      output.faces.append(box(b, Double(face.confidence)))
    }
  }
}

// 2) Vücut duruşları: eklem noktalarının kapladığı alan kişinin gövdesini verir.
let pose = VNDetectHumanBodyPoseRequest()
if (try? handler.perform([pose])) != nil {
  for body in pose.results ?? [] {
    guard let points = try? body.recognizedPoints(.all) else { continue }
    let sure = points.values.filter { $0.confidence > 0.25 }
    guard sure.count >= 5 else { continue }
    let xs = sure.map { $0.location.x }
    let ys = sure.map { $0.location.y }
    let rect = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    output.poses.append(box(rect, Double(sure.count)))
  }
}

// 3) Kişi dikdörtgenleri: yüzü görünmeyen kişiler için yedek.
let human = VNDetectHumanRectanglesRequest()
human.upperBodyOnly = false
if (try? handler.perform([human])) != nil {
  output.bodies = (human.results ?? []).map { box($0.boundingBox, Double($0.confidence)) }
}

guard let data = try? JSONEncoder().encode(output), let text = String(data: data, encoding: .utf8) else { fail("Çıktı yazılamadı.") }
print(text)
