// Screens and banners that sit above every feature: the splash while the app boots, the forced
// update, maintenance, offline and announcements.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/prefs_keys.dart';
import '../../core/realtime/realtime_hub.dart';
import '../../core/session/session_controller.dart';
import '../config/client_config_provider.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const AnbessaLogo(size: 64),
            const SizedBox(height: 16),
            Text(context.l10n.appName, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: c.text)),
            const SizedBox(height: 24),
            const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5)),
          ],
        ),
      ),
    );
  }
}

/// The አ mark on amber, like the web's logo.
class AnbessaLogo extends StatelessWidget {
  const AnbessaLogo({super.key, this.size = 40});
  final double size;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(size * 0.28)),
      alignment: Alignment.center,
      child: Text('አ', style: TextStyle(color: Colors.white, fontSize: size * 0.55, fontWeight: FontWeight.w700, fontFamily: 'NotoSansEthiopic', height: 1)),
    );
  }
}

class UpdateRequiredScreen extends ConsumerWidget {
  const UpdateRequiredScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final v = ref.watch(appVersionProvider).value;
    final store = v?.platform == 'ios' ? 'https://apps.apple.com/app/anbessa' : 'https://play.google.com/store/apps/details?id=com.anbessa.phone_app';
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: EmptyState(
          icon: Icons.system_update_alt,
          title: l.updateRequiredTitle,
          body: l.updateRequiredBody,
          action: PrimaryButton(label: l.openStore, icon: Icons.open_in_new, onPressed: () => launchUrl(Uri.parse(store), mode: LaunchMode.externalApplication)),
        ),
      ),
    );
  }
}

/// Maintenance, reconnecting and announcements, floating under the status bar.
class Banners extends ConsumerWidget {
  const Banners({super.key, this.audience = 'rider', this.onHeightChanged});
  final String audience;
  final ValueChanged<double>? onHeightChanged;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final cfg = ref.watch(configProvider);
    final rt = ref.watch(realtimeStateProvider).value ?? RealtimeState.offline;
    final signedIn = ref.watch(currentSessionProvider) != null;
    final dismissed = ref.watch(dismissedAnnouncementsProvider);
    final items = <Widget>[
      if (cfg.maintenance.newTripsPaused)
        FloatingBanner(key: const ValueKey('maintenance'), text: cfg.maintenance.message.isEmpty ? l.newTripsPaused : cfg.maintenance.message, tone: NoticeTone.warning, icon: Icons.build_circle_outlined),
      if (signedIn && rt == RealtimeState.reconnecting) FloatingBanner(key: const ValueKey('reconnecting'), text: l.reconnecting, tone: NoticeTone.warning, pulse: true),
      for (final a in cfg.announcements.where((a) => a.audiences.contains(audience) && !dismissed.contains(a.id)))
        FloatingBanner(
          key: ValueKey('ann-${a.id}'),
          title: a.title,
          text: a.body,
          tone: a.severity == 'warning' ? NoticeTone.warning : NoticeTone.info,
          icon: Icons.campaign_outlined,
          onDismiss: () => ref.read(dismissedAnnouncementsProvider.notifier).dismiss(a.id),
        ),
    ];
    if (items.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => onHeightChanged?.call(0));
      return const SizedBox.shrink();
    }
    return FloatingBannerStack(onHeightChanged: onHeightChanged, children: items);
  }
}

/// Announcements the person closed, kept across launches (they'd come back on every refresh).
class DismissedAnnouncements extends Notifier<Set<String>> {
  @override
  Set<String> build() => ref.watch(prefsProvider).getStringList(PrefsKeys.dismissedAnnouncements)?.toSet() ?? {};
  Future<void> dismiss(String id) async {
    state = {...state, id};
    // keep the list short: ids of announcements that no longer exist are harmless
    await ref.read(prefsProvider).setStringList(PrefsKeys.dismissedAnnouncements, state.toList().takeLast(50));
  }
}

extension<T> on List<T> {
  List<T> takeLast(int n) => length <= n ? this : sublist(length - n);
}

final dismissedAnnouncementsProvider = NotifierProvider<DismissedAnnouncements, Set<String>>(DismissedAnnouncements.new);
