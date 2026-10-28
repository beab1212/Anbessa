// Vehicles: the side-view car art per class, the class card of the choose-ride carousel, and the
// licence plate badge.

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../../domain/domain.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'animated_counter.dart';
import 'eta_badge.dart';
import 'vehicle_glyph.dart';

/// The art file for a vehicle class code: economy, comfort, minivan, or generic for anything else.
String vehicleArtName(String code) => switch (code.toLowerCase()) {
      'economy' || 'eco' || 'standard' || 'basic' || 'hatchback' || 'lite' => 'economy',
      'comfort' || 'premium' || 'business' || 'sedan' || 'executive' => 'comfort',
      'minivan' || 'van' || 'minibus' || 'xl' || 'family' => 'minivan',
      _ => 'generic',
    };

/// A side-view car drawing for a vehicle class (`assets/vehicles/<class>.svg`, generic when the
/// class has no art): flat amber body, white windows, dark tyres (the GoRide look, our drawing).
/// [tint] repaints the body (the lower band follows, a little darker).
class VehicleArt extends StatelessWidget {
  const VehicleArt(this.code, {super.key, this.width = 120, this.height, this.tint});
  final String code;
  final double width;
  /// defaults to the art's 160:64 ratio
  final double? height;
  /// paints the body (the shaded band follows, a little darker)
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final h = height ?? width * 0.4;
    return SvgPicture.asset(
      'assets/vehicles/${vehicleArtName(code)}.svg',
      package: 'ride_app_core',
      width: width,
      height: h,
      excludeFromSemantics: true,
      colorMapper: _VehicleColors(dark: c.isDark, tint: tint),
      placeholderBuilder: (_) => SizedBox(width: width, height: h),
      errorBuilder: (_, _, _) => SizedBox(width: width, height: h, child: Icon(vehicleIcon(code), size: h * 0.8, color: c.text2)),
    );
  }
}

class _VehicleColors extends ColorMapper {
  const _VehicleColors({required this.dark, this.tint});
  final bool dark;
  final Color? tint;

  @override
  Color substitute(String? id, String elementName, String attributeName, Color color) {
    final v = color.toARGB32() & 0xFFFFFF;
    return switch (v) {
      0xFFB300 => tint ?? color, // body
      0xE59E00 => tint != null ? Color.lerp(tint, Colors.black, 0.12)! : color, // lower band, trim
      0xE6E3DC => dark ? const Color(0xFFCAC7C0) : color, // hubs
      _ => color,
    };
  }

  @override
  bool operator ==(Object other) => other is _VehicleColors && other.dark == dark && other.tint == tint;
  @override
  int get hashCode => Object.hash(dark, tint);
}

/// A vehicle class in the choose-ride carousel: car art, name, seats, ETA, the price (the original
/// struck through when a promo lowered it). Selected: an amber ring, a soft lift and a small scale.
class VehicleClassCard extends StatelessWidget {
  const VehicleClassCard({
    super.key,
    required this.code,
    required this.name,
    required this.fareMinor,
    this.payableMinor,
    this.seats,
    this.etaSeconds,
    this.minuteLabel,
    this.selected = false,
    this.onTap,
    this.locale = 'en',
    this.width = 132,
    this.badge,
  });
  /// the vehicle class code (picks the art)
  final String code;
  final String name;
  /// the fare before any promo
  final int fareMinor;
  /// what the person pays; struck-through [fareMinor] shows above it when lower
  final int? payableMinor;
  final int? seats;
  final int? etaSeconds;
  /// e.g. (m) => "$m min"; no ETA badge without it
  final String Function(int minutes)? minuteLabel;
  final bool selected;
  final VoidCallback? onTap;
  final String locale;
  final double width;
  /// a short label in the corner ("Promo", "Fastest")
  final String? badge;

  bool get discounted => payableMinor != null && payableMinor! < fareMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = AnbessaMotion.of(context, AnbessaMotion.short);
    final pay = payableMinor ?? fareMinor;
    final radius = BorderRadius.circular(AnbessaRadius.lg);
    return Semantics(
      button: true,
      selected: selected,
      label: '$name, ${birr(pay, locale: locale)}',
      excludeSemantics: true,
      child: AnimatedScale(
        scale: selected ? 1.03 : 1,
        duration: d,
        curve: AnbessaMotion.spring,
        child: AnimatedContainer(
          duration: d,
          curve: AnbessaMotion.emphasized,
          width: width,
          decoration: BoxDecoration(
            color: selected ? c.surface : c.surface2,
            borderRadius: radius,
            border: Border.all(color: selected ? c.accent : c.border, width: 2),
            boxShadow: selected ? AnbessaElevation.raised(c.brightness) : const [],
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: onTap,
              borderRadius: radius,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Center(child: VehicleArt(code, width: width - 28)),
                        if (badge != null)
                          Positioned(
                            top: 0,
                            right: 0,
                            child: Container(
                              constraints: BoxConstraints(maxWidth: width * 0.6),
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(AnbessaRadius.pill)),
                              child: Text(badge!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.label.copyWith(fontSize: 10.5, color: c.onAmber)),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w700, color: c.text)),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        if (seats != null) ...[
                          Icon(Icons.person_rounded, size: 14, color: c.muted),
                          const SizedBox(width: 2),
                          Text('$seats', style: AnbessaType.label.copyWith(color: c.muted)),
                          const SizedBox(width: 6),
                        ],
                        if (minuteLabel != null)
                          Flexible(child: FittedBox(fit: BoxFit.scaleDown, alignment: AlignmentDirectional.centerStart, child: EtaBadge(seconds: etaSeconds, minuteLabel: minuteLabel!))),
                      ],
                    ),
                    const SizedBox(height: 6),
                    if (discounted)
                      Text(birr(fareMinor, locale: locale), maxLines: 1, style: AnbessaType.caption.copyWith(color: c.muted, decoration: TextDecoration.lineThrough, decorationColor: c.muted, fontFeatures: AnbessaType.tabular)),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: AlignmentDirectional.centerStart,
                      child: AnimatedMoney(pay, locale: locale, style: AnbessaType.title.copyWith(fontWeight: FontWeight.w800, color: discounted ? c.success : c.text)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A licence plate: bordered, monospace, bold. An optional [code] (the region/class number) sits
/// in a small segment on the left.
class PlateBadge extends StatelessWidget {
  const PlateBadge(this.plate, {super.key, this.code, this.large = false});
  final String plate;
  final String? code;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final style = (large ? AnbessaType.title : AnbessaType.body2).copyWith(
      color: c.text,
      fontWeight: FontWeight.w800,
      letterSpacing: 1.2,
      fontFamilyFallback: monoFamilyFallback,
      fontFeatures: AnbessaType.tabular,
    );
    return Semantics(
      label: code == null ? plate : '$code $plate',
      excludeSemantics: true,
      child: Container(
        decoration: BoxDecoration(color: c.isDark ? c.surface2 : Colors.white, borderRadius: BorderRadius.circular(6), border: Border.all(color: c.text, width: 1.5)),
        child: IntrinsicHeight(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (code != null) ...[
                Padding(padding: EdgeInsets.symmetric(horizontal: large ? 8 : 6), child: Center(child: Text(code!, style: style))),
                VerticalDivider(width: 1.5, thickness: 1.5, color: c.text),
              ],
              Flexible(
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: large ? 10 : 8, vertical: large ? 4 : 2),
                  child: Text(plate.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis, style: style),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
