// Screens and banners that sit above every feature: the splash while the app boots, the forced
// update, maintenance, offline and announcements.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/prefs_keys.dart';
import '../../core/realtime/realtime_hub.dart';
import '../../core/session/session_controller.dart';
import '../config/client_config_provider.dart';

/// The kit's splash (p. 15): the whole screen amber, the mark and the name in ink in the middle, a
/// spinner near the bottom. Offline at a cold start, the spinner gives way to the offline line
/// and an ink "Try again" pill.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});
  static const _ink = Color(0xFF17191D);
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final l = context.l10n;
    // the stored session couldn't be checked (no network at start): say so, keep it, retry
    final stuck = ref.watch(sessionProvider.select((s) => s.hasError && !s.hasValue && !s.isLoading));
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(statusBarColor: Colors.transparent),
      child: Scaffold(
        backgroundColor: c.accent,
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(flex: 5),
              const Center(child: AnbessaLogo(size: 88, inverted: true)),
              const SizedBox(height: 20),
              Text(l.appName, textAlign: TextAlign.center, style: AnbessaType.display.copyWith(fontSize: 34, fontWeight: FontWeight.w800, color: _ink, height: 1.1)),
              const Spacer(flex: 4),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 32),
                child: AnimatedSwitcher(
                  duration: AnbessaMotion.of(context, AnbessaMotion.base),
                  child: stuck
                      ? Column(
                          key: const ValueKey('offline'),
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(l.offlineBanner, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: _ink)),
                            const SizedBox(height: 16),
                            FilledButton.icon(
                              style: FilledButton.styleFrom(backgroundColor: _ink, foregroundColor: c.accent, minimumSize: const Size(160, AnbessaSize.button), shape: const StadiumBorder(), textStyle: AnbessaType.button),
                              onPressed: () => ref.invalidate(sessionProvider),
                              icon: const Icon(Icons.refresh_rounded),
                              label: Text(l.retry),
                            ),
                          ],
                        )
                      : Semantics(
                          key: const ValueKey('spinner'),
                          label: l.accLoading,
                          child: const Center(child: SizedBox(width: 44, height: 44, child: CircularProgressIndicator(strokeWidth: 4.5, color: _ink, backgroundColor: Color(0x3317191D), strokeCap: StrokeCap.round))),
                        ),
                ),
              ),
              const SizedBox(height: 56),
            ],
          ),
        ),
      ),
    );
  }
}

/// The አ mark: a rounded amber square with an ink glyph; [inverted] puts an amber glyph on ink
/// (the splash, on an amber page).
class AnbessaLogo extends StatelessWidget {
  const AnbessaLogo({super.key, this.size = 40, this.inverted = false});
  final double size;
  final bool inverted;
  static const _ink = Color(0xFF17191D);
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: inverted ? _ink : c.accent, borderRadius: BorderRadius.circular(size * 0.3)),
        alignment: Alignment.center,
        child: Text('አ', style: TextStyle(color: inverted ? c.accent : _ink, fontSize: size * 0.58, fontWeight: FontWeight.w700, fontFamily: 'NotoSansEthiopic', height: 1)),
      ),
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
