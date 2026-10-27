// Banners that float over the map instead of pushing it down: maintenance, reconnecting,
// announcements, the driver's balance state.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'basics.dart';

/// A banner over the map: the tone's icon (or [icon]) in a soft circle, an optional title, the
/// text, an action and a close button. [pulse] swaps the icon for a pulsing dot.
class FloatingBanner extends StatelessWidget {
  const FloatingBanner({super.key, required this.text, this.title, this.tone = NoticeTone.info, this.action, this.actionLabel, this.onDismiss, this.pulse = false, this.icon});
  final String text;
  final String? title;
  final NoticeTone tone;
  final VoidCallback? action;
  final String? actionLabel;
  final VoidCallback? onDismiss;
  final bool pulse;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg, toneIcon) = tone.of(c);
    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
        decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: c.isDark ? Border.all(color: c.border) : null, boxShadow: AnbessaElevation.floating(c.brightness)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
              alignment: Alignment.center,
              child: pulse ? PulsingDot(color: fg, size: 10) : Icon(icon ?? toneIcon, size: 18, color: fg),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (title != null) Text(title!, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w600, color: c.text)),
                  Text(text, style: AnbessaType.caption.copyWith(color: c.text2), maxLines: 3, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            if (action != null && actionLabel != null) TextButton(onPressed: action, style: TextButton.styleFrom(foregroundColor: c.text, visualDensity: VisualDensity.compact), child: Text(actionLabel!)),
            if (onDismiss != null) IconButton(onPressed: onDismiss, icon: const Icon(Icons.close_rounded, size: 18), visualDensity: VisualDensity.compact, tooltip: ''),
          ],
        ),
      ),
    );
  }
}

/// Stacks banners under the status bar with animated insertion and removal. Report the stack's
/// height through [onHeightChanged] so maps can keep their top controls below it.
class FloatingBannerStack extends StatelessWidget {
  const FloatingBannerStack({super.key, required this.children, this.onHeightChanged, this.safeTop = true});
  final List<Widget> children;
  final ValueChanged<double>? onHeightChanged;
  final bool safeTop;

  @override
  Widget build(BuildContext context) {
    final top = safeTop ? MediaQuery.paddingOf(context).top : 0.0;
    return Padding(
      padding: EdgeInsets.fromLTRB(12, top + 8, 12, 0),
      child: _Measured(
        onHeight: onHeightChanged,
        child: AnimatedSize(
          duration: AnbessaMotion.of(context, AnbessaMotion.slow),
          curve: AnbessaMotion.emphasized,
          alignment: Alignment.topCenter,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final w in children)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: AnimatedSwitcher(duration: AnbessaMotion.of(context, AnbessaMotion.slow), child: w),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Measured extends StatefulWidget {
  const _Measured({required this.child, this.onHeight});
  final Widget child;
  final ValueChanged<double>? onHeight;
  @override
  State<_Measured> createState() => _MeasuredState();
}

class _MeasuredState extends State<_Measured> {
  double _last = -1;
  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final h = context.size?.height ?? 0;
      if ((h - _last).abs() > 0.5) {
        _last = h;
        widget.onHeight?.call(h);
      }
    });
    return widget.child;
  }
}
