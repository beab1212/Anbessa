// Why the rider (or the driver) is cancelling, and what it costs.
//
// A full-width sheet on the root navigator (over the map shell, its sheet and any tab bar) that
// sizes itself to its content up to the screen: the reasons scroll when they don't fit (small
// phones, large text) while the title and the two buttons always stay on screen. Before, the
// sheet used Material's default 9/16-of-the-screen cap and its column overflowed below it, so
// "Cancel trip" was pushed off the bottom of the screen and could not be pressed.

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';

Future<CancelReason?> showCancelSheet(BuildContext context, {required bool free, required int feeMinor, bool driverSide = false}) => showModalBottomSheet<CancelReason>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: false,
      builder: (ctx) => CancelSheet(free: free, feeMinor: feeMinor, driverSide: driverSide),
    );

class CancelSheet extends StatefulWidget {
  const CancelSheet({super.key, required this.free, required this.feeMinor, this.driverSide = false});
  final bool free;
  final int feeMinor;
  final bool driverSide;
  @override
  State<CancelSheet> createState() => _CancelSheetState();
}

class _CancelSheetState extends State<CancelSheet> {
  CancelReason? _picked;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final reasons = widget.driverSide
        ? [CancelReason.noShow, CancelReason.wrongPickup, CancelReason.safety, CancelReason.other]
        : [CancelReason.changedPlans, CancelReason.driverTooFar, CancelReason.driverAskedToCancel, CancelReason.wrongPickup, CancelReason.other];
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 0, AnbessaSpace.page, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SheetHandle(),
            Semantics(header: true, child: Text(l.cancelReasonTitle, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text))),
            const SizedBox(height: 10),
            Center(
              child: StatusPill(
                widget.free ? l.cancelNoFee : l.cancelFeeWarning(birr(widget.feeMinor, locale: context.localeTag)),
                tone: widget.free ? Tone.green : Tone.amber,
                icon: widget.free ? Icons.check : Icons.info_outline,
              ),
            ),
            const SizedBox(height: 14),
            // the reasons scroll when the screen is short; the buttons stay put
            Flexible(
              child: SingleChildScrollView(
                child: SectionGroup(
                  margin: EdgeInsets.zero,
                  children: [
                    for (final r in reasons) ChoiceRow(key: ValueKey('cancel-reason-${r.name}'), title: cancelReasonLabel(l, r), selected: _picked == r, onTap: () => setState(() => _picked = r)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            PillButton(key: const ValueKey('cancel-confirm'), label: l.cancelTrip, variant: PillVariant.danger, onPressed: _picked == null ? null : () => Navigator.of(context).pop(_picked)),
            const SizedBox(height: 8),
            PillButton(key: const ValueKey('cancel-keep'), label: l.keepTrip, variant: PillVariant.tonal, onPressed: () => Navigator.of(context).pop()),
          ],
        ),
      ),
    );
  }
}
