// The small building blocks: pills, money, cards, notices, buttons, key/value rows. They take
// their words as parameters: the app owns localisation.

import 'package:flutter/material.dart';
import '../../api/app_error.dart';
import '../../domain/domain.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

enum Tone { amber, green, red, blue, grey }

extension ToneColors on Tone {
  (Color fg, Color bg) colorsOf(AnbessaColors c) => switch (this) {
        Tone.amber => (c.warning, c.warningSoft),
        Tone.green => (c.success, c.successSoft),
        Tone.red => (c.danger, c.dangerSoft),
        Tone.blue => (c.info, c.infoSoft),
        Tone.grey => (c.text2, c.surface2),
      };
}

/// A status label in a tinted pill: an [icon] when given, otherwise a dot (pulsing when [pulse]).
class StatusPill extends StatelessWidget {
  const StatusPill(this.label, {super.key, this.tone = Tone.grey, this.pulse = false, this.icon});
  final String label;
  final Tone tone;
  final bool pulse;
  /// drawn before the label in the tone colour (instead of the dot)
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg) = tone.colorsOf(c);
    return Semantics(
      label: label,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(AnbessaRadius.pill)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (pulse)
              PulsingDot(color: fg)
            else if (icon != null)
              Icon(icon, size: 14, color: fg)
            else
              Container(width: 7, height: 7, decoration: BoxDecoration(color: fg, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Flexible(child: Text(label, style: AnbessaType.label.copyWith(color: tone == Tone.grey ? c.text2 : fg), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
    );
  }
}

class PulsingDot extends StatefulWidget {
  const PulsingDot({super.key, required this.color, this.size = 7});
  final Color color;
  final double size;
  @override
  State<PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<PulsingDot> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: 0.35, end: 1.0).animate(_c),
        child: Container(width: widget.size, height: widget.size, decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle)),
      );
}

/// Money with tabular figures: "400 ETB".
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
    return Text(signed && (minor ?? 0) > 0 ? '+$s' : s, style: (style ?? const TextStyle()).copyWith(fontFeatures: AnbessaType.tabular));
  }
}

class MonoText extends StatelessWidget {
  const MonoText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) => Text(text, style: (style ?? const TextStyle()).copyWith(fontFamilyFallback: monoFamilyFallback, fontFeatures: AnbessaType.tabular));
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
              child: LayoutBuilder(
                builder: (context, box) => Row(
                  children: [
                    Expanded(child: Text(title!, style: Theme.of(context).textTheme.titleMedium)),
                    if (trailing != null) ConstrainedBox(constraints: BoxConstraints(maxWidth: box.maxWidth * 0.6), child: trailing),
                  ],
                ),
              ),
            ),
          Padding(padding: padding, child: child),
        ],
      ),
    );
  }
}

enum NoticeTone { info, ok, warning, error }

extension NoticeToneColors on NoticeTone {
  (Color fg, Color bg, IconData icon) of(AnbessaColors c) => switch (this) {
        NoticeTone.info => (c.info, c.infoSoft, Icons.info_rounded),
        NoticeTone.ok => (c.success, c.successSoft, Icons.check_circle_rounded),
        NoticeTone.warning => (c.warning, c.warningSoft, Icons.warning_rounded),
        NoticeTone.error => (c.danger, c.dangerSoft, Icons.error_rounded),
      };
}

/// A tinted panel for information, success, a warning or an error: the tone colours the icon, the
/// border and the tint; the words stay ink so they read.
class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.tone = NoticeTone.info, this.action});
  final String text;
  final NoticeTone tone;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg, icon) = tone.of(c);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: fg.withValues(alpha: 0.35), width: 1.5)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          ExcludeSemantics(child: Icon(icon, size: 20, color: fg)),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: AnbessaType.body2.copyWith(color: c.text, fontWeight: FontWeight.w500))),
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

/// Seconds left on a ring: offers (15 s), quotes (10 min), waiting at the pickup.
class CountdownRing extends StatelessWidget {
  const CountdownRing({super.key, required this.remaining, required this.total, this.size = 64, this.child, this.strokeWidth = 5, this.invert = false});
  final Duration remaining;
  final Duration total;
  final double size;
  final Widget? child;
  final double strokeWidth;
  /// fill up instead of running down (a waiting timer)
  final bool invert;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final frac = total.inMilliseconds == 0 ? 0.0 : (remaining.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
    final shown = invert ? 1 - frac : frac;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          TweenAnimationBuilder<double>(
            tween: Tween(end: shown),
            duration: AnbessaMotion.of(context, AnbessaMotion.base),
            builder: (_, v, _) => SizedBox(width: size, height: size, child: CircularProgressIndicator(value: v, strokeWidth: strokeWidth, strokeCap: StrokeCap.round, color: !invert && frac < 0.3 ? c.danger : c.accent, backgroundColor: c.border)),
          ),
          child ?? Text('${remaining.inSeconds}', style: TextStyle(fontSize: size * 0.3, fontWeight: FontWeight.w700, fontFeatures: AnbessaType.tabular)),
        ],
      ),
    );
  }
}

/// Nothing here yet: an icon in a soft circle, a heading, a line and an action.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.body, this.icon = Icons.inbox_rounded, this.action});
  final String title;
  final String? body;
  /// drawn in a 64 px tinted circle above the title
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
            ExcludeSemantics(
              child: Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(color: c.accentSoft, shape: BoxShape.circle),
                child: Icon(icon, size: 30, color: c.isDark ? c.accent : c.text),
              ),
            ),
            const SizedBox(height: 16),
            Text(title, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text)),
            if (body != null) ...[const SizedBox(height: 8), Text(body!, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2))],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

/// The main action: amber-filled with ink words, an optional leading [icon], a busy spinner.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.label, this.onPressed, this.busy = false, this.icon, this.danger = false, this.trailing});
  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  /// drawn before the label (hidden while busy)
  final IconData? icon;
  final bool danger;
  /// e.g. the price on the right of a request button
  final String? trailing;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return FilledButton(
      onPressed: busy ? null : onPressed,
      style: danger ? FilledButton.styleFrom(backgroundColor: c.danger, foregroundColor: Colors.white) : null,
      child: Row(
        mainAxisSize: trailing == null ? MainAxisSize.min : MainAxisSize.max,
        children: [
          if (busy) ...[SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: danger ? Colors.white : c.onAccent)), const SizedBox(width: 10)]
          else if (icon != null) ...[Icon(icon, size: 20), const SizedBox(width: 10)],
          Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
          if (trailing != null) ...[const Spacer(), Text(trailing!, style: const TextStyle(fontFeatures: AnbessaType.tabular))],
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
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: Border.all(color: alert ? c.danger : c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: AnbessaType.label.copyWith(color: c.muted)),
          const SizedBox(height: 4),
          DefaultTextStyle.merge(style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: alert ? c.danger : c.text, fontFeatures: AnbessaType.tabular), child: value),
          if (sub != null) ...[const SizedBox(height: 2), Text(sub!, style: TextStyle(color: c.muted, fontSize: 12))],
        ],
      ),
    );
  }
}
