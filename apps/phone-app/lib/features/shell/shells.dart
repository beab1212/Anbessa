// The two bottom-navigation shells (rider: Home, Activity, Account; driver: Home, Earnings,
// Activity, Account). Banners float over the page under the status bar; maps read their height
// from `bannerHeightProvider` to keep their top controls clear.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/state.dart';
import '../bootstrap/gates.dart';
import '../driver/earnings/earnings_controller.dart';
import '../rider/payments/payment_due_controller.dart';

/// Height of the floating banners, in pixels (0 when none).
final bannerHeightProvider = valueProvider<double>(0);

/// The rider's booking and trip stages use the whole screen: no tab bar there.
bool riderTabsHiddenAt(Uri? location) {
  final p = location?.path ?? '';
  return p.startsWith('/rider/book') || p.startsWith('/rider/trip');
}

class RiderShell extends ConsumerWidget {
  const RiderShell({super.key, required this.shell, this.location});
  final StatefulNavigationShell shell;
  /// where the app is (the tab bar hides on the booking and trip stages)
  final Uri? location;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final due = ref.watch(paymentDueProvider).value ?? false;
    final hidden = riderTabsHiddenAt(location);
    return Scaffold(
      // the map never resizes for the keyboard; the sheets and screens make room themselves
      resizeToAvoidBottomInset: false,
      body: _Body(audience: 'rider', shell: shell),
      bottomNavigationBar: hidden
          ? null
          : _TopHairline(child: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) {
          Haptics.selection();
          shell.goBranch(i, initialLocation: i == shell.currentIndex);
        },
        destinations: [
          // the kit's tab bar: outlined icons, the selected one filled in amber, a small label
          NavigationDestination(icon: const Icon(Icons.home_outlined), selectedIcon: const Icon(Icons.home_rounded), label: l.tabHome),
          NavigationDestination(
            icon: Badge(isLabelVisible: due, smallSize: 8, child: const Icon(Icons.description_outlined)),
            selectedIcon: Badge(isLabelVisible: due, smallSize: 8, child: const Icon(Icons.description_rounded)),
            label: l.tabActivity,
          ),
          NavigationDestination(icon: const Icon(Icons.person_outline_rounded), selectedIcon: const Icon(Icons.person_rounded), label: l.tabAccount),
        ],
      )),
    );
  }
}

/// The kit's hairline between the page and the tab bar.
class _TopHairline extends StatelessWidget {
  const _TopHairline({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => DecoratedBox(decoration: BoxDecoration(border: Border(top: BorderSide(color: context.colors.border))), child: child);
}

class DriverShell extends ConsumerWidget {
  const DriverShell({super.key, required this.shell});
  final StatefulNavigationShell shell;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final balance = ref.watch(balanceProvider).value;
    final attention = balance != null && balance.state != BalanceState.ok;
    final due = ref.watch(paymentDueProvider).value ?? false; // drivers ride too
    return Scaffold(
      body: _Body(audience: 'driver', shell: shell),
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) {
          Haptics.selection();
          shell.goBranch(i, initialLocation: i == shell.currentIndex);
        },
        destinations: [
          NavigationDestination(icon: const Icon(Icons.drive_eta_outlined), selectedIcon: const Icon(Icons.drive_eta), label: l.tabHome),
          NavigationDestination(
            icon: Badge(isLabelVisible: attention, smallSize: 8, child: const Icon(Icons.account_balance_wallet_outlined)),
            selectedIcon: Badge(isLabelVisible: attention, smallSize: 8, child: const Icon(Icons.account_balance_wallet)),
            label: l.tabEarnings,
          ),
          NavigationDestination(
            icon: Badge(isLabelVisible: due, smallSize: 8, child: const Icon(Icons.receipt_long_outlined)),
            selectedIcon: Badge(isLabelVisible: due, smallSize: 8, child: const Icon(Icons.receipt_long)),
            label: l.tabActivity,
          ),
          NavigationDestination(icon: const Icon(Icons.person_outline), selectedIcon: const Icon(Icons.person), label: l.tabAccount),
        ],
      ),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.audience, required this.shell});
  final String audience;
  final StatefulNavigationShell shell;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Stack(
        children: [
          shell,
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            child: Banners(audience: audience, onHeightChanged: (h) => ref.read(bannerHeightProvider.notifier).set(h)),
          ),
        ],
      );
}
