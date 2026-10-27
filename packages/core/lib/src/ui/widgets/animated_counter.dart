// Numbers that roll to their new value instead of jumping.

import 'package:flutter/material.dart';
import '../../domain/domain.dart';
import '../theme/tokens.dart';

class AnimatedCounter extends StatelessWidget {
  const AnimatedCounter({super.key, required this.value, required this.format, this.style, this.duration = const Duration(milliseconds: 600)});
  final num value;
  final String Function(num v) format;
  final TextStyle? style;
  final Duration duration;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(end: value.toDouble()),
        duration: AnbessaMotion.of(context, duration),
        curve: AnbessaMotion.emphasized,
        builder: (_, v, _) => Text(format(v), style: (style ?? const TextStyle()).copyWith(fontFeatures: AnbessaType.tabular)),
      );
}

class AnimatedMoney extends StatelessWidget {
  const AnimatedMoney(this.minor, {super.key, this.style, this.locale = 'en'});
  final int minor;
  final TextStyle? style;
  final String locale;
  @override
  Widget build(BuildContext context) => AnimatedCounter(value: minor, format: (v) => birr(v.round(), locale: locale), style: style);
}
