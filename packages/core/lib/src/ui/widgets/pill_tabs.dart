// Segmented tabs under their older name: today / week / month, rider / driver. Now the GoRide
// look (see SegmentedTabs).

import 'package:flutter/material.dart';
import 'segmented_tabs.dart';

class PillTabs<T> extends StatelessWidget {
  const PillTabs({super.key, required this.items, required this.selected, required this.onChanged, this.expand = true});
  final List<(T value, String label)> items;
  final T selected;
  final ValueChanged<T> onChanged;
  /// false: as wide as the labels need
  final bool expand;
  @override
  Widget build(BuildContext context) {
    final tabs = SegmentedTabs<T>(items: items, selected: selected, onChanged: onChanged);
    return expand ? tabs : IntrinsicWidth(child: tabs);
  }
}
