// Which car to go online with: every car the driver may use, with why one can't be used now.

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';

Future<Vehicle?> showVehiclePicker(BuildContext context, {required List<Vehicle> vehicles, String? selectedId}) => showModalBottomSheet<Vehicle>(
      context: context,
      builder: (ctx) {
        final l = ctx.l10n;
        final c = ctx.colors;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(l.chooseVehicle, style: AnbessaType.h2.copyWith(color: c.text)),
                const SizedBox(height: 12),
                SectionGroup(
                  margin: EdgeInsets.zero,
                  children: [
                    for (final v in vehicles)
                      Opacity(
                        opacity: v.canDrive == false ? 0.6 : 1,
                        child: ChoiceRow(
                          leading: VehicleGlyph(v.vehicleType, size: 40, selected: v.id == selectedId),
                          title: '${v.plateNumber} · ${v.label}',
                          subtitle: v.canDrive == false ? (v.denialMessage != null ? describeError(l, AppError(status: 403, code: v.denial ?? '', message: v.denialMessage!)) : l.notEligible) : (v.isFleet ? l.fleetCar : l.ready),
                          selected: v.id == selectedId,
                          onTap: v.canDrive == false ? () {} : () => Navigator.pop(ctx, v),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
