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
      appBar: AppBar(title: Text(l.vehicles), actions: [IconButton(tooltip: l.addVehicle, icon: const Icon(Icons.add), onPressed: () => context.push(Routes.driverVehicleNew))]),
      body: RefreshIndicator(
        onRefresh: () => ref.read(driverHomeProvider.notifier).refresh(),
        child: home.isLoading && home.value == null
            ? const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 2))
            : all.isEmpty
                ? ListView(children: [const SizedBox(height: 40), IllustratedEmpty(illustration: AnbessaIllustration.carWaiting, title: l.noVehicles, action: PrimaryButton(label: l.addVehicle, icon: Icons.add, onPressed: () => context.push(Routes.driverVehicleNew)))])
                : ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      SectionGroup(
                        children: [
                          for (final v in all)
                            SettingsTile(
                              icon: vehicleIcon(v.vehicleType),
                              title: '${v.plateNumber} · ${v.label}',
                              subtitle: v.isFleet ? l.fleetCar : null,
                              trailing: StatusPill(vehicleStatusLabel(l, v.status), tone: vehicleTone(v.status)),
                              onTap: v.isFleet ? null : () => context.push(Routes.driverVehicle(v.id)),
                            ),
                        ],
                      ),
                      Text(l.vehicleDocuments, style: AnbessaType.caption.copyWith(color: c.muted)),
                    ],
                  ),
      ),
    );
  }
}
