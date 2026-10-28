// Dialogs and sheets from the GoRide kit:
//   SuccessDialog: a centred white card, a big amber check circle, title, message, OK.
//   ResultSheet: a sheet whose big circle (check, ✕, pin, person) overlaps its top edge
//     ("Promo Code Applied!", "Whoops!", "You have arrived!", "We've found the driver!").
//   HandleSheet: the modal sheet frame: a small grey handle, an optional centred title over a
//     hairline, the body.
//   ConfirmSheet: a HandleSheet with a (red when destructive) title, a question, optional
//     content, and Cancel | Yes buttons.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'feedback.dart';
import 'pill_button.dart';

/// The big round badge of a dialog or result sheet.
class ResultBadge extends StatelessWidget {
  const ResultBadge({super.key, this.icon = Icons.check_rounded, this.danger = false, this.size = 72, this.ring = false});
  final IconData icon;
  /// red with a white glyph ("Whoops!", "You have arrived!")
  final bool danger;
  final double size;
  /// a page-coloured ring around it (when it overlaps a sheet edge)
  final bool ring;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fill = danger ? c.danger : c.primaryFill;
    final fg = danger ? Colors.white : c.onAccent;
    return ExcludeSemantics(
      child: Container(
        width: size + (ring ? 12 : 0),
        height: size + (ring ? 12 : 0),
        decoration: BoxDecoration(shape: BoxShape.circle, color: ring ? c.page : null),
        alignment: Alignment.center,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(shape: BoxShape.circle, color: fill),
          child: Icon(icon, size: size * 0.5, color: fg),
        ),
      ),
    );
  }
}

class SuccessDialog extends StatelessWidget {
  const SuccessDialog({super.key, required this.title, this.message, required this.okLabel, this.onOk, this.icon = Icons.check_rounded, this.danger = false, this.secondaryLabel, this.onSecondary});
  final String title;
  final String? message;
  final String okLabel;
  /// defaults to closing the dialog with true
  final VoidCallback? onOk;
  final IconData icon;
  final bool danger;
  /// a tonal button before OK ("Use Later")
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ok = PillButton(label: okLabel, onPressed: onOk ?? () => Navigator.of(context).pop(true));
    return Dialog(
      backgroundColor: c.page,
      insetPadding: const EdgeInsets.symmetric(horizontal: 40, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.xl)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(child: ResultBadge(icon: icon, danger: danger)),
            const SizedBox(height: 20),
            Semantics(header: true, child: Text(title, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text))),
            if (message != null) ...[const SizedBox(height: 10), Text(message!, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2, fontWeight: FontWeight.w400))],
            const SizedBox(height: 24),
            if (secondaryLabel == null) ok else PillButtonPair(first: PillButton(label: secondaryLabel!, variant: PillVariant.tonal, onPressed: onSecondary ?? () => Navigator.of(context).pop(false)), second: ok),
          ],
        ),
      ),
    );
  }
}

/// Shows a [SuccessDialog]; true when OK was pressed.
Future<bool> showSuccessDialog(BuildContext context, {required String title, String? message, required String okLabel, IconData icon = Icons.check_rounded, bool danger = false, bool barrierDismissible = false}) async {
  danger ? Haptics.error() : Haptics.success();
  final r = await showDialog<bool>(
    context: context,
    barrierDismissible: barrierDismissible,
    builder: (_) => SuccessDialog(title: title, message: message, okLabel: okLabel, icon: icon, danger: danger),
  );
  return r ?? false;
}

/// A sheet whose round badge overlaps its top edge, a title, an optional message, any content and
/// the actions at the bottom.
class ResultSheet extends StatelessWidget {
  const ResultSheet({super.key, required this.title, this.message, this.icon = Icons.check_rounded, this.danger = false, this.badge, this.child, this.actions});
  final String title;
  final String? message;
  final IconData icon;
  final bool danger;
  /// instead of the [ResultBadge] (an avatar)
  final Widget? badge;
  final Widget? child;
  /// usually a PillButton or a PillButtonPair
  final Widget? actions;

  static const _badge = 72.0;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Stack(
      clipBehavior: Clip.none,
      alignment: Alignment.topCenter,
      children: [
        Container(
          margin: const EdgeInsets.only(top: _badge / 2),
          decoration: BoxDecoration(
            color: c.page,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(AnbessaRadius.sheet)),
            boxShadow: AnbessaElevation.sheet(c.brightness),
          ),
          padding: EdgeInsets.fromLTRB(AnbessaSpace.page, _badge / 2 + 20, AnbessaSpace.page, 16 + bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(header: true, child: Text(title, textAlign: TextAlign.center, style: AnbessaType.h1.copyWith(color: c.text))),
              if (message != null) ...[const SizedBox(height: 10), Text(message!, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2, fontWeight: FontWeight.w400))],
              if (child != null) ...[const SizedBox(height: 16), child!],
              if (actions != null) ...[const SizedBox(height: 24), actions!],
            ],
          ),
        ),
        Positioned(top: 0, child: badge ?? ResultBadge(icon: icon, danger: danger, size: _badge)),
      ],
    );
  }
}

/// Shows [builder]'s [ResultSheet] as a modal bottom sheet without the theme's own frame.
Future<T?> showResultSheet<T>(BuildContext context, {required WidgetBuilder builder, bool isDismissible = true}) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      isDismissible: isDismissible,
      backgroundColor: Colors.transparent,
      elevation: 0,
      showDragHandle: false,
      builder: builder,
    );

/// The small grey grabber at the top of a sheet.
class SheetHandle extends StatelessWidget {
  const SheetHandle({super.key});
  @override
  Widget build(BuildContext context) => Center(
        child: Container(
          margin: const EdgeInsets.only(top: 10, bottom: 10),
          width: 36,
          height: 4,
          decoration: BoxDecoration(color: context.colors.borderStrong, borderRadius: BorderRadius.circular(2)),
        ),
      );
}

/// The frame of a modal sheet: handle, an optional centred title over a hairline, the body.
class HandleSheet extends StatelessWidget {
  const HandleSheet({super.key, this.title, this.titleColor, required this.child, this.padding = const EdgeInsets.fromLTRB(AnbessaSpace.page, 0, AnbessaSpace.page, 16)});
  final String? title;
  final Color? titleColor;
  final Widget child;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SafeArea(
      top: false,
      child: Padding(
        padding: padding.copyWith(bottom: padding.bottom + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SheetHandle(),
            if (title != null) ...[
              const SizedBox(height: 6),
              Semantics(header: true, child: Text(title!, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: titleColor ?? c.text))),
              const SizedBox(height: 16),
              Divider(color: c.border),
              const SizedBox(height: 16),
            ],
            Flexible(child: child),
          ],
        ),
      ),
    );
  }
}

/// Shows [builder]'s content in a [HandleSheet] (the sheet draws its own handle).
Future<T?> showHandleSheet<T>(BuildContext context, {String? title, required WidgetBuilder builder, bool isScrollControlled = true}) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: isScrollControlled,
      showDragHandle: false,
      builder: (ctx) => HandleSheet(title: title, child: builder(ctx)),
    );

/// "Delete Address / Sure you want to delete this address? / [the address] / Cancel | Yes, Delete".
class ConfirmSheet extends StatelessWidget {
  const ConfirmSheet({super.key, required this.title, this.message, this.child, required this.confirmLabel, required this.cancelLabel, this.destructive = false});
  final String title;
  final String? message;
  final Widget? child;
  final String confirmLabel;
  final String cancelLabel;
  /// a red title
  final bool destructive;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return HandleSheet(
      title: title,
      titleColor: destructive ? c.danger : null,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (message != null) Text(message!, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text)),
          if (child != null) ...[const SizedBox(height: 16), child!],
          const SizedBox(height: 24),
          PillButtonPair(
            first: PillButton(label: cancelLabel, variant: PillVariant.tonal, onPressed: () => Navigator.of(context).pop(false)),
            second: PillButton(label: confirmLabel, onPressed: () => Navigator.of(context).pop(true)),
          ),
        ],
      ),
    );
  }
}

/// Shows a [ConfirmSheet]; true when confirmed.
Future<bool> showConfirmSheet(BuildContext context, {required String title, String? message, Widget? child, required String confirmLabel, required String cancelLabel, bool destructive = false}) async {
  final r = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: false,
    builder: (_) => ConfirmSheet(title: title, message: message, confirmLabel: confirmLabel, cancelLabel: cancelLabel, destructive: destructive, child: child),
  );
  return r ?? false;
}
