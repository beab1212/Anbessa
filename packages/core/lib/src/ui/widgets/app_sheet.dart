// The bottom sheet every map screen uses: drag between snap points, a handle, an optional fixed
// header, and a callback with its height so the map can keep its subject above it.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

class AppSheetController {
  DraggableScrollableController? _c;
  List<double> _snaps = const [];
  void _attach(DraggableScrollableController c, List<double> snaps) {
    _c = c;
    _snaps = snaps;
  }

  /// 0 = the lowest snap.
  Future<void> animateTo(int snapIndex, {Duration? duration}) async {
    final c = _c;
    if (c == null || !c.isAttached || _snaps.isEmpty) return;
    final i = snapIndex.clamp(0, _snaps.length - 1);
    await c.animateTo(_snaps[i], duration: duration ?? AnbessaMotion.sheet, curve: AnbessaMotion.emphasized);
  }

  Future<void> collapse() => animateTo(0);
  Future<void> expand() => animateTo(_snaps.length - 1);
  double get size => _c?.isAttached == true ? _c!.size : (_snaps.isEmpty ? 0 : _snaps.first);
}

class AppSheet extends StatefulWidget {
  const AppSheet({
    super.key,
    required this.builder,
    this.snaps = const [0.35, 0.7],
    this.initialSnap = 0,
    this.header,
    this.footer,
    this.controller,
    this.onHeightChanged,
    this.padding = const EdgeInsets.fromLTRB(20, 4, 20, 20),
    this.showHandle = true,
    this.expandOnKeyboard = true,
  }) : assert(snaps.length >= 1);

  /// Fractions of the available height, ascending.
  final List<double> snaps;
  final int initialSnap;
  /// Stays put while the body scrolls.
  final Widget? header;
  /// Pinned under the body (a primary button).
  final Widget? footer;
  final Widget Function(BuildContext context, ScrollController scroll) builder;
  final AppSheetController? controller;
  /// The sheet's current height in pixels; feed it to the map as its bottom inset.
  final ValueChanged<double>? onHeightChanged;
  final EdgeInsets padding;
  final bool showHandle;
  final bool expandOnKeyboard;

  @override
  State<AppSheet> createState() => _AppSheetState();
}

class _AppSheetState extends State<AppSheet> {
  final _c = DraggableScrollableController();

  @override
  void initState() {
    super.initState();
    widget.controller?._attach(_c, widget.snaps);
    _c.addListener(_report);
  }

  @override
  void didUpdateWidget(covariant AppSheet old) {
    super.didUpdateWidget(old);
    widget.controller?._attach(_c, widget.snaps);
  }

  void _report() {
    if (_c.isAttached) widget.onHeightChanged?.call(_c.pixels);
  }

  @override
  void dispose() {
    _c.removeListener(_report);
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final snaps = widget.snaps;
    final min = snaps.first, max = snaps.last;
    final initial = snaps[widget.initialSnap.clamp(0, snaps.length - 1)];
    return DraggableScrollableSheet(
      controller: _c,
      initialChildSize: initial,
      minChildSize: min,
      maxChildSize: max,
      snap: true,
      snapSizes: snaps.length > 2 ? snaps.sublist(1, snaps.length - 1) : null,
      snapAnimationDuration: AnbessaMotion.of(context, AnbessaMotion.slow),
      builder: (context, scroll) => Container(
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(AnbessaRadius.sheet)),
          boxShadow: AnbessaElevation.sheet(c.brightness),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            if (widget.showHandle)
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => widget.controller?.animateTo(_c.size < (snaps.last + snaps.first) / 2 ? snaps.length - 1 : 0),
                child: Center(
                  child: Container(
                    margin: const EdgeInsets.only(top: 10, bottom: 8),
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(color: c.borderStrong, borderRadius: BorderRadius.circular(2)),
                  ),
                ),
              ),
            if (widget.header != null) Padding(padding: EdgeInsets.fromLTRB(widget.padding.left, 0, widget.padding.right, 0), child: widget.header),
            Expanded(
              child: SingleChildScrollView(
                controller: scroll,
                padding: widget.padding.copyWith(bottom: widget.footer == null ? widget.padding.bottom + MediaQuery.paddingOf(context).bottom + (widget.expandOnKeyboard ? MediaQuery.viewInsetsOf(context).bottom : 0) : 8),
                child: widget.builder(context, scroll),
              ),
            ),
            if (widget.footer != null)
              Padding(
                padding: EdgeInsets.fromLTRB(widget.padding.left, 8, widget.padding.right, widget.padding.bottom + MediaQuery.paddingOf(context).bottom + (widget.expandOnKeyboard ? MediaQuery.viewInsetsOf(context).bottom : 0)),
                child: widget.footer,
              ),
          ],
        ),
      ),
    );
  }
}

/// A plain card floating over the map (not draggable): small panels, dev tools.
class FloatingCard extends StatelessWidget {
  const FloatingCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.radius = AnbessaRadius.xl});
  final Widget child;
  final EdgeInsets padding;
  final double radius;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: padding,
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(radius), boxShadow: AnbessaElevation.floating(c.brightness)),
      child: child,
    );
  }
}
