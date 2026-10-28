// Sign-in (workflow 01) in the GoRide kit's look: welcome, phone number (sign up or sign in), the
// 6-digit code, ride or drive. Plus the development-only
// "Sign in as…" panel that lists the seed accounts (auth-service DEV_LOGIN=on).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/config/env.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/session/session_controller.dart';
import '../bootstrap/gates.dart';
import '../profile/account_screens.dart' show localeProvider;

/// The kit's "Let's Get Started!" (p. 19) without the social buttons: the mark, the title, a
/// line, "Sign up" and "Sign in" (both lead to the phone number; we sign in by phone and code),
/// "Drive with Anbessa", and Privacy Policy · Terms of Service at the bottom.
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
              alignment: AlignmentDirectional.centerEnd,
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
              child: LayoutBuilder(
                builder: (context, box) => SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: AnbessaSpace.page),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: box.maxHeight),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const SizedBox(height: 16),
                        const PopIn(child: Center(child: AnbessaLogo(size: 76))),
                        const SizedBox(height: 40),
                        FadeSlideIn(delay: const Duration(milliseconds: 80), child: Semantics(header: true, child: Text(l.accLetsGetStarted, textAlign: TextAlign.center, style: AnbessaType.display.copyWith(color: c.text)))),
                        const SizedBox(height: 12),
                        FadeSlideIn(delay: const Duration(milliseconds: 160), child: Text(l.accLetsGetStartedLede, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2, fontWeight: FontWeight.w400))),
                        const SizedBox(height: 28),
                        if (reason == SignOutReason.sessionEnded) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.errorSessionEnded, tone: NoticeTone.info)),
                        if (reason == SignOutReason.suspended) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.errorSuspended, tone: NoticeTone.error)),
                        if (Env.devLoginOn)
                          Theme(
                            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                            child: ExpansionTile(
                              tilePadding: EdgeInsets.zero,
                              title: Text(l.devSignInTitle, style: AnbessaType.body2.copyWith(color: c.muted)),
                              children: const [DevSignInPanel()],
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            // the ways in stay pinned to the bottom, whatever the text size
            Padding(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FadeSlideIn(delay: const Duration(milliseconds: 240), child: PillButton(label: l.accSignUp, onPressed: () => context.push('${Routes.signIn}?new=1'))),
                  const SizedBox(height: 14),
                  FadeSlideIn(delay: const Duration(milliseconds: 300), child: PillButton(label: l.accSignIn, variant: PillVariant.tonal, onPressed: () => context.push(Routes.signIn))),
                  const SizedBox(height: 4),
                  TextButton.icon(onPressed: () => context.push('${Routes.signIn}?driver=1'), icon: const Icon(Icons.directions_car_rounded, size: 20), label: Text(l.driveWithAnbessa)),
                  const _LegalFooter(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Privacy Policy · Terms of Service, small and grey.
class _LegalFooter extends StatelessWidget {
  const _LegalFooter();
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final style = AnbessaType.caption.copyWith(fontSize: 12, color: c.muted);
    Widget link(String label, String path) => InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: () => openLegal(path),
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8), child: Text(label, style: style)),
        );
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [link(l.accPrivacyPolicy, 'privacy'), ExcludeSemantics(child: Text('·', style: style)), link(l.accTermsOfService, 'terms')],
    );
  }
}

/// Opens the privacy policy or the terms on the web.
Future<void> openLegal(String path) => launchUrl(Uri.parse('https://${Env.appLinkHost}/$path'), mode: LaunchMode.externalApplication);

/// The kit's sign up / sign in by phone (pp. 20–21): ← only, the big title, a line, "Phone
/// Number" with the 🇪🇹 +251 prefix, the terms checkbox when signing up, "Already have an account?
/// Sign in" (or the other way round), the main button pinned to the bottom.
class PhoneScreen extends ConsumerStatefulWidget {
  const PhoneScreen({super.key, this.driver = false, this.signUp = false});
  final bool driver;
  /// "Join Anbessa Today" with the terms; otherwise "Welcome Back!"
  final bool signUp;
  @override
  ConsumerState<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends ConsumerState<PhoneScreen> {
  final _ctrl = TextEditingController();
  Object? _error;
  bool _busy = false;
  bool _agreed = false;
  int _shake = 0;

  String get _digits => _ctrl.text.replaceAll(RegExp(r'\D'), '');
  bool get _plausible => toE164(_ctrl.text) != null || toE164('0$_digits') != null;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

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

  void _switch() {
    final q = [if (!widget.signUp) 'new=1', if (widget.driver) 'driver=1'];
    context.pushReplacement(q.isEmpty ? Routes.signIn : '${Routes.signIn}?${q.join('&')}');
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final signUp = widget.signUp;
    final linkStyle = AnbessaType.body.copyWith(color: c.accentText, fontWeight: FontWeight.w700);
    return Scaffold(
      appBar: const AppTopBar(),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 16),
              children: [
                Semantics(header: true, child: Text(signUp ? l.accJoinTitle : l.accWelcomeBackTitle, style: AnbessaType.display.copyWith(color: c.text))),
                const SizedBox(height: 12),
                Text(signUp ? l.accJoinLede : l.accWelcomeBackLede, style: AnbessaType.body.copyWith(color: c.text2, fontWeight: FontWeight.w400)),
                const SizedBox(height: 28),
                Shake(
                  trigger: _shake == 0 ? null : _shake,
                  child: FilledField.phone(
                    label: l.phoneLabel,
                    dialCode: '+251',
                    flag: const ExcludeSemantics(child: Text('🇪🇹', style: TextStyle(fontSize: 20))),
                    controller: _ctrl,
                    autofocus: true,
                    hint: '9 12 345 678',
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d\s+]')), LengthLimitingTextInputFormatter(16)],
                    textInputAction: TextInputAction.done,
                    style: AnbessaType.body.copyWith(fontFeatures: AnbessaType.tabular),
                    onChanged: (_) => setState(() {}),
                    onSubmitted: (_) => _plausible && (!signUp || _agreed) ? _send() : null,
                  ),
                ),
                const SizedBox(height: 10),
                Text(l.phoneLede, style: AnbessaType.caption.copyWith(color: c.muted)),
                if (signUp) ...[
                  const SizedBox(height: 14),
                  MergeSemantics(
                    child: Row(
                      children: [
                        SizedBox(width: 32, height: 32, child: Checkbox(value: _agreed, onChanged: (v) => setState(() => _agreed = v ?? false))),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              GestureDetector(onTap: () => setState(() => _agreed = !_agreed), child: Text('${l.accAgreeTo} ', style: AnbessaType.body.copyWith(color: c.text))),
                              GestureDetector(onTap: () => openLegal('terms'), child: Text(l.accTermsAndConditions, style: linkStyle)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                Wrap(
                  alignment: WrapAlignment.center,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(signUp ? l.accHaveAccount : l.accNoAccount, style: AnbessaType.body.copyWith(color: c.text2)),
                    TextButton(onPressed: _switch, style: TextButton.styleFrom(visualDensity: VisualDensity.compact), child: Text(signUp ? l.accSignIn : l.accSignUp, style: linkStyle)),
                  ],
                ),
                const SizedBox(height: 8),
                Problem(_error, describe: (e) => describeError(l, e)),
              ],
            ),
          ),
          BottomActionBar(
            child: PillButton(label: signUp ? l.accSignUp : l.accSignIn, busy: _busy, onPressed: _plausible && (!signUp || _agreed) ? _send : null),
          ),
        ],
      ),
    );
  }
}

/// The kit's OTP page (p. 22): "Enter OTP Code 🔐", where the code went, the boxes, "You can
/// resend the code in 56 seconds", "Resend code". The system keyboard types the digits.
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
    final body = AnbessaType.body.copyWith(color: c.text2, fontWeight: FontWeight.w400);
    // "You can resend the code in 56 seconds" with the number in amber
    final countdown = l.accResendIn(_resendIn);
    final n = '$_resendIn';
    final at = countdown.indexOf(n);
    return Scaffold(
      appBar: const AppTopBar(),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
        children: [
          Semantics(header: true, child: Text(l.accOtpTitle, style: AnbessaType.display.copyWith(color: c.text))),
          const SizedBox(height: 12),
          Text(l.accOtpLede(formatPhone(widget.phone)), style: body),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(onPressed: () => context.pop(), style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact), child: Text(l.changeNumber)),
          ),
          const SizedBox(height: 16),
          Shake(
            trigger: _shake == 0 ? null : _shake,
            child: LayoutBuilder(
              builder: (context, box) => Center(
                child: PinBoxes(length: 6, controller: _ctrl, error: _wrong, enabled: !_busy, onCompleted: _verify, size: ((box.maxWidth - 5 * 8) / 6).clamp(36.0, 56.0)),
              ),
            ),
          ),
          const SizedBox(height: 28),
          if (_busy) const Padding(padding: EdgeInsets.only(bottom: 16), child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5)))),
          if (_elapsed >= 20 && !_busy) Padding(padding: const EdgeInsets.only(bottom: 12), child: Notice(l.sentBySmsToo, tone: NoticeTone.info)),
          Problem(_error, describe: (e) => describeError(l, e)),
          if (_resendIn > 0)
            Text.rich(
              TextSpan(children: [
                TextSpan(text: at < 0 ? countdown : countdown.substring(0, at)),
                if (at >= 0) TextSpan(text: n, style: TextStyle(color: c.accentText, fontWeight: FontWeight.w700, fontFeatures: AnbessaType.tabular)),
                if (at >= 0) TextSpan(text: countdown.substring(at + n.length)),
              ]),
              textAlign: TextAlign.center,
              style: body,
            ),
          const SizedBox(height: 8),
          Center(
            child: TextButton(
              onPressed: _resendIn > 0 ? null : _resend,
              style: TextButton.styleFrom(disabledForegroundColor: c.muted),
              child: Text(l.accResendCode),
            ),
          ),
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

/// Ride or drive: two selectable cards (the kit's selection style) and Continue.
class ModeSwitcherScreen extends ConsumerStatefulWidget {
  const ModeSwitcherScreen({super.key});
  @override
  ConsumerState<ModeSwitcherScreen> createState() => _ModeSwitcherScreenState();
}

class _ModeSwitcherScreenState extends ConsumerState<ModeSwitcherScreen> {
  AppMode _mode = AppMode.rider;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    Widget option(int i, IconData icon, String title, String lede, AppMode mode) {
      final on = _mode == mode;
      return FadeSlideIn(
        delay: Duration(milliseconds: 80 * i),
        child: SelectableCard(
          selected: on,
          onTap: () => setState(() => _mode = mode),
          child: Row(
            children: [
              CircleIcon(icon, size: 52, color: on ? c.onAccent : c.text, fill: on ? c.accent : null, borderColor: on ? c.accent : null),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [Text(title, style: AnbessaType.h2.copyWith(color: c.text)), const SizedBox(height: 4), Text(lede, style: AnbessaType.body2.copyWith(color: c.muted))],
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 32, AnbessaSpace.page, 16),
                children: [
                  const Center(child: AnbessaLogo(size: 56)),
                  const SizedBox(height: 28),
                  Semantics(header: true, child: Text(l.chooseModeTitle, textAlign: TextAlign.center, style: AnbessaType.display.copyWith(color: c.text))),
                  const SizedBox(height: 28),
                  option(0, Icons.hail_rounded, l.rideTitle, l.rideLede, AppMode.rider),
                  const SizedBox(height: 14),
                  option(1, Icons.directions_car_rounded, l.driveTitle, l.driveLede, AppMode.driver),
                ],
              ),
            ),
            BottomActionBar(
              child: PillButton(
                label: l.accContinue,
                onPressed: () {
                  Haptics.medium();
                  ref.read(modeProvider.notifier).set(_mode);
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
