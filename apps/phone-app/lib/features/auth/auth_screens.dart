// Sign-in (workflow 01): welcome, phone number, the 6-digit code. Plus the development-only
// "Sign in as…" panel that lists the seed accounts (auth-service DEV_LOGIN=on).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/config/env.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/session/session_controller.dart';
import '../bootstrap/gates.dart';
import '../profile/account_screens.dart' show localeProvider;

class WelcomeScreen extends ConsumerWidget {
  const WelcomeScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final reason = ref.watch(sessionProvider.notifier).lastSignOut;
    final locale = ref.watch(localeProvider);
    final isAm = (locale?.languageCode ?? Localizations.localeOf(context).languageCode) == 'am';
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: PillTabs<String>(
                  expand: false,
                  items: const [('en', 'English'), ('am', 'አማርኛ')],
                  selected: isAm ? 'am' : 'en',
                  onChanged: (v) => ref.read(localeProvider.notifier).set(Locale(v)),
                ),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
                children: [
                  const SizedBox(height: 24),
                  const PopIn(child: Align(alignment: Alignment.centerLeft, child: AnbessaLogo(size: 72))),
                  const SizedBox(height: 28),
                  FadeSlideIn(delay: const Duration(milliseconds: 80), child: Text(l.welcomeTitle, style: AnbessaType.display.copyWith(color: c.text))),
                  const SizedBox(height: 12),
                  FadeSlideIn(delay: const Duration(milliseconds: 160), child: Text(l.welcomeLede, style: AnbessaType.body.copyWith(color: c.text2, fontSize: 16))),
                  const SizedBox(height: 28),
                  if (reason == SignOutReason.sessionEnded) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.errorSessionEnded, tone: NoticeTone.info)),
                  if (reason == SignOutReason.suspended) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.errorSuspended, tone: NoticeTone.error)),
                  if (Env.devLoginOn) ...[
                    const SizedBox(height: 8),
                    Theme(
                      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                      child: ExpansionTile(
                        tilePadding: EdgeInsets.zero,
                        title: Text(l.devSignInTitle, style: AnbessaType.body2.copyWith(color: c.muted)),
                        children: const [DevSignInPanel()],
                      ),
                    ),
                  ],
                ],
              ),
            ),
            // the two ways in stay pinned to the bottom, whatever the text size
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FadeSlideIn(delay: const Duration(milliseconds: 240), child: PrimaryButton(label: l.signInWithPhone, icon: Icons.phone_android, onPressed: () => context.push(Routes.signIn))),
                  const SizedBox(height: 10),
                  FadeSlideIn(delay: const Duration(milliseconds: 300), child: OutlinedButton(onPressed: () => context.push('${Routes.signIn}?driver=1'), child: Text(l.driveWithAnbessa))),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class PhoneScreen extends ConsumerStatefulWidget {
  const PhoneScreen({super.key, this.driver = false});
  final bool driver;
  @override
  ConsumerState<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends ConsumerState<PhoneScreen> {
  final _ctrl = TextEditingController();
  Object? _error;
  bool _busy = false;
  int _shake = 0;

  String get _digits => _ctrl.text.replaceAll(RegExp(r'\D'), '');
  bool get _plausible => toE164(_ctrl.text) != null || toE164('0$_digits') != null;

  Future<void> _send() async {
    final l = context.l10n;
    final e164 = toE164(_ctrl.text) ?? toE164('0$_digits');
    if (e164 == null) {
      Haptics.error();
      return setState(() {
        _error = AppError(status: 400, code: 'phone', message: l.phoneInvalid);
        _shake++;
      });
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authApiProvider).sendOtp(e164);
      if (mounted) context.push('${Routes.verify}?phone=${Uri.encodeComponent(e164)}${widget.driver ? '&driver=1' : ''}');
    } catch (e) {
      Haptics.error();
      setState(() {
        _error = e;
        _shake++;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
                children: [
                  Text(l.phoneTitle, style: AnbessaType.h1.copyWith(color: c.text)),
                  const SizedBox(height: 8),
                  Text(l.phoneLede, style: AnbessaType.body.copyWith(color: c.text2)),
                  const SizedBox(height: 24),
                  Shake(
                    trigger: _shake == 0 ? null : _shake,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          height: 56,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: c.border)),
                          child: Text('🇪🇹 +251', style: AnbessaType.title.copyWith(color: c.text)),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: TextField(
                            controller: _ctrl,
                            autofocus: true,
                            keyboardType: TextInputType.phone,
                            autofillHints: const [AutofillHints.telephoneNumber],
                            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d\s+]')), LengthLimitingTextInputFormatter(16)],
                            style: AnbessaType.title.copyWith(fontSize: 20, letterSpacing: 1, fontFeatures: AnbessaType.tabular),
                            decoration: InputDecoration(hintText: '9 12 345 678', errorText: null),
                            onChanged: (_) => setState(() {}),
                            onSubmitted: (_) => _send(),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(l.phoneHint, style: AnbessaType.caption.copyWith(color: c.muted)),
                  const SizedBox(height: 12),
                  Problem(_error, describe: (e) => describeError(l, e)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
              child: PrimaryButton(label: l.sendCode, icon: Icons.arrow_forward_rounded, busy: _busy, onPressed: _plausible ? _send : null),
            ),
          ],
        ),
      ),
    );
  }
}

class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key, required this.phone, this.driver = false});
  final String phone;
  final bool driver;
  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  final _ctrl = TextEditingController();
  Object? _error;
  bool _busy = false;
  bool _wrong = false;
  int _shake = 0;
  int _resendIn = 30;
  int _elapsed = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {
        _elapsed++;
        if (_resendIn > 0) _resendIn--;
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _verify([String? code]) async {
    final v = (code ?? _ctrl.text).trim();
    if (v.length != 6) return;
    setState(() {
      _busy = true;
      _error = null;
      _wrong = false;
    });
    try {
      final s = await ref.read(authApiProvider).verifyOtp(widget.phone, v);
      Haptics.success();
      await ref.read(sessionProvider.notifier).signIn(s);
      if (widget.driver) await ref.read(modeProvider.notifier).set(AppMode.driver);
      // the router's guards take over from here
    } catch (e) {
      Haptics.error();
      final wrong = e is AppError && (e.status == 400 || e.status == 401) && e.code != ErrorCodes.rateLimited;
      setState(() {
        _wrong = wrong;
        _shake++;
        _error = wrong ? AppError(status: 400, code: 'code', message: context.l10n.codeInvalid) : e;
      });
      if (wrong) _ctrl.clear();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    setState(() {
      _resendIn = 30;
      _elapsed = 0;
      _error = null;
    });
    try {
      await ref.read(authApiProvider).sendOtp(widget.phone);
    } catch (e) {
      setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
          children: [
            Text(l.codeTitle, style: AnbessaType.h1.copyWith(color: c.text)),
            const SizedBox(height: 8),
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(l.codeSent(formatPhone(widget.phone)), style: AnbessaType.body.copyWith(color: c.text2)),
                TextButton(onPressed: () => context.pop(), style: TextButton.styleFrom(visualDensity: VisualDensity.compact), child: Text(l.changeNumber)),
              ],
            ),
            const SizedBox(height: 24),
            Shake(
              trigger: _shake == 0 ? null : _shake,
              child: Center(child: PinBoxes(length: 6, controller: _ctrl, error: _wrong, enabled: !_busy, onCompleted: _verify, size: 48)),
            ),
            const SizedBox(height: 20),
            if (_busy) const Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))),
            if (_elapsed >= 20 && !_busy) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.sentBySmsToo, tone: NoticeTone.info)),
            Problem(_error, describe: (e) => describeError(l, e)),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (_resendIn > 0) ...[
                  CountdownRing(remaining: Duration(seconds: _resendIn), total: const Duration(seconds: 30), size: 28, strokeWidth: 3, child: const SizedBox()),
                  const SizedBox(width: 8),
                ],
                TextButton(onPressed: _resendIn > 0 ? null : _resend, child: Text(_resendIn > 0 ? l.resendIn(_resendIn) : l.resend)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Development only: the seed accounts, signed in through the real endpoints with the code from
/// /api/dev/code. Never in release builds (Env.devLoginOn is false there).
class DevSignInPanel extends ConsumerStatefulWidget {
  const DevSignInPanel({super.key});
  @override
  ConsumerState<DevSignInPanel> createState() => _DevSignInPanelState();
}

class _DevSignInPanelState extends ConsumerState<DevSignInPanel> {
  late Future<List<DevAccount>> _accounts = ref.read(authApiProvider).devAccounts();
  String? _busy;
  Object? _error;

  Future<void> _signIn(DevAccount a) async {
    setState(() {
      _busy = a.key;
      _error = null;
    });
    final auth = ref.read(authApiProvider);
    try {
      await auth.sendOtp(a.phone);
      final code = await auth.devCode(a.phone);
      final v = await auth.verifyOtp(a.phone, code);
      await ref.read(sessionProvider.notifier).signIn(v);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return SectionCard(
      trailing: const StatusPill('development only', tone: Tone.amber),
      title: l.devSignInTitle,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l.devSignInLede, style: TextStyle(color: c.muted, fontSize: 13)),
          const SizedBox(height: 8),
          Problem(_error, describe: (e) => describeError(l, e)),
          FutureBuilder(
            future: _accounts,
            builder: (context, snap) {
              if (snap.hasError) return Notice('${l.devNotSeeded} ${describeError(l, snap.error)}', tone: NoticeTone.warning, action: TextButton(onPressed: () => setState(() => _accounts = ref.read(authApiProvider).devAccounts()), child: Text(l.retry)));
              final list = (snap.data ?? const <DevAccount>[]).where((a) => a.app == 'phone').toList();
              if (!snap.hasData) return const SkeletonList(rows: 3, avatar: false);
              return Column(
                children: [
                  for (final a in list)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      enabled: a.seeded && _busy == null,
                      leading: AvatarImage(name: a.name, size: 36),
                      title: Text(a.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text('${a.name} · ${formatPhone(a.phone)}${a.seeded ? '' : ' · ${l.devNotSeeded}'}'),
                      trailing: _busy == a.key ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : null,
                      onTap: () => _signIn(a),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class ModeSwitcherScreen extends ConsumerWidget {
  const ModeSwitcherScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    Widget option(int i, String title, String lede, AppMode mode) => FadeSlideIn(
          delay: Duration(milliseconds: 80 * i),
          child: Material(
            color: c.surface,
            borderRadius: BorderRadius.circular(AnbessaRadius.xl),
            child: InkWell(
              borderRadius: BorderRadius.circular(AnbessaRadius.xl),
              onTap: () {
                Haptics.medium();
                ref.read(modeProvider.notifier).set(mode);
              },
              child: Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.xl), border: Border.all(color: c.border)),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [Text(title, style: AnbessaType.h2.copyWith(color: c.text)), const SizedBox(height: 4), Text(lede, style: AnbessaType.body2.copyWith(color: c.text2))],
                      ),
                    ),
                    Icon(Icons.chevron_right_rounded, color: c.faint),
                  ],
                ),
              ),
            ),
          ),
        );
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 24),
            const AnbessaLogo(size: 48),
            const SizedBox(height: 20),
            Text(l.chooseModeTitle, style: AnbessaType.h1.copyWith(color: c.text)),
            const SizedBox(height: 20),
            option(0, l.rideTitle, l.rideLede, AppMode.rider),
            const SizedBox(height: 12),
            option(1, l.driveTitle, l.driveLede, AppMode.driver),
          ],
        ),
      ),
    );
  }
}
