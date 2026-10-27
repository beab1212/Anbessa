// Loading placeholders that keep the layout's shape instead of a spinner.

import 'package:flutter/material.dart';
import 'package:shimmer/shimmer.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

class Skeleton extends StatelessWidget {
  const Skeleton.box({super.key, this.width, this.height = 16, this.radius = AnbessaRadius.sm}) : circle = false;
  const Skeleton.line({super.key, this.width, this.height = 14}) : radius = 7, circle = false;
  const Skeleton.circle({super.key, required double size}) : width = size, height = size, radius = 0, circle = true;
  final double? width;
  final double height;
  final double radius;
  final bool circle;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final box = Container(
      width: width,
      height: height,
      decoration: BoxDecoration(color: c.surface2, shape: circle ? BoxShape.circle : BoxShape.rectangle, borderRadius: circle ? null : BorderRadius.circular(radius)),
    );
    if (MediaQuery.disableAnimationsOf(context)) return box;
    return Shimmer.fromColors(baseColor: c.surface2, highlightColor: c.isDark ? c.borderStrong : c.surface, child: box);
  }
}

/// Rows of avatar + two lines, for lists.
class SkeletonList extends StatelessWidget {
  const SkeletonList({super.key, this.rows = 5, this.avatar = true});
  final int rows;
  final bool avatar;
  @override
  Widget build(BuildContext context) => Column(
        children: [
          for (var i = 0; i < rows; i++)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                children: [
                  if (avatar) ...[const Skeleton.circle(size: 40), const SizedBox(width: 12)],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [Skeleton.line(width: 140 + (i % 3) * 30), const SizedBox(height: 8), const Skeleton.line(width: 90, height: 12)],
                    ),
                  ),
                  const SizedBox(width: 12),
                  const Skeleton.line(width: 56),
                ],
              ),
            ),
        ],
      );
}

/// A card-sized block with a title line and a body line.
class SkeletonCard extends StatelessWidget {
  const SkeletonCard({super.key, this.height = 96});
  final double height;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      height: height,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: Border.all(color: c.border)),
      child: const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [Skeleton.line(width: 120), SizedBox(height: 10), Skeleton.line(width: 200, height: 12), Spacer(), Skeleton.line(width: 80, height: 12)],
      ),
    );
  }
}
