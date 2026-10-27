// Floating buttons over the map: round icon buttons (back, share, SOS) and the "Recenter" pill.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

/// A 44 px circular button floating over the map with a soft shadow (back, share, SOS with
/// [danger]).
class RoundIconButton extends StatelessWidget {
  const RoundIconButton({super.key, required this.icon, required this.onTap, required this.tooltip, this.danger = false, this.size = 44});
  final IconData icon;
  final VoidCallback? onTap;
  final String tooltip;
  /// red fill with a white icon (SOS)
  final bool danger;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        excludeSemantics: true,
        child: DecoratedBox(
          decoration: BoxDecoration(shape: BoxShape.circle, boxShadow: AnbessaElevation.floating(c.brightness)),
          child: Material(
            color: danger ? c.danger : c.surface,
            shape: const CircleBorder(),
            child: InkWell(
              onTap: onTap,
              customBorder: const CircleBorder(),
              child: SizedBox(width: size, height: size, child: Icon(icon, size: size * 0.48, color: danger ? Colors.white : c.text)),
            ),
          ),
        ),
      ),
    );
  }
}

/// A floating "Recenter" pill with an icon; scales and fades in or out with [visible] (gone from
/// the tree once hidden).
class RecenterPill extends StatelessWidget {
  const RecenterPill({super.key, required this.label, required this.onTap, this.visible = true, this.icon = Icons.near_me_rounded});
  final String label;
  final VoidCallback? onTap;
  final bool visible;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AnimatedSwitcher(
      duration: AnbessaMotion.of(context, AnbessaMotion.short),
      switchInCurve: AnbessaMotion.emphasizedDecelerate,
      switchOutCurve: AnbessaMotion.emphasizedAccelerate,
      transitionBuilder: (child, a) => FadeTransition(opacity: a, child: ScaleTransition(scale: Tween(begin: 0.85, end: 1.0).animate(a), child: child)),
      child: !visible
          ? const SizedBox.shrink(key: ValueKey('hidden'))
          : DecoratedBox(
              key: const ValueKey('shown'),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.floating(c.brightness)),
              child: Material(
                color: c.surface,
                shape: const StadiumBorder(),
                child: InkWell(
                  onTap: onTap,
                  customBorder: const StadiumBorder(),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 16, 10),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(icon, size: 18, color: c.info),
                        const SizedBox(width: 6),
                        Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w700, color: c.text))),
                      ],
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}
