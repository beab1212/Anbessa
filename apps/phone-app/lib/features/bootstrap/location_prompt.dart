// The kit's "Enable Location" dialog (p. 42): a white card over the blurred map with an amber
// location badge, a title, why we ask, "Grant Permission" and "Maybe Later". Shown once per run,
// just before the system's own location prompt (GeolocatorSource.rationale, set in app.dart).

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';

class EnableLocationDialog extends StatelessWidget {
  const EnableLocationDialog({super.key});
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Dialog(
      backgroundColor: c.page,
      insetPadding: const EdgeInsets.symmetric(horizontal: 36, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.xl)),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Center(child: ResultBadge(icon: Icons.location_on_rounded)),
            const SizedBox(height: 20),
            Semantics(header: true, child: Text(l.accEnableLocation, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text))),
            const SizedBox(height: 12),
            Text(l.accEnableLocationLede, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2, fontWeight: FontWeight.w400)),
            const SizedBox(height: 24),
            PillButton(label: l.accGrantPermission, onPressed: () => Navigator.of(context).pop(true)),
            const SizedBox(height: 12),
            PillButton(label: l.accMaybeLater, variant: PillVariant.tonal, onPressed: () => Navigator.of(context).pop(false)),
          ],
        ),
      ),
    );
  }
}

/// Shows [EnableLocationDialog] over a blurred, dimmed page; true for "Grant Permission".
Future<bool> showEnableLocationDialog(BuildContext context) async {
  final r = await showGeneralDialog<bool>(
    context: context,
    barrierDismissible: true,
    barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
    barrierColor: Colors.transparent,
    transitionDuration: AnbessaMotion.of(context, AnbessaMotion.base),
    pageBuilder: (_, _, _) => const EnableLocationDialog(),
    transitionBuilder: (context, a, _, child) {
      final t = CurvedAnimation(parent: a, curve: AnbessaMotion.emphasizedDecelerate);
      return Stack(
        children: [
          // the page behind, blurred and dimmed (the kit's frosted map)
          Positioned.fill(
            child: IgnorePointer(
              child: AnimatedBuilder(
                animation: t,
                builder: (_, _) => BackdropFilter(
                  filter: ui.ImageFilter.blur(sigmaX: 6 * t.value, sigmaY: 6 * t.value),
                  child: ColoredBox(color: Colors.black.withValues(alpha: 0.32 * t.value)),
                ),
              ),
            ),
          ),
          FadeTransition(opacity: t, child: ScaleTransition(scale: Tween(begin: 0.94, end: 1.0).animate(t), child: child)),
        ],
      );
    },
  );
  return r ?? false;
}
