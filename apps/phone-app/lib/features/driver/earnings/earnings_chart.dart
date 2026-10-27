// A small bar chart of net earnings per day (no chart dependency).

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

class EarningsChart extends StatelessWidget {
  const EarningsChart({super.key, required this.days, this.height = 120});
  final List<EarningsDay> days;
  final double height;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: height,
      width: double.infinity,
      child: Semantics(
        label: days.map((d) => '${d.day}: ${d.netMinor}').join(', '),
        child: CustomPaint(painter: EarningsChartPainter(days: days, bar: c.accent, negative: c.danger, grid: c.border, label: c.muted, textScale: MediaQuery.textScalerOf(context).scale(1), labelStyle: Theme.of(context).textTheme.labelSmall)),
      ),
    );
  }
}

class EarningsChartPainter extends CustomPainter {
  const EarningsChartPainter({required this.days, required this.bar, required this.negative, required this.grid, required this.label, this.textScale = 1, this.labelStyle});
  final List<EarningsDay> days;
  final Color bar;
  final Color negative;
  final Color grid;
  final Color label;
  final double textScale;
  /// the app's font for the day labels (a painter doesn't inherit one)
  final TextStyle? labelStyle;

  @override
  void paint(Canvas canvas, Size size) {
    if (days.isEmpty) return;
    final labelH = 16.0 * textScale;
    final plotH = size.height - labelH - 4;
    final maxAbs = days.fold<int>(0, (m, d) => d.netMinor.abs() > m ? d.netMinor.abs() : m);
    final hasNeg = days.any((d) => d.netMinor < 0);
    final zeroY = hasNeg ? plotH / 2 : plotH;
    final scale = maxAbs == 0 ? 0.0 : (hasNeg ? plotH / 2 : plotH) / maxAbs;
    final gridPaint = Paint()..color = grid..strokeWidth = 1;
    canvas.drawLine(Offset(0, zeroY), Offset(size.width, zeroY), gridPaint);
    final n = days.length;
    final slot = size.width / n;
    final w = (slot * 0.62).clamp(4.0, 28.0);
    for (final (i, d) in days.indexed) {
      final x = slot * i + (slot - w) / 2;
      final h = d.netMinor.abs() * scale;
      final rect = d.netMinor >= 0 ? Rect.fromLTWH(x, zeroY - h, w, h) : Rect.fromLTWH(x, zeroY, w, h);
      canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(4)), Paint()..color = d.netMinor >= 0 ? bar : negative);
      // day-of-month label, every bar when there's room
      if (n <= 14 || i % (n ~/ 7).clamp(1, 31) == 0) {
        final tp = TextPainter(text: TextSpan(text: d.day.length >= 10 ? d.day.substring(8) : d.day, style: (labelStyle ?? const TextStyle()).copyWith(color: label, fontSize: 10 * textScale)), textDirection: TextDirection.ltr)..layout();
        tp.paint(canvas, Offset(x + w / 2 - tp.width / 2, size.height - labelH + 2));
      }
    }
  }

  @override
  bool shouldRepaint(EarningsChartPainter old) => old.days != days || old.bar != bar || old.negative != negative;
}
