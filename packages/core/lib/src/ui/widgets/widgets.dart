// Shared widgets. They take their words as parameters: the app owns localisation.

import 'package:flutter/material.dart';
import '../../api/app_error.dart';
import '../../domain/domain.dart';
import '../theme/anbessa_theme.dart';

enum Tone { amber, green, red, blue, grey }

/// Status pill with a dot, like the web's `.pill`.
class StatusPill extends StatelessWidget {
  const StatusPill(this.label, {super.key, this.tone = Tone.grey, this.pulse = false});
  final String label;
  final Tone tone;
  final bool pulse;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg) = switch (tone) {
      Tone.amber => (c.warning, c.warningSoft),
      Tone.green => (c.success, c.successSoft),
      Tone.red => (c.danger, c.dangerSoft),
      Tone.blue => (c.info, c.infoSoft),
      Tone.grey => (c.text2, c.surface2),
    };
    return Semantics(
      label: label,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            pulse ? _PulsingDot(color: fg) : Container(width: 7, height: 7, decoration: BoxDecoration(color: fg, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Text(label, style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w600, height: 1.2)),
          ],
        ),
      ),
    );
  }
}

class _PulsingDot extends StatefulWidget {
  const _PulsingDot({required this.color});
  final Color color;
  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: 0.35, end: 1.0).animate(_c),
        child: Container(width: 7, height: 7, decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle)),
      );
}

/// Money in a monospace face: "400 ETB".
class MoneyText extends StatelessWidget {
  const MoneyText(this.minor, {super.key, this.style, this.locale = 'en', this.signed = false});
  final int? minor;
  final TextStyle? style;
  final String locale;
  /// show "+" for positive amounts (statements)
  final bool signed;
  @override
  Widget build(BuildContext context) {
    final s = birr(minor, locale: locale);
    return Text(signed && (minor ?? 0) > 0 ? '+$s' : s, style: (style ?? const TextStyle()).copyWith(fontFamilyFallback: monoFamilyFallback, fontFeatures: const [FontFeature.tabularFigures()]));
  }
}

class MonoText extends StatelessWidget {
  const MonoText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) => Text(text, style: (style ?? const TextStyle()).copyWith(fontFamilyFallback: monoFamilyFallback));
}

/// A card with an optional head row, like the web's `.card`.
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, this.title, this.trailing, required this.child, this.padding = const EdgeInsets.all(16)});
  final String? title;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null)
            Container(
              padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.border))),
              child: Row(
                children: [
                  Expanded(child: Text(title!, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
                  ?trailing,
                ],
              ),
            ),
          Padding(padding: padding, child: child),
        ],
      ),
    );
  }
}

enum NoticeTone { info, ok, warning, error }

/// A banner with an icon: information, success, a warning, or an error.
class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.tone = NoticeTone.info, this.action});
  final String text;
  final NoticeTone tone;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg, icon) = switch (tone) {
      NoticeTone.info => (c.info, c.infoSoft, Icons.info_outline),
      NoticeTone.ok => (c.success, c.successSoft, Icons.check_circle_outline),
      NoticeTone.warning => (c.warning, c.warningSoft, Icons.warning_amber_outlined),
      NoticeTone.error => (c.danger, c.dangerSoft, Icons.error_outline),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(anbessaRadius)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: fg),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: TextStyle(color: fg, fontSize: 14, height: 1.35))),
          if (action != null) ...[const SizedBox(width: 8), action!],
        ],
      ),
    );
  }
}

/// An error in words a person can act on. [describe] turns an error code into localised text.
class Problem extends StatelessWidget {
  const Problem(this.error, {super.key, required this.describe, this.onRetry, this.retryLabel = 'Try again'});
  final Object? error;
  final String Function(AppError e) describe;
  final VoidCallback? onRetry;
  final String retryLabel;
  @override
  Widget build(BuildContext context) {
    if (error == null) return const SizedBox.shrink();
    final e = error is AppError ? error as AppError : AppError(status: 0, code: 'unknown', message: error.toString());
    return Notice(describe(e), tone: NoticeTone.error, action: onRetry != null && e.retryable ? TextButton(onPressed: onRetry, child: Text(retryLabel)) : null);
  }
}

/// Seconds left on a ring: offers (15 s), quotes (10 min).
class CountdownRing extends StatelessWidget {
  const CountdownRing({super.key, required this.remaining, required this.total, this.size = 64, this.child});
  final Duration remaining;
  final Duration total;
  final double size;
  final Widget? child;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final frac = total.inMilliseconds == 0 ? 0.0 : (remaining.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          SizedBox(width: size, height: size, child: CircularProgressIndicator(value: frac, strokeWidth: 5, color: frac < 0.3 ? c.danger : c.accent, backgroundColor: c.border)),
          child ?? Text('${remaining.inSeconds}', style: TextStyle(fontSize: size * 0.3, fontWeight: FontWeight.w700, fontFamilyFallback: monoFamilyFallback)),
        ],
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.body, this.icon = Icons.inbox_outlined, this.action});
  final String title;
  final String? body;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: c.faint),
            const SizedBox(height: 12),
            Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            if (body != null) ...[const SizedBox(height: 6), Text(body!, textAlign: TextAlign.center, style: TextStyle(color: c.muted))],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.label, this.onPressed, this.busy = false, this.icon, this.danger = false});
  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final IconData? icon;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return FilledButton(
      onPressed: busy ? null : onPressed,
      style: danger ? FilledButton.styleFrom(backgroundColor: c.danger) : null,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy) const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) else if (icon != null) Icon(icon, size: 20),
          if (busy || icon != null) const SizedBox(width: 8),
          Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
        ],
      ),
    );
  }
}

/// A label/value row for `kv` lists.
class KeyValue extends StatelessWidget {
  const KeyValue(this.label, this.value, {super.key});
  final String label;
  final Widget value;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 130, child: Text(label, style: TextStyle(color: c.muted, fontSize: 14))),
          Expanded(child: DefaultTextStyle.merge(style: const TextStyle(fontSize: 14), child: Align(alignment: Alignment.centerLeft, child: value))),
        ],
      ),
    );
  }
}

/// Big number with a label, like the web's `.stat`.
class Stat extends StatelessWidget {
  const Stat({super.key, required this.label, required this.value, this.sub, this.alert = false});
  final String label;
  final Widget value;
  final String? sub;
  final bool alert;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(anbessaRadiusLg), border: Border.all(color: alert ? c.danger : c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: c.muted, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          DefaultTextStyle.merge(style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: alert ? c.danger : c.text), child: value),
          if (sub != null) ...[const SizedBox(height: 2), Text(sub!, style: TextStyle(color: c.muted, fontSize: 12))],
        ],
      ),
    );
  }
}
