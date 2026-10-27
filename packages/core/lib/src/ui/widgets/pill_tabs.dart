// Segmented pills: today / week / month, rider / driver.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'feedback.dart';

class PillTabs<T> extends StatelessWidget {
  const PillTabs({super.key, required this.items, required this.selected, required this.onChanged, this.expand = true});
  final List<(T value, String label)> items;
  final T selected;
  final ValueChanged<T> onChanged;
  final bool expand;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.pill), border: Border.all(color: c.border)),
      child: Row(
        mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
        children: [
          for (final (value, label) in items)
            Expanded(
              flex: expand ? 1 : 0,
              child: Semantics(
                selected: value == selected,
                button: true,
                child: GestureDetector(
                  onTap: () {
                    if (value != selected) {
                      Haptics.selection();
                      onChanged(value);
                    }
                  },
                  child: AnimatedContainer(
                    duration: AnbessaMotion.of(context, AnbessaMotion.base),
                    curve: AnbessaMotion.emphasized,
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    decoration: BoxDecoration(
                      color: value == selected ? c.surface : Colors.transparent,
                      borderRadius: BorderRadius.circular(AnbessaRadius.pill),
                      boxShadow: value == selected ? AnbessaElevation.card(c.brightness) : null,
                    ),
                    child: Text(label, textAlign: TextAlign.center, style: AnbessaType.label.copyWith(color: value == selected ? c.text : c.muted, fontSize: 13)),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
