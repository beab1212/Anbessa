// The driver's cars (own and fleet), each with its status and documents.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/routes.dart';
import '../shift/shift_controller.dart';

Tone vehicleTone(VehicleStatus s) => switch (s) { VehicleStatus.verified => Tone.green, VehicleStatus.pendingReview => Tone.amber, VehicleStatus.rejected || VehicleStatus.suspended => Tone.red, _ => Tone.grey };

class VehiclesScreen extends ConsumerWidget {
  const VehiclesScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final home = ref.watch(driverHomeProvider);
    final all = home.value?.allVehicles ?? const <Vehicle>[];
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.vehicles, actions: [IconButton(tooltip: l.addVehicle, icon: Icon(Icons.add_rounded, color: c.text), onPressed: () => context.push(Routes.driverVehicleNew)), const SizedBox(width: 8)]),
      body: RefreshIndicator(
        onRefresh: () => ref.read(driverHomeProvider.notifier).refresh(),
        child: home.isLoading && home.value == null
            ? const Padding(padding: EdgeInsets.all(AnbessaSpace.page), child: SkeletonList(rows: 2))
            : all.isEmpty
                ? ListView(children: [const SizedBox(height: 40), IllustratedEmpty(illustration: AnbessaIllustration.carWaiting, title: l.noVehicles, action: PillButton(label: l.addVehicle, icon: Icons.add_rounded, expand: false, onPressed: () => context.push(Routes.driverVehicleNew)))])
                : ListView(
                    padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
                    children: [
                      // one card per car: the side art, plate and model, status (the kit's ride class tile)
                      for (final v in all)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: AppCard(
                            onTap: v.isFleet ? null : () => context.push(Routes.driverVehicle(v.id)),
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                            child: Row(
                              children: [
                                ExcludeSemantics(child: VehicleArt(v.vehicleType, width: 64)),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text('${v.plateNumber} · ${v.label}', maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text)),
                                      const SizedBox(height: 6),
                                      Wrap(spacing: 6, runSpacing: 4, children: [StatusPill(vehicleStatusLabel(l, v.status), tone: vehicleTone(v.status)), if (v.isFleet) OutlineBadge(l.fleetCar)]),
                                    ],
                                  ),
                                ),
                                if (!v.isFleet) ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, color: c.text)),
                              ],
                            ),
                          ),
                        ),
                      const SizedBox(height: 4),
                      Text(l.vehicleDocuments, style: AnbessaType.caption.copyWith(color: c.muted)),
                    ],
                  ),
      ),
    );
  }
}
