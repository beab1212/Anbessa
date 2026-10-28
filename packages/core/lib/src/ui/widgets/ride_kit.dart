// Ride pieces from the GoRide kit:
//   RideClassTile: the vertical choose-ride row (art, name, "3–5 mins · 4 passengers", price; a
//     discounted price gets a small seal and the old price struck through under it).
//   RoutePointsCard: pickup / destination rows stacked in a white card at the top of map screens.
//   DriverRow: avatar, name, ★ rating and phone, round outlined chat and call buttons.
//   CircleActionButton: the round outlined amber icon button those use.

import 'package:flutter/material.dart';
import '../../domain/domain.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'animated_counter.dart';
import 'avatar_image.dart';
import 'feedback.dart';
import 'vehicle_card.dart';

class RideClassTile extends StatelessWidget {
  const RideClassTile({
    super.key,
    required this.code,
    required this.name,
    required this.fareMinor,
    this.payableMinor,
    this.etaLabel,
    this.seatsLabel,
    this.selected = false,
    this.onTap,
    this.locale = 'en',
    this.art,
  });
  /// the vehicle class code (picks the art)
  final String code;
  final String name;
  /// the fare before any promo
  final int fareMinor;
  /// what the person pays; when lower, [fareMinor] is struck through under it
  final int? payableMinor;
  /// "3–5 mins"
  final String? etaLabel;
  /// "4 passengers"
  final String? seatsLabel;
  final bool selected;
  final VoidCallback? onTap;
  final String locale;
  /// instead of the class art
  final Widget? art;

  bool get discounted => payableMinor != null && payableMinor! < fareMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = AnbessaMotion.of(context, AnbessaMotion.short);
    final r = BorderRadius.circular(AnbessaRadius.md);
    final pay = payableMinor ?? fareMinor;
    final meta = AnbessaType.caption.copyWith(fontSize: 12, color: c.muted);
    return Semantics(
      button: true,
      selected: selected,
      label: [name, ?etaLabel, ?seatsLabel, birr(pay, locale: locale)].join(', '),
      excludeSemantics: true,
      child: AnimatedContainer(
        duration: d,
        curve: AnbessaMotion.emphasized,
        decoration: BoxDecoration(
          color: selected ? Color.alphaBlend(c.selectedFill, c.cardFill) : c.cardFill,
          borderRadius: r,
          border: Border.all(color: selected ? c.accent : c.cardBorder, width: selected ? 1.5 : 1),
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            borderRadius: r,
            onTap: onTap == null
                ? null
                : () {
                    Haptics.selection();
                    onTap!();
                  },
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 16, 12),
              child: Row(
                children: [
                  SizedBox(width: 56, child: art ?? VehicleArt(code, width: 56)),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text)),
                        if (etaLabel != null || seatsLabel != null) ...[
                          const SizedBox(height: 6),
                          Wrap(
                            spacing: 10,
                            runSpacing: 2,
                            children: [
                              if (etaLabel != null) _Meta(icon: Icons.schedule_rounded, text: etaLabel!, style: meta),
                              if (seatsLabel != null) _Meta(icon: Icons.people_outline_rounded, text: seatsLabel!, style: meta),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (discounted) ...[Icon(Icons.verified_rounded, size: 16, color: c.accent), const SizedBox(width: 4)],
                          AnimatedMoney(pay, locale: locale, style: AnbessaType.title.copyWith(fontSize: 17, color: c.text)),
                        ],
                      ),
                      if (discounted) ...[
                        const SizedBox(height: 4),
                        Text(birr(fareMinor, locale: locale), maxLines: 1, style: meta.copyWith(fontSize: 11, decoration: TextDecoration.lineThrough, decorationColor: c.muted, fontFeatures: AnbessaType.tabular)),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Meta extends StatelessWidget {
  const _Meta({required this.icon, required this.text, required this.style});
  final IconData icon;
  final String text;
  final TextStyle style;
  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [Icon(icon, size: 13, color: style.color), const SizedBox(width: 4), Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: style))],
      );
}

/// One stop of a [RoutePointsCard].
typedef RoutePoint = ({String label, bool destination, VoidCallback? onTap});

/// The pickup and destination(s) stacked in a card over the map: an amber dot for the pickup, a
/// red pin for the destination, a dotted line between them, hairlines between rows, and an
/// optional + on the last row (add a stop).
class RoutePointsCard extends StatelessWidget {
  const RoutePointsCard({super.key, required this.points, this.onAdd, this.addTooltip = 'Add stop', this.floating = true});
  final List<RoutePoint> points;
  final VoidCallback? onAdd;
  final String addTooltip;
  /// a soft shadow (over the map)
  final bool floating;

  static RoutePoint pickup(String label, {VoidCallback? onTap}) => (label: label, destination: false, onTap: onTap);
  static RoutePoint destination(String label, {VoidCallback? onTap}) => (label: label, destination: true, onTap: onTap);

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(AnbessaRadius.md),
        boxShadow: floating ? AnbessaElevation.floating(c.brightness) : null,
        border: c.isDark ? Border.all(color: c.border) : null,
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, p) in points.indexed)
            Material(
              type: MaterialType.transparency,
              child: InkWell(
                onTap: p.onTap,
                child: SizedBox(
                  height: 44,
                  child: Row(
                    children: [
                      SizedBox(
                        width: 44,
                        child: CustomPaint(
                          painter: _StopPainter(
                            color: p.destination ? c.danger : c.accent,
                            pin: p.destination,
                            lineAbove: i > 0,
                            lineBelow: i < points.length - 1,
                            lineColor: c.borderStrong,
                          ),
                          child: const SizedBox.expand(),
                        ),
                      ),
                      Expanded(
                        child: Container(
                          height: 44,
                          alignment: AlignmentDirectional.centerStart,
                          decoration: i < points.length - 1 ? BoxDecoration(border: Border(bottom: BorderSide(color: c.border))) : null,
                          child: Text(p.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.text, fontWeight: FontWeight.w600)),
                        ),
                      ),
                      if (onAdd != null && i == points.length - 1)
                        IconButton(onPressed: onAdd, tooltip: addTooltip, icon: Icon(Icons.add_rounded, color: c.accentText, size: 24))
                      else
                        const SizedBox(width: 16),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _StopPainter extends CustomPainter {
  _StopPainter({required this.color, required this.pin, required this.lineAbove, required this.lineBelow, required this.lineColor});
  final Color color;
  final bool pin;
  final bool lineAbove;
  final bool lineBelow;
  final Color lineColor;

  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2 + 2, cy = size.height / 2;
    final dash = Paint()
      ..color = lineColor
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round;
    void dots(double from, double to) {
      for (var y = from; y < to; y += 4) {
        canvas.drawLine(Offset(cx, y), Offset(cx, y + 1.5), dash);
      }
    }

    if (lineAbove) dots(0, cy - 9);
    if (lineBelow) dots(cy + 9, size.height);
    final p = Paint()..color = color;
    if (pin) {
      // a small map pin: a circle with a point, a white hole
      final path = Path()
        ..moveTo(cx, cy + 8)
        ..quadraticBezierTo(cx - 6.5, cy + 0.5, cx - 6.5, cy - 2.5)
        ..arcToPoint(Offset(cx + 6.5, cy - 2.5), radius: const Radius.circular(6.5))
        ..quadraticBezierTo(cx + 6.5, cy + 0.5, cx, cy + 8)
        ..close();
      canvas.drawPath(path, p);
      canvas.drawCircle(Offset(cx, cy - 2.5), 2.4, Paint()..color = const Color(0xFFFFFFFF));
    } else {
      canvas.drawCircle(Offset(cx, cy), 7, p..color = color.withValues(alpha: 0.25));
      canvas.drawCircle(Offset(cx, cy), 4.5, Paint()..color = color);
    }
  }

  @override
  bool shouldRepaint(_StopPainter o) => o.color != color || o.pin != pin || o.lineAbove != lineAbove || o.lineBelow != lineBelow || o.lineColor != lineColor;
}

/// A round icon button with an amber outline ("chat", "call" next to the driver).
class CircleActionButton extends StatelessWidget {
  const CircleActionButton({super.key, required this.icon, required this.onTap, required this.tooltip, this.size = 44, this.filled = false});
  final IconData icon;
  final VoidCallback? onTap;
  final String tooltip;
  final double size;
  /// amber-filled with an ink glyph (the send button of the chat)
  final bool filled;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        excludeSemantics: true,
        child: Material(
          color: filled ? c.primaryFill : Colors.transparent,
          shape: CircleBorder(side: filled ? BorderSide.none : BorderSide(color: c.accent, width: 1.5)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: SizedBox(width: size, height: size, child: Icon(icon, size: size * 0.45, color: filled ? c.onAccent : c.accentText)),
          ),
        ),
      ),
    );
  }
}

/// The driver on the trip sheet: avatar, name, "★ 4.8  ☎ +251 …", and chat / call buttons.
class DriverRow extends StatelessWidget {
  const DriverRow({
    super.key,
    required this.name,
    this.photo,
    this.rating,
    this.phone,
    this.subtitle,
    this.onChat,
    this.onCall,
    this.chatTooltip = 'Chat',
    this.callTooltip = 'Call',
    this.onTap,
  });
  final String name;
  /// a data URL or https URL (see AvatarImage)
  final String? photo;
  /// "4.8"
  final String? rating;
  final String? phone;
  /// instead of the phone ("Toyota Camry, Black · DEF-9012")
  final String? subtitle;
  final VoidCallback? onChat;
  final VoidCallback? onCall;
  final String chatTooltip;
  final String callTooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final meta = AnbessaType.caption.copyWith(fontSize: 12, color: c.muted);
    final row = Row(
      children: [
        AvatarImage(src: photo, name: name, size: 52),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(fontSize: 18, color: c.text)),
              const SizedBox(height: 4),
              Wrap(
                spacing: 10,
                runSpacing: 2,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (rating != null)
                    Row(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.star_rounded, size: 14, color: Color(0xFFFFB300)), const SizedBox(width: 2), Text(rating!, style: meta)]),
                  if (subtitle != null)
                    Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: meta)
                  else if (phone != null)
                    Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.phone_outlined, size: 13, color: c.muted), const SizedBox(width: 3), Flexible(child: Text(phone!, maxLines: 1, overflow: TextOverflow.ellipsis, style: meta))]),
                ],
              ),
            ],
          ),
        ),
        if (onChat != null) ...[const SizedBox(width: 8), CircleActionButton(icon: Icons.chat_bubble_outline_rounded, onTap: onChat, tooltip: chatTooltip)],
        if (onCall != null) ...[const SizedBox(width: 8), CircleActionButton(icon: Icons.phone_outlined, onTap: onCall, tooltip: callTooltip)],
      ],
    );
    if (onTap == null) return row;
    return InkWell(onTap: onTap, borderRadius: BorderRadius.circular(AnbessaRadius.md), child: row);
  }
}
