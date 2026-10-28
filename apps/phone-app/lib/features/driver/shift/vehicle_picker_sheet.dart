// Which car to go online with: every car the driver may use, with why one can't be used now
// (the kit's handle sheet with selectable cards).

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';

Future<Vehicle?> showVehiclePicker(BuildContext context, {required List<Vehicle> vehicles, String? selectedId}) => showHandleSheet<Vehicle>(
      context,
      title: context.l10n.chooseVehicle,
      builder: (ctx) {
        final l = ctx.l10n;
        final c = ctx.colors;
        return ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.6),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final v in vehicles)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Opacity(
                      opacity: v.canDrive == false ? 0.6 : 1,
                      child: SelectableCard(
                        selected: v.id == selectedId,
                        onTap: v.canDrive == false ? () {} : () => Navigator.pop(ctx, v),
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        child: Row(
                          children: [
                            ExcludeSemantics(child: VehicleArt(v.vehicleType, width: 56)),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text('${v.plateNumber} · ${v.label}', maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text)),
                                  const SizedBox(height: 4),
                                  Text(
                                    v.canDrive == false ? (v.denialMessage != null ? describeError(l, AppError(status: 403, code: v.denial ?? '', message: v.denialMessage!)) : l.notEligible) : (v.isFleet ? l.fleetCar : l.ready),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: AnbessaType.caption.copyWith(color: v.canDrive == false ? c.danger : c.muted),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
