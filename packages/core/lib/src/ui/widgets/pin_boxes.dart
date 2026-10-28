// Code entry as boxes: the 6-digit sign-in code and the 4-digit trip PIN, plus a read-only
// display of the PIN for the rider.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pinput/pinput.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

class PinBoxes extends StatelessWidget {
  const PinBoxes({
    super.key,
    required this.length,
    required this.onCompleted,
    this.controller,
    this.focusNode,
    this.autofocus = true,
    this.error = false,
    this.enabled = true,
    this.smsRetriever,
    this.size = 56,
  });
  final int length;
  final ValueChanged<String> onCompleted;
  final TextEditingController? controller;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool error;
  final bool enabled;
  final SmsRetriever? smsRetriever;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final base = PinTheme(
      width: size,
      height: size * 1.15,
      textStyle: TextStyle(fontSize: size * 0.45, fontWeight: FontWeight.w700, color: c.text, fontFeatures: AnbessaType.tabular),
      // the kit's OTP boxes: filled grey, no border; the focused one tinted with an amber border
      decoration: BoxDecoration(color: c.field, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: Colors.transparent, width: 1.5)),
    );
    return Pinput(
      length: length,
      controller: controller,
      focusNode: focusNode,
      autofocus: autofocus,
      enabled: enabled,
      forceErrorState: error,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      // SMS autofill: iOS reads the code from the keyboard suggestion (autofillHints); on Android
      // pinput 7 wants an SmsRetriever implementation, which the app can pass through [smsRetriever].
      smsRetriever: smsRetriever,
      hapticFeedbackType: HapticFeedbackType.lightImpact,
      separatorBuilder: (_) => const SizedBox(width: 8),
      defaultPinTheme: base,
      focusedPinTheme: base.copyWith(decoration: base.decoration!.copyWith(color: Color.alphaBlend(c.selectedFill, c.page), border: Border.all(color: c.accent, width: 1.5))),
      submittedPinTheme: base,
      errorPinTheme: base.copyWith(decoration: base.decoration!.copyWith(color: c.dangerSoft, border: Border.all(color: c.danger, width: 1.5))),
      onCompleted: onCompleted,
    );
  }
}

/// The rider's PIN, big enough to read to the driver.
class PinDisplay extends StatelessWidget {
  const PinDisplay(this.pin, {super.key, this.size = 52});
  final String pin;
  final double size;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      label: pin.split('').join(' '),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, ch) in pin.split('').indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Container(
              width: size,
              height: size * 1.15,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: c.accent)),
              child: Text(ch, style: TextStyle(fontSize: size * 0.5, fontWeight: FontWeight.w800, color: c.text, fontFeatures: AnbessaType.tabular)),
            ),
          ],
        ],
      ),
    );
  }
}
