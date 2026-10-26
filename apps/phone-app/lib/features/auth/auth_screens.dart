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

class WelcomeScreen extends ConsumerWidget {
  const WelcomeScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final reason = ref.watch(sessionProvider.notifier).lastSignOut;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 32),
            const AnbessaLogo(size: 56),
            const SizedBox(height: 20),
            Text(l.welcomeTitle, style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: c.text, height: 1.15)),
            const SizedBox(height: 10),
            Text(l.welcomeLede, style: TextStyle(fontSize: 16, color: c.text2, height: 1.4)),
            const SizedBox(height: 28),
            if (reason == SignOutReason.sessionEnded) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.errorSessionEnded, tone: NoticeTone.info)),
            if (reason == SignOutReason.suspended) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.errorSuspended, tone: NoticeTone.error)),
            PrimaryButton(label: l.signInWithPhone, icon: Icons.phone_android, onPressed: () => context.push(Routes.signIn)),
            const SizedBox(height: 10),
            OutlinedButton.icon(onPressed: () => context.push('${Routes.signIn}?driver=1'), icon: const Icon(Icons.drive_eta_outlined), label: Text(l.driveWithAnbessa)),
            if (Env.devLoginOn) ...[const SizedBox(height: 28), const DevSignInPanel()],
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

  Future<void> _send() async {
    final l = context.l10n;
    final e164 = toE164(_ctrl.text);
    if (e164 == null) return setState(() => _error = AppError(status: 400, code: 'phone', message: l.phoneInvalid));
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authApiProvider).sendOtp(e164);
      if (mounted) context.push('${Routes.verify}?phone=${Uri.encodeComponent(e164)}${widget.driver ? '&driver=1' : ''}');
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l.phoneTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(l.phoneLede, style: TextStyle(color: context.colors.text2)),
          const SizedBox(height: 16),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.phone,
            autofillHints: const [AutofillHints.telephoneNumber],
            decoration: InputDecoration(labelText: l.phoneLabel, hintText: l.phoneHint, prefixIcon: const Icon(Icons.phone_outlined)),
            onSubmitted: (_) => _send(),
          ),
          const SizedBox(height: 12),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 12),
          PrimaryButton(label: l.sendCode, busy: _busy, onPressed: _send),
        ],
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

  Future<void> _verify() async {
    final code = _ctrl.text.trim();
    if (code.length != 6) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final v = await ref.read(authApiProvider).verifyOtp(widget.phone, code);
      await ref.read(sessionProvider.notifier).signIn(v);
      if (widget.driver) await ref.read(modeProvider.notifier).set(AppMode.driver);
      // the router's guards take over from here
    } catch (e) {
      setState(() => _error = e is AppError && (e.status == 400 || e.status == 401) && e.code != ErrorCodes.rateLimited ? AppError(status: 400, code: 'code', message: context.l10n.codeInvalid) : e);
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
      appBar: AppBar(title: Text(l.codeTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(l.codeSent(formatPhone(widget.phone)), style: TextStyle(color: c.text2)),
          TextButton(onPressed: () => context.pop(), child: Text(l.changeNumber)),
          const SizedBox(height: 8),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            autofillHints: const [AutofillHints.oneTimeCode],
            style: const TextStyle(fontSize: 28, letterSpacing: 10, fontFamilyFallback: monoFamilyFallback),
            textAlign: TextAlign.center,
            decoration: InputDecoration(labelText: l.codeLabel),
            onChanged: (v) {
              if (v.length == 6) _verify();
            },
          ),
          const SizedBox(height: 12),
          if (_elapsed >= 20) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.sentBySmsToo, tone: NoticeTone.info)),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 12),
          PrimaryButton(label: l.verify, busy: _busy, onPressed: _verify),
          const SizedBox(height: 8),
          TextButton(onPressed: _resendIn > 0 ? null : _resend, child: Text(_resendIn > 0 ? l.resendIn(_resendIn) : l.resend)),
        ],
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
      title: l.devSignInTitle,
      trailing: const StatusPill('development only', tone: Tone.amber),
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
              final list = (snap.data ?? const <DevAccount>[]).where((a) => a.app == 'phone').toList()..sort((a, b) => a.app.compareTo(b.app));
              if (!snap.hasData) return const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator());
              return Column(
                children: [
                  for (final a in list)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      enabled: a.seeded && _busy == null,
                      title: Text(a.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text('${a.name} · ${formatPhone(a.phone)}${a.seeded ? '' : ' · ${l.devNotSeeded}'}'),
                      trailing: _busy == a.key ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.login),
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
    Widget option(IconData icon, String title, String lede, AppMode mode) => Card(
          child: ListTile(
            contentPadding: const EdgeInsets.all(16),
            leading: Icon(icon, size: 32, color: c.accentStrong),
            title: Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            subtitle: Text(lede),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => ref.read(modeProvider.notifier).set(mode),
          ),
        );
    return Scaffold(
      appBar: AppBar(title: Text(l.appName)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(l.chooseModeTitle, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
          const SizedBox(height: 16),
          option(Icons.hail, l.rideTitle, l.rideLede, AppMode.rider),
          const SizedBox(height: 10),
          option(Icons.drive_eta, l.driveTitle, l.driveLede, AppMode.driver),
        ],
      ),
    );
  }
}
