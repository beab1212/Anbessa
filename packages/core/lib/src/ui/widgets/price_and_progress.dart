// A price that may carry a discount, and a flat progress meter (incentive targets).

import 'package:flutter/material.dart';
import '../../domain/domain.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'animated_counter.dart';

/// What the person pays, with the undiscounted price struck through above it when a promo
/// lowered it. Animates between prices like [AnimatedMoney].
class PriceTag extends StatelessWidget {
  const PriceTag({super.key, required this.fareMinor, required this.payableMinor, this.style, this.locale = 'en'});
  final int fareMinor;
  final int payableMinor;
  final TextStyle? style;
  final String locale;
  bool get discounted => payableMinor < fareMinor;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final main = AnimatedMoney(payableMinor, locale: locale, style: (style ?? AnbessaType.h2).copyWith(color: discounted ? c.success : (style?.color ?? c.text)));
    if (!discounted) return main;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          birr(fareMinor, locale: locale),
          style: AnbessaType.caption.copyWith(color: c.muted, decoration: TextDecoration.lineThrough, decorationColor: c.muted, fontFeatures: AnbessaType.tabular),
        ),
        main,
      ],
    );
  }
}

/// A thin bar from 0 to 1: ink on a hairline track, green once full.
class ProgressMeter extends StatelessWidget {
  const ProgressMeter({super.key, required this.value, this.height = 6, this.semanticsLabel});
  final double value;
  final double height;
  final String? semanticsLabel;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final v = value.isNaN ? 0.0 : value.clamp(0.0, 1.0);
    return Semantics(
      label: semanticsLabel,
      value: '${(v * 100).round()}%',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(height / 2),
        child: SizedBox(
          height: height,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: c.border),
              FractionallySizedBox(
                alignment: AlignmentDirectional.centerStart,
                widthFactor: v,
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: 1),
                  duration: AnbessaMotion.of(context, AnbessaMotion.slow),
                  builder: (context, t, _) => ColoredBox(color: (v >= 1 ? c.success : c.text).withValues(alpha: 0.4 + 0.6 * t)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
