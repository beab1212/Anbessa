// The GoRide pill buttons: fully rounded, 56 tall, bold label, a small press-in scale and an ink
// ripple. One widget, several looks (see PillVariant). PrimaryButton (basics.dart) is built on it.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

enum PillVariant {
  /// amber fill, ink label: the main action ("Continue", "Book Ride")
  primary,

  /// pale amber fill, dark-amber label in light mode; neutral grey in dark mode ("Skip", "Sign in")
  tonal,

  /// amber outline and label on the page ("Track Route", "Share Receipt")
  outline,

  /// red outline and label ("Cancel Ride")
  outlineDanger,

  /// grey fill, ink label ("Call" and "Cancel" in dark mode)
  neutral,

  /// hairline outline, ink label ("Continue with Google")
  outlineNeutral,

  /// red fill, white label (destructive confirmations)
  danger,
}

class PillButton extends StatelessWidget {
  const PillButton({
    super.key,
    required this.label,
    this.onPressed,
    this.variant = PillVariant.primary,
    this.icon,
    this.leading,
    this.trailing,
    this.busy = false,
    this.compact = false,
    this.expand = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final PillVariant variant;
  /// drawn before the label (hidden while busy)
  final IconData? icon;
  /// a widget before the label instead of [icon] (a brand logo)
  final Widget? leading;
  /// text at the far end (the price on a request button); the label then starts the row
  final String? trailing;
  final bool busy;
  /// 40 tall, smaller label ("Redeem", "Top Up", "Undo")
  final bool compact;
  /// fill the available width
  final bool expand;

  /// The fill, the label colour and the outline of [variant] in palette [c].
  static (Color bg, Color fg, Color? side) colorsOf(PillVariant variant, AnbessaColors c) => switch (variant) {
        PillVariant.primary => (c.primaryFill, c.onAccent, null),
        PillVariant.tonal => (c.tonalFill, c.onTonal, null),
        PillVariant.outline => (Colors.transparent, c.accentText, c.accent),
        PillVariant.outlineDanger => (Colors.transparent, c.danger, c.danger),
        PillVariant.neutral => (c.neutralFill, c.text, null),
        PillVariant.outlineNeutral => (Colors.transparent, c.text, c.border),
        PillVariant.danger => (c.danger, c.isDark ? const Color(0xFF1A0000) : Colors.white, null),
      };

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final enabled = onPressed != null && !busy;
    var (bg, fg, side) = colorsOf(variant, c);
    if (onPressed == null && !busy) {
      // disabled: grey, whatever the variant
      bg = side == null ? (c.isDark ? c.surface2 : c.border) : Colors.transparent;
      fg = c.muted;
      side = side == null ? null : c.border;
    }
    final height = compact ? AnbessaSize.buttonCompact : AnbessaSize.button;
    final style = (compact ? AnbessaType.body2.copyWith(fontWeight: FontWeight.w700) : AnbessaType.button).copyWith(color: fg);
    final iconSize = compact ? 16.0 : 20.0;
    final lead = busy
        ? SizedBox(width: iconSize - 2, height: iconSize - 2, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
        : leading ?? (icon != null ? Icon(icon, size: iconSize, color: fg) : null);
    final content = Row(
      mainAxisSize: expand || trailing != null ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (lead != null) ...[ExcludeSemantics(child: lead), SizedBox(width: compact ? 6 : 10)],
        if (trailing == null)
          Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: style))
        else ...[
          Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
          const SizedBox(width: 8),
          Text(trailing!, maxLines: 1, style: style.copyWith(fontFeatures: AnbessaType.tabular)),
        ],
      ],
    );
    return Semantics(
      button: true,
      enabled: enabled,
      label: busy ? label : null,
      child: PressScale(
        enabled: enabled,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: height, minWidth: compact ? 64 : 88),
          child: Material(
            color: bg,
            shape: StadiumBorder(side: side == null ? BorderSide.none : BorderSide(color: side, width: 1.5)),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: enabled ? onPressed : null,
              splashColor: fg.withValues(alpha: 0.12),
              highlightColor: fg.withValues(alpha: 0.06),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: compact ? 16 : 24, vertical: compact ? 8 : 14),
                child: Center(widthFactor: expand ? null : 1, heightFactor: 1, child: content),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Shrinks its child a little while a finger is down (0.97), springing back on release. No
/// scale when motion is reduced or [enabled] is false. Does not take the tap itself.
class PressScale extends StatefulWidget {
  const PressScale({super.key, required this.child, this.enabled = true, this.scale = 0.97});
  final Widget child;
  final bool enabled;
  final double scale;
  @override
  State<PressScale> createState() => _PressScaleState();
}

class _PressScaleState extends State<PressScale> {
  bool _down = false;

  void _set(bool v) {
    if (_down != v && mounted) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    final reduced = AnbessaMotion.reduced(context);
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: widget.enabled && !reduced ? (_) => _set(true) : null,
      onPointerUp: (_) => _set(false),
      onPointerCancel: (_) => _set(false),
      child: AnimatedScale(
        scale: _down ? widget.scale : 1,
        duration: _down ? AnbessaMotion.fast : AnbessaMotion.short,
        curve: _down ? AnbessaMotion.standard : AnbessaMotion.spring,
        child: widget.child,
      ),
    );
  }
}

/// Two pills side by side, equal widths ("Skip" | "Continue", "Call" | "Chat").
class PillButtonPair extends StatelessWidget {
  const PillButtonPair({super.key, required this.first, required this.second, this.gap = 12});
  final Widget first;
  final Widget second;
  final double gap;
  @override
  Widget build(BuildContext context) => Row(children: [Expanded(child: first), SizedBox(width: gap), Expanded(child: second)]);
}

/// The pinned bottom area of a form or result screen: page colour, a hairline above, the gutter,
/// the system inset below. Holds a PillButton or a PillButtonPair.
class BottomActionBar extends StatelessWidget {
  const BottomActionBar({super.key, required this.child, this.divider = true});
  final Widget child;
  final bool divider;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return DecoratedBox(
      decoration: BoxDecoration(color: c.page, border: divider ? Border(top: BorderSide(color: c.border)) : null),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.only(bottom: 16),
        child: Padding(padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 16, AnbessaSpace.page, 0), child: child),
      ),
    );
  }
}
