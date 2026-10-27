// The next turn, big, at the top of the driver's map; and the full list of turns in a sheet.

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import 'maneuver_icons.dart';
import 'navigation_controller.dart';

class TurnBanner extends StatelessWidget {
  const TurnBanner({super.key, required this.nav, this.onTap, this.targetLabel});
  final NavState nav;
  final VoidCallback? onTap;
  /// shown while the route loads or has no turns ("Pickup", "Drop-off")
  final String? targetLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = context.l10n;
    final step = nav.nextStep;
    final String title;
    final String? sub;
    final IconData icon;
    if (nav.loading) {
      title = l.navLoading;
      sub = targetLabel;
      icon = Icons.route;
    } else if (nav.rerouting) {
      title = l.navRerouting;
      sub = targetLabel;
      icon = Icons.alt_route;
    } else if (nav.error != null) {
      title = l.navNoRoute;
      sub = targetLabel;
      icon = Icons.error_outline;
    } else if (step == null) {
      title = targetLabel ?? l.navArrive;
      sub = nav.remainingMeters == null ? null : km(nav.remainingMeters!);
      icon = Icons.flag_rounded;
    } else {
      title = maneuverLabel(l, maneuverKey(step), step.name);
      sub = nav.metersToManeuver == null ? null : l.navIn(km(nav.metersToManeuver!));
      icon = maneuverIcon(step);
    }
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AnbessaRadius.lg),
        child: AnimatedContainer(
          duration: AnbessaMotion.of(context, AnbessaMotion.base),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: nav.offRoute && !nav.rerouting ? c.warningSoft : c.surface,
            borderRadius: BorderRadius.circular(AnbessaRadius.lg),
            boxShadow: AnbessaElevation.floating(c.brightness),
          ),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(AnbessaRadius.md)),
                child: nav.rerouting
                    ? const Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 2.5))
                    : Icon(icon, size: 30, color: c.accentStrong),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (sub != null) Text(sub, style: AnbessaType.label.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)),
                    Text(title, style: AnbessaType.title.copyWith(color: c.text), maxLines: 2, overflow: TextOverflow.ellipsis),
                  ],
                ),
              ),
              if (nav.thenStep != null && nav.thenStep!.type != 'arrive') ...[
                const SizedBox(width: 8),
                Column(
                  children: [
                    Text(l.navThen, style: AnbessaType.caption.copyWith(color: c.muted)),
                    Icon(maneuverIcon(nav.thenStep!), size: 22, color: c.text2),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The whole list of turns.
class TurnListSheet extends StatelessWidget {
  const TurnListSheet({super.key, required this.nav, required this.targetLabel});
  final NavState nav;
  final String targetLabel;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = context.l10n;
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
            child: Row(
              children: [
                Expanded(child: Text(targetLabel, style: AnbessaType.h2)),
                if (nav.remainingMeters != null) Text('${km(nav.remainingMeters!)} · ${minutesOf(nav.remainingSeconds ?? 0)}', style: AnbessaType.body2.copyWith(color: c.muted)),
              ],
            ),
          ),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
              itemCount: nav.steps.length,
              separatorBuilder: (_, _) => const SizedBox(height: 2),
              itemBuilder: (_, i) {
                final s = nav.steps[i];
                final current = s == nav.nextStep;
                return ListTile(
                  dense: true,
                  selected: current,
                  selectedTileColor: c.accentSoft,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.md)),
                  leading: Icon(maneuverIcon(s), color: current ? c.accentStrong : c.text2),
                  title: Text(maneuverLabel(l, maneuverKey(s), s.name), maxLines: 1, overflow: TextOverflow.ellipsis),
                  trailing: s.distanceMeters > 0 ? Text(km(s.distanceMeters), style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)) : null,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
