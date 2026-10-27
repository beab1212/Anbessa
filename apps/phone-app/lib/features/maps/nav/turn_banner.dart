// The next turn, big, at the top of the driver's map: the maneuver icon on amber, the distance
// to it, the street, and a "then" chip for the turn right after. A new step slides in over the
// old one (shared axis); off the route, driving the wrong way and rerouting have their own look.
// Tapping it opens the full list of turns with the time, distance and arrival clock.

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import 'maneuver_icons.dart';
import 'nav_format.dart';
import 'navigation_controller.dart';

class TurnBanner extends StatelessWidget {
  const TurnBanner({super.key, required this.nav, this.onTap, this.targetLabel});
  final NavState nav;
  final VoidCallback? onTap;
  /// shown while the route loads, or when there are no turns left ("Pickup", "Drop-off")
  final String? targetLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = context.l10n;
    final step = nav.nextStep;
    final then = nav.thenStep;
    final problem = nav.offRoute || nav.wrongWay;
    // what the big line says, and what identifies it for the transition
    final Object key;
    final Widget lead;
    final String headline;
    final String? sub;
    if (nav.rerouting) {
      key = 'rerouting';
      lead = SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3, color: c.onAmber));
      headline = l.navRerouting;
      sub = targetLabel;
    } else if (nav.loading) {
      key = 'loading';
      lead = Icon(Icons.route_rounded, size: 34, color: c.onAmber);
      headline = l.navLoading;
      sub = targetLabel;
    } else if (nav.error != null && !nav.hasRoute) {
      key = 'error';
      lead = Icon(Icons.wrong_location_outlined, size: 34, color: c.onAmber);
      headline = l.navNoRoute;
      sub = targetLabel;
    } else if (problem) {
      key = nav.wrongWay ? 'wrong' : 'off';
      lead = Icon(nav.wrongWay ? Icons.u_turn_left_rounded : Icons.alt_route_rounded, size: 34, color: c.onAmber);
      headline = nav.wrongWay ? l.navWrongWay : l.navOffRoute;
      sub = targetLabel;
    } else if (nav.arrived || step == null) {
      key = 'arrive';
      lead = Icon(Icons.flag_rounded, size: 34, color: c.onAmber);
      headline = nav.arrived ? l.navArrive : (nav.remainingMeters == null ? l.navArrive : navDistance(l, nav.remainingMeters!));
      sub = targetLabel;
    } else {
      key = 'step:${_stepKey(step)}';
      lead = ManeuverGlyph(step: step, size: 38, color: c.onAmber);
      headline = navDistance(l, nav.metersToManeuver ?? 0);
      sub = navInstruction(l, step);
    }
    final showThen = !problem && !nav.rerouting && !nav.loading && !nav.arrived && step != null && then != null && then.type != 'arrive' && (nav.thenGapMeters ?? 0) < 400;

    return Semantics(
      container: true,
      liveRegion: true,
      button: onTap != null,
      label: [headline, ?sub].join(', '),
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AnbessaRadius.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              AnimatedContainer(
                duration: AnbessaMotion.of(context, AnbessaMotion.base),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: problem || nav.rerouting ? c.warningSoft : c.surface,
                  borderRadius: BorderRadius.circular(AnbessaRadius.lg),
                  boxShadow: AnbessaElevation.floating(c.brightness),
                ),
                child: SharedAxisSwitcher(
                  axis: Axis.vertical,
                  distance: 16,
                  duration: AnbessaMotion.slow,
                  alignment: Alignment.centerLeft,
                  child: Row(
                    key: ValueKey(key),
                    children: [
                      Container(
                        width: 60,
                        height: 60,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(color: problem || nav.rerouting ? c.warning : c.accent, borderRadius: BorderRadius.circular(AnbessaRadius.md)),
                        child: lead,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(headline, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.display.copyWith(fontSize: 26, color: c.text, fontFeatures: AnbessaType.tabular)),
                            if (sub != null) Text(sub, maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text2, height: 1.25)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              AnimatedSize(
                duration: AnbessaMotion.of(context, AnbessaMotion.base),
                curve: AnbessaMotion.emphasized,
                alignment: Alignment.topLeft,
                child: !showThen
                    ? const SizedBox(width: double.infinity)
                    : Padding(
                        padding: const EdgeInsets.only(top: 6, left: 8),
                        child: Container(
                          padding: const EdgeInsets.fromLTRB(10, 6, 12, 6),
                          decoration: BoxDecoration(color: c.text, borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.floating(c.brightness)),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(l.navThen, style: AnbessaType.label.copyWith(color: c.surface)),
                              const SizedBox(width: 6),
                              ManeuverGlyph(step: then, size: 20, color: c.surface),
                            ],
                          ),
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A step's identity for the banner's transition: the same turn after a reroute doesn't slide.
String _stepKey(RouteStep s) => '${s.type}|${s.modifier}|${s.exit}|${s.lat.toStringAsFixed(4)}|${s.lng.toStringAsFixed(4)}';

/// "Arrive 14:32" for [secondsLeft] from [now].
String arriveClock(AppLocalizations l, int secondsLeft, {DateTime? now}) {
  final at = (now ?? DateTime.now()).add(Duration(seconds: secondsLeft));
  return l.navArriveAt(DateFormat.Hm(l.localeName).format(at));
}

/// Time left, distance left and the arrival clock, side by side.
class NavSummaryBar extends StatelessWidget {
  const NavSummaryBar({super.key, required this.nav});
  final NavState nav;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = context.l10n;
    final secs = nav.remainingSeconds;
    final meters = nav.remainingMeters;
    Widget cell(String value, String label, {bool strong = false}) => Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.h2.copyWith(color: strong ? c.success : c.text, fontFeatures: AnbessaType.tabular)),
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted)),
            ],
          ),
        );
    return Row(
      children: [
        cell(minutesOf(secs), l.navRemainingTime, strong: true),
        cell(meters == null ? '—' : navDistance(l, meters), l.navRemainingDistance),
        if (secs != null)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(AnbessaRadius.pill)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.schedule_rounded, size: 16, color: c.accentStrong),
                const SizedBox(width: 6),
                Text(arriveClock(l, secs), style: AnbessaType.label.copyWith(color: c.text, fontFeatures: AnbessaType.tabular)),
              ],
            ),
          ),
      ],
    );
  }
}

/// The whole list of turns, with the time, distance and arrival clock at the bottom.
class TurnListSheet extends StatelessWidget {
  const TurnListSheet({super.key, required this.nav, required this.targetLabel});
  final NavState nav;
  final String targetLabel;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = context.l10n;
    final current = nav.stepIndex;
    final steps = [for (var i = 0; i < nav.steps.length; i++) if (current == null || i >= current) i];
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
            child: Text(targetLabel, maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.h2.copyWith(color: c.text)),
          ),
          Flexible(
            child: ListView.builder(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              itemCount: steps.length,
              itemBuilder: (_, k) {
                final i = steps[k];
                final s = nav.steps[i];
                final isNext = i == current;
                final away = nav.progressMeters == null || i >= nav.stepAlong.length ? null : (nav.stepAlong[i] - nav.progressMeters!).round();
                return ListTile(
                  key: ValueKey(i),
                  dense: true,
                  selected: isNext,
                  selectedTileColor: c.accentSoft,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.md)),
                  leading: ManeuverGlyph(step: s, size: 26, color: isNext ? c.accentStrong : c.text2),
                  title: Text(navInstruction(l, s), maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.text, fontWeight: isNext ? FontWeight.w700 : FontWeight.w500)),
                  trailing: away != null && away > 0 ? Text(navDistance(l, away), style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)) : null,
                );
              },
            ),
          ),
          Container(
            margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.lg)),
            child: NavSummaryBar(nav: nav),
          ),
        ],
      ),
    );
  }
}
