// Why the rider is cancelling, and what it costs.

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';

Future<CancelReason?> showCancelSheet(BuildContext context, {required bool free, required int feeMinor, bool driverSide = false}) => showModalBottomSheet<CancelReason>(
      context: context,
      builder: (ctx) => _CancelSheet(free: free, feeMinor: feeMinor, driverSide: driverSide),
    );

class _CancelSheet extends StatefulWidget {
  const _CancelSheet({required this.free, required this.feeMinor, required this.driverSide});
  final bool free;
  final int feeMinor;
  final bool driverSide;
  @override
  State<_CancelSheet> createState() => _CancelSheetState();
}

class _CancelSheetState extends State<_CancelSheet> {
  CancelReason? _picked;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final reasons = widget.driverSide
        ? [CancelReason.noShow, CancelReason.wrongPickup, CancelReason.safety, CancelReason.other]
        : [CancelReason.changedPlans, CancelReason.driverTooFar, CancelReason.driverAskedToCancel, CancelReason.wrongPickup, CancelReason.other];
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l.cancelReasonTitle, style: AnbessaType.h2.copyWith(color: c.text)),
            const SizedBox(height: 6),
            Row(
              children: [
                StatusPill(widget.free ? l.cancelNoFee : l.cancelFeeWarning(birr(widget.feeMinor, locale: context.localeTag)), tone: widget.free ? Tone.green : Tone.amber, icon: widget.free ? Icons.check : Icons.info_outline),
              ],
            ),
            const SizedBox(height: 12),
            SectionGroup(
              margin: EdgeInsets.zero,
              children: [for (final r in reasons) ChoiceRow(title: cancelReasonLabel(l, r), selected: _picked == r, onTap: () => setState(() => _picked = r))],
            ),
            const SizedBox(height: 14),
            PrimaryButton(label: l.cancelTrip, danger: true, onPressed: _picked == null ? null : () => Navigator.of(context).pop(_picked)),
            const SizedBox(height: 4),
            TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(l.keepTrip)),
          ],
        ),
      ),
    );
  }
}
