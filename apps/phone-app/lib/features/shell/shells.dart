// The two bottom-navigation shells (rider: Home, Activity, Account; driver: Home, Earnings,
// Activity, Account) with the banners above every tab.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/l10n/l10n.dart';
import '../bootstrap/gates.dart';

class RiderShell extends StatelessWidget {
  const RiderShell({super.key, required this.shell});
  final StatefulNavigationShell shell;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      body: Column(children: [const Banners(audience: 'rider'), Expanded(child: shell)]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: [
          NavigationDestination(icon: const Icon(Icons.map_outlined), selectedIcon: const Icon(Icons.map), label: l.tabHome),
          NavigationDestination(icon: const Icon(Icons.receipt_long_outlined), selectedIcon: const Icon(Icons.receipt_long), label: l.tabActivity),
          NavigationDestination(icon: const Icon(Icons.person_outline), selectedIcon: const Icon(Icons.person), label: l.tabAccount),
        ],
      ),
    );
  }
}

class DriverShell extends StatelessWidget {
  const DriverShell({super.key, required this.shell});
  final StatefulNavigationShell shell;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      body: Column(children: [const Banners(audience: 'driver'), Expanded(child: shell)]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: [
          NavigationDestination(icon: const Icon(Icons.drive_eta_outlined), selectedIcon: const Icon(Icons.drive_eta), label: l.tabHome),
          NavigationDestination(icon: const Icon(Icons.account_balance_wallet_outlined), selectedIcon: const Icon(Icons.account_balance_wallet), label: l.tabEarnings),
          NavigationDestination(icon: const Icon(Icons.receipt_long_outlined), selectedIcon: const Icon(Icons.receipt_long), label: l.tabActivity),
          NavigationDestination(icon: const Icon(Icons.person_outline), selectedIcon: const Icon(Icons.person), label: l.tabAccount),
        ],
      ),
    );
  }
}
