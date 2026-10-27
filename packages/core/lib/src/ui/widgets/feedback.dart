// Haptics and toasts. Haptics are a thin layer over the platform calls with one hook so the app
// can add stronger patterns (vibration on an offer) or turn them off.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'basics.dart';

enum HapticKind { selection, light, medium, heavy, success, error, offer }

abstract final class Haptics {
  /// The app can replace this (a settings toggle, a vibration pattern for [HapticKind.offer]).
  static void Function(HapticKind kind) sink = platform;

  static void platform(HapticKind kind) {
    switch (kind) {
      case HapticKind.selection:
        HapticFeedback.selectionClick();
      case HapticKind.light:
        HapticFeedback.lightImpact();
      case HapticKind.medium:
        HapticFeedback.mediumImpact();
      case HapticKind.heavy || HapticKind.success || HapticKind.offer:
        HapticFeedback.heavyImpact();
      case HapticKind.error:
        HapticFeedback.vibrate();
    }
  }

  static void selection() => sink(HapticKind.selection);
  static void light() => sink(HapticKind.light);
  static void medium() => sink(HapticKind.medium);
  static void heavy() => sink(HapticKind.heavy);
  static void success() => sink(HapticKind.success);
  static void error() => sink(HapticKind.error);
  static void offer() => sink(HapticKind.offer);
}

/// A short message that slides in from the top and leaves on its own.
void showToast(BuildContext context, String text, {NoticeTone tone = NoticeTone.info, Duration duration = const Duration(milliseconds: 2500), IconData? icon}) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;
  late OverlayEntry entry;
  entry = OverlayEntry(builder: (_) => _Toast(text: text, tone: tone, icon: icon, duration: duration, onDone: () => entry.remove()));
  overlay.insert(entry);
}

class _Toast extends StatefulWidget {
  const _Toast({required this.text, required this.tone, required this.duration, required this.onDone, this.icon});
  final String text;
  final NoticeTone tone;
  final IconData? icon;
  final Duration duration;
  final VoidCallback onDone;
  @override
  State<_Toast> createState() => _ToastState();
}

class _ToastState extends State<_Toast> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: AnbessaMotion.slow);
  Timer? _t;
  @override
  void initState() {
    super.initState();
    _c.forward();
    _t = Timer(widget.duration, () async {
      if (!mounted) return;
      await _c.reverse();
      widget.onDone();
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, _, _) = widget.tone.of(c);
    final top = MediaQuery.paddingOf(context).top + 12;
    return Positioned(
      top: top,
      left: 16,
      right: 16,
      child: SlideTransition(
        position: Tween(begin: const Offset(0, -0.6), end: Offset.zero).animate(CurvedAnimation(parent: _c, curve: AnbessaMotion.emphasized)),
        child: FadeTransition(
          opacity: _c,
          child: Material(
            color: Colors.transparent,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: c.border), boxShadow: AnbessaElevation.floating(c.brightness)),
              child: Row(
                children: [
                  Container(width: 4, height: 24, decoration: BoxDecoration(color: fg, borderRadius: BorderRadius.circular(2))),
                  const SizedBox(width: 12),
                  Expanded(child: Text(widget.text, style: AnbessaType.body2.copyWith(color: c.text, fontWeight: FontWeight.w500))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
