// Progress across named steps (driver onboarding).

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

class StepperHeader extends StatelessWidget {
  const StepperHeader({super.key, required this.steps, required this.current, this.done = const {}});
  final List<String> steps;
  /// index of the step in progress
  final int current;
  final Set<int> done;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        Row(
          children: [
            for (final (i, _) in steps.indexed) ...[
              if (i > 0)
                Expanded(
                  child: AnimatedContainer(
                    duration: AnbessaMotion.of(context, AnbessaMotion.slow),
                    height: 3,
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    decoration: BoxDecoration(color: i <= current ? c.accent : c.border, borderRadius: BorderRadius.circular(2)),
                  ),
                ),
              _Dot(index: i, state: done.contains(i) ? _S.done : i == current ? _S.current : i < current ? _S.done : _S.todo),
            ],
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            for (final (i, s) in steps.indexed)
              Expanded(
                child: Text(
                  s,
                  textAlign: i == 0 ? TextAlign.start : i == steps.length - 1 ? TextAlign.end : TextAlign.center,
                  style: AnbessaType.caption.copyWith(color: i == current ? c.text : c.muted, fontWeight: i == current ? FontWeight.w600 : FontWeight.w400),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
        ),
      ],
    );
  }
}

enum _S { done, current, todo }

class _Dot extends StatelessWidget {
  const _Dot({required this.index, required this.state});
  final int index;
  final _S state;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AnimatedContainer(
      duration: AnbessaMotion.of(context, AnbessaMotion.slow),
      width: 26,
      height: 26,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: state == _S.todo ? c.surface : c.primaryFill,
        border: Border.all(color: state == _S.todo ? c.borderStrong : c.primaryFill, width: 2),
      ),
      child: Center(
        child: state == _S.done
            ? Icon(Icons.check, size: 15, color: c.onAccent)
            : Text('${index + 1}', style: AnbessaType.label.copyWith(color: state == _S.todo ? c.muted : c.onAccent)),
      ),
    );
  }
}
