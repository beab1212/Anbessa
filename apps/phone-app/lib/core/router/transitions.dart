// Page transitions for go_router: a fade-through for ordinary pushes and a slide-up for
// sheet-like screens (route editor, quote, pay, rating).

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';

Page<T> fadeThroughPage<T>(GoRouterState state, Widget child) => CustomTransitionPage<T>(
      key: state.pageKey,
      child: child,
      transitionDuration: AnbessaMotion.slow,
      reverseTransitionDuration: AnbessaMotion.base,
      transitionsBuilder: (context, a, secondary, child) => FadeTransition(
        opacity: CurvedAnimation(parent: a, curve: const Interval(0.3, 1, curve: Curves.easeOut)),
        child: ScaleTransition(scale: Tween(begin: 0.98, end: 1.0).animate(CurvedAnimation(parent: a, curve: AnbessaMotion.emphasized)), child: child),
      ),
    );

Page<T> slideUpPage<T>(GoRouterState state, Widget child) => CustomTransitionPage<T>(
      key: state.pageKey,
      child: child,
      transitionDuration: AnbessaMotion.sheet,
      reverseTransitionDuration: AnbessaMotion.slow,
      transitionsBuilder: (context, a, secondary, child) => SlideTransition(
        position: Tween(begin: const Offset(0, 0.06), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: AnbessaMotion.emphasized)),
        child: FadeTransition(opacity: a, child: child),
      ),
    );

/// No transition (tab branches switch through the shell).
Page<T> instantPage<T>(GoRouterState state, Widget child) => NoTransitionPage<T>(key: state.pageKey, child: child);
