// Draws the app icon, adaptive-icon layers and splash mark with dart:ui.
// Run:  flutter test tool/make_icon_test.dart
// then: dart run flutter_launcher_icons && dart run flutter_native_splash:create
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';

const _bg = ui.Color(0xFF0B0B0E);

/// Three fanned posters; the front one carries a play triangle.
void _mark(ui.Canvas c, double size, {double scale = 1, bool mono = false}) {
  c.save();
  c.translate(size / 2, size / 2 + size * 0.02 * scale);
  c.scale(scale);
  final w = size * 0.40, h = w * 1.5, pivot = h * 0.95;
  final rect = ui.RRect.fromRectAndRadius(ui.Rect.fromCenter(center: ui.Offset.zero, width: w, height: h), ui.Radius.circular(w * 0.13));
  void card(double angle, List<ui.Color> colors, double alpha) {
    c.save();
    c.translate(0, pivot);
    c.rotate(angle);
    c.translate(0, -pivot);
    if (!mono) {
      c.drawRRect(rect.shift(ui.Offset(0, size * 0.012)), ui.Paint()..color = const ui.Color(0x66000000)..maskFilter = ui.MaskFilter.blur(ui.BlurStyle.normal, size * 0.02));
    }
    c.drawRRect(
        rect,
        ui.Paint()
          ..shader = mono
              ? null
              : ui.Gradient.linear(ui.Offset(-w / 2, -h / 2), ui.Offset(w / 2, h / 2), colors)
          ..color = mono ? ui.Color.fromRGBO(255, 255, 255, alpha) : const ui.Color(0xFFFFFFFF));
    c.restore();
  }

  card(-0.36, const [ui.Color(0xFF9B3B4E), ui.Color(0xFF4B1A2B)], 0.4);
  card(0.36, const [ui.Color(0xFF3F54B8), ui.Color(0xFF1B2352)], 0.4);
  card(0, const [ui.Color(0xFFFFD970), ui.Color(0xFFFF9838)], 1);
  final t = w * 0.24;
  final tri = ui.Path()
    ..moveTo(-t * 0.72, -t)
    ..lineTo(t * 1.0, 0)
    ..lineTo(-t * 0.72, t)
    ..close();
  c.drawPath(
      tri,
      ui.Paint()
        ..color = mono ? const ui.Color(0x00000000) : const ui.Color(0xFF1B1300)
        ..blendMode = mono ? ui.BlendMode.clear : ui.BlendMode.srcOver
        ..style = ui.PaintingStyle.fill);
  c.drawPath(
      tri,
      ui.Paint()
        ..color = mono ? const ui.Color(0x00000000) : const ui.Color(0xFF1B1300)
        ..blendMode = mono ? ui.BlendMode.clear : ui.BlendMode.srcOver
        ..style = ui.PaintingStyle.stroke
        ..strokeWidth = t * 0.34
        ..strokeJoin = ui.StrokeJoin.round);
  c.restore();
}

Future<void> _png(String path, int size, void Function(ui.Canvas, double) draw) async {
  final rec = ui.PictureRecorder();
  final c = ui.Canvas(rec);
  draw(c, size.toDouble());
  final img = await rec.endRecording().toImage(size, size);
  final data = await img.toByteData(format: ui.ImageByteFormat.png);
  File(path)
    ..createSync(recursive: true)
    ..writeAsBytesSync(data!.buffer.asUint8List());
}

void main() {
  testWidgets('render icon assets', (tester) async {
    await tester.runAsync(() async {
      await _png('assets/icon/icon.png', 1024, (c, s) {
        c.drawRect(ui.Rect.fromLTWH(0, 0, s, s), ui.Paint()..color = _bg);
        c.drawCircle(ui.Offset(s / 2, s * 0.62), s * 0.5, ui.Paint()..shader = ui.Gradient.radial(ui.Offset(s / 2, s * 0.62), s * 0.5, const [ui.Color(0x55FF9838), ui.Color(0x00FF9838)]));
        _mark(c, s, scale: 0.96);
      });
      // Adaptive layers keep the mark inside the 66% safe zone.
      await _png('assets/icon/icon_fg.png', 1024, (c, s) => _mark(c, s, scale: 0.74));
      await _png('assets/icon/icon_mono.png', 1024, (c, s) {
        c.saveLayer(null, ui.Paint());
        _mark(c, s, scale: 0.74, mono: true);
        c.restore();
      });
      await _png('assets/icon/splash.png', 768, (c, s) => _mark(c, s, scale: 1.0));
      await _png('assets/icon/splash12.png', 1152, (c, s) => _mark(c, s, scale: 0.58));
    });
  });
}
