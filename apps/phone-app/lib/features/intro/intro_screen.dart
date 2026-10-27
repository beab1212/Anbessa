// Three pages on first launch: what the app is, how you pay, that you can drive. Seen once.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:smooth_page_indicator/smooth_page_indicator.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/prefs_keys.dart';
import '../../core/router/routes.dart';

class IntroSeen extends Notifier<bool> {
  @override
  bool build() => ref.watch(prefsProvider).getBool(PrefsKeys.introSeen) ?? false;
  Future<void> markSeen() async {
    state = true;
    await ref.read(prefsProvider).setBool(PrefsKeys.introSeen, true);
  }
}

final introSeenProvider = NotifierProvider<IntroSeen, bool>(IntroSeen.new);

class IntroScreen extends ConsumerStatefulWidget {
  const IntroScreen({super.key});
  @override
  ConsumerState<IntroScreen> createState() => _IntroScreenState();
}

class _IntroScreenState extends ConsumerState<IntroScreen> {
  final _page = PageController();
  int _index = 0;

  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  Future<void> _done() async {
    await ref.read(introSeenProvider.notifier).markSeen();
    if (mounted) context.go(Routes.welcome);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final pages = [
      (AnbessaIllustration.carWaiting, l.introTitle1, l.introBody1),
      (AnbessaIllustration.wallet, l.introTitle2, l.introBody2),
      (AnbessaIllustration.celebrate, l.introTitle3, l.introBody3),
    ];
    final last = _index == pages.length - 1;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(onPressed: _done, child: Text(l.introSkip)),
            ),
            Expanded(
              child: PageView.builder(
                controller: _page,
                itemCount: pages.length,
                onPageChanged: (i) {
                  Haptics.selection();
                  setState(() => _index = i);
                },
                itemBuilder: (_, i) {
                  final (ill, title, body) = pages[i];
                  // small screens and large text: the page scrolls rather than overflows
                  return LayoutBuilder(
                    builder: (context, box) => SingleChildScrollView(
                      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                      child: ConstrainedBox(
                        constraints: BoxConstraints(minHeight: box.maxHeight - 32),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            PopIn(key: ValueKey(i), child: Illustration(ill, size: (box.maxHeight * 0.34).clamp(120.0, 220.0))),
                            const SizedBox(height: 28),
                            FadeSlideIn(key: ValueKey('t$i'), delay: const Duration(milliseconds: 80), child: Text(title, textAlign: TextAlign.center, style: AnbessaType.h1.copyWith(color: c.text))),
                            const SizedBox(height: 12),
                            FadeSlideIn(key: ValueKey('b$i'), delay: const Duration(milliseconds: 160), child: Text(body, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2))),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
              child: Row(
                children: [
                  SmoothPageIndicator(
                    controller: _page,
                    count: pages.length,
                    effect: ExpandingDotsEffect(activeDotColor: c.accent, dotColor: c.border, dotHeight: 8, dotWidth: 8, expansionFactor: 3),
                  ),
                  const Spacer(),
                  SizedBox(
                    width: 160,
                    child: PrimaryButton(
                      label: last ? l.introStart : l.introNext,
                      icon: last ? null : Icons.arrow_forward_rounded,
                      onPressed: last ? _done : () => _page.nextPage(duration: AnbessaMotion.slow, curve: AnbessaMotion.emphasized),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
