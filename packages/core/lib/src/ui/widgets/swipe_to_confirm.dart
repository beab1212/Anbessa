// Drag the thumb to the end to confirm: for actions that shouldn't fire on a stray tap (going
// online, accepting an offer, starting or completing a trip). Long-press confirms too, for
// people who can't drag.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'basics.dart';

class SwipeToConfirm extends StatefulWidget {
  const SwipeToConfirm({
    super.key,
    required this.label,
    required this.onConfirmed,
    this.icon = Icons.arrow_forward_rounded,
    this.tone = Tone.amber,
    this.busy = false,
    this.enabled = true,
    this.height = 60,
    this.threshold = 0.85,
    this.semanticsHint,
  });
  final String label;
  final Future<void> Function() onConfirmed;
  final IconData icon;
  final Tone tone;
  final bool busy;
  final bool enabled;
  final double height;
  final double threshold;
  final String? semanticsHint;

  @override
  State<SwipeToConfirm> createState() => _SwipeToConfirmState();
}

class _SwipeToConfirmState extends State<SwipeToConfirm> with SingleTickerProviderStateMixin {
  // created up front: a `late` controller first touched in dispose() would look for a ticker on a dead tree
  late final AnimationController _spring;
  double _x = 0; // 0..1
  bool _firing = false;

  @override
  void initState() {
    super.initState();
    _spring = AnimationController(vsync: this, duration: AnbessaMotion.slow);
  }

  bool get _active => widget.enabled && !widget.busy && !_firing;

  Future<void> _fire() async {
    if (_firing) return;
    setState(() => _firing = true);
    HapticFeedback.heavyImpact();
    try {
      await widget.onConfirmed();
    } finally {
      if (mounted) {
        setState(() {
          _firing = false;
          _x = 0;
        });
      }
    }
  }

  void _release(double width) {
    if (_x >= widget.threshold) {
      setState(() => _x = 1);
      _fire();
    } else {
      final from = _x;
      _spring.reset();
      final anim = CurvedAnimation(parent: _spring, curve: AnbessaMotion.emphasized);
      void tick() => setState(() => _x = from * (1 - anim.value));
      anim.addListener(tick);
      _spring.forward().whenComplete(() => anim.removeListener(tick));
    }
  }

  @override
  void dispose() {
    _spring.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, _) = widget.tone.colorsOf(c);
    final fill = switch (widget.tone) { Tone.amber => c.primaryFill, Tone.green => c.success, Tone.red => c.danger, Tone.blue => c.info, Tone.grey => c.text2 };
    final onFill = widget.tone == Tone.amber ? c.onAccent : Colors.white;
    final h = widget.height;
    final thumb = h - 8;
    return Semantics(
      button: true,
      enabled: _active,
      label: widget.label,
      hint: widget.semanticsHint,
      onTap: _active ? _fire : null,
      child: LayoutBuilder(
        builder: (context, box) {
          final travel = box.maxWidth - thumb - 8;
          return GestureDetector(
            onLongPress: _active ? _fire : null,
            onHorizontalDragUpdate: _active ? (d) => setState(() => _x = (_x + d.delta.dx / travel).clamp(0.0, 1.0)) : null,
            onHorizontalDragEnd: _active ? (_) => _release(box.maxWidth) : null,
            onHorizontalDragCancel: _active ? () => _release(box.maxWidth) : null,
            child: Opacity(
              opacity: widget.enabled ? 1 : 0.5,
              child: Container(
                height: h,
                decoration: BoxDecoration(color: c.isDark ? c.surface2 : c.canvas, borderRadius: BorderRadius.circular(h / 2), border: Border.all(color: c.border)),
                child: Stack(
                  children: [
                    // the filled trail behind the thumb
                    Positioned(
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 4 + thumb + travel * _x,
                      child: DecoratedBox(decoration: BoxDecoration(color: fill.withValues(alpha: 0.18 + 0.5 * _x), borderRadius: BorderRadius.circular(h / 2))),
                    ),
                    Center(
                      child: Opacity(
                        opacity: (1 - _x * 1.6).clamp(0.0, 1.0),
                        child: Padding(
                          padding: EdgeInsets.only(left: thumb / 2),
                          child: Text(widget.label, style: AnbessaType.title.copyWith(color: widget.enabled ? c.text : c.muted)),
                        ),
                      ),
                    ),
                    Positioned(
                      left: 4 + travel * _x,
                      top: 4,
                      child: Container(
                        width: thumb,
                        height: thumb,
                        decoration: BoxDecoration(color: fill, shape: BoxShape.circle, boxShadow: AnbessaElevation.card(c.brightness)),
                        child: widget.busy || _firing
                            ? Padding(padding: const EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 2.5, color: onFill))
                            : Icon(widget.icon, color: onFill, size: 26),
                      ),
                    ),
                    if (_x == 0 && _active)
                      Positioned(right: 18, top: 0, bottom: 0, child: Icon(Icons.chevron_right_rounded, color: fg.withValues(alpha: 0.6))),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
