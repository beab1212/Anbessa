// Three pages on first launch (the kit's onboarding, pp. 16–18): an amber top with a phone
// showing the app, a white panel with a curved top edge, the title, the text, page dots, and
// Skip | Continue (the last page: "Let's Get Started"). Seen once.
//
// The phone's screens are drawn here with our own widgets (a painted city map with cars and the
// rider's pin, the payment choices, a driver's online card), not taken from the kit.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
  void initState() {
    super.initState();
    // follow the controller (not only onPageChanged) so the last page's button shows as soon as
    // the page lands, however it got there
    _page.addListener(() {
      final i = _page.hasClients ? (_page.page ?? 0).round() : 0;
      if (i != _index) {
        Haptics.selection();
        setState(() => _index = i);
      }
    });
  }

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
      (_PhoneScene.map, l.introTitle1, l.introBody1),
      (_PhoneScene.pay, l.introTitle2, l.introBody2),
      (_PhoneScene.drive, l.introTitle3, l.introBody3),
    ];
    final last = _index == pages.length - 1;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(statusBarColor: Colors.transparent),
      child: Scaffold(
        backgroundColor: c.page,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: PageView.builder(
                controller: _page,
                itemCount: pages.length,
                itemBuilder: (_, i) {
                  final (scene, title, body) = pages[i];
                  return _IntroPage(scene: scene, title: title, body: body);
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 20),
              child: Center(
                child: SmoothPageIndicator(
                controller: _page,
                count: pages.length,
                onDotClicked: (i) => _page.animateToPage(i, duration: AnbessaMotion.slow, curve: AnbessaMotion.emphasized),
                  effect: ExpandingDotsEffect(activeDotColor: c.accent, dotColor: c.borderStrong, dotHeight: 7, dotWidth: 7, expansionFactor: 4, spacing: 6),
                ),
              ),
            ),
            BottomActionBar(
              child: AnimatedSwitcher(
                duration: AnbessaMotion.of(context, AnbessaMotion.base),
                child: last
                    ? PillButton(key: const ValueKey('start'), label: l.accGetStarted, expand: true, onPressed: _done)
                    : PillButtonPair(
                        key: const ValueKey('pair'),
                        first: PillButton(label: l.introSkip, variant: PillVariant.tonal, onPressed: _done),
                        second: PillButton(label: l.accContinue, onPressed: () => _page.nextPage(duration: AnbessaMotion.slow, curve: AnbessaMotion.emphasized)),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _IntroPage extends StatelessWidget {
  const _IntroPage({required this.scene, required this.title, required this.body});
  final _PhoneScene scene;
  final String title;
  final String body;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final top = MediaQuery.paddingOf(context).top;
    return LayoutBuilder(builder: (context, box) {
      // the amber part takes a bit more than half the page; the text panel scrolls on small
      // phones with large text instead of overflowing
      final heroH = math.max(260.0, box.maxHeight * 0.56);
      const curve = 34.0;
      return SingleChildScrollView(
        physics: const ClampingScrollPhysics(),
        child: Column(
          children: [
            SizedBox(
              height: heroH,
              child: Stack(
                clipBehavior: Clip.hardEdge,
                children: [
                  Positioned.fill(child: ColoredBox(color: c.accent)),
                  Positioned(
                    top: top + 18,
                    left: 0,
                    right: 0,
                    child: Center(child: ExcludeSemantics(child: _PhoneFrame(width: math.min(box.maxWidth * 0.8, 340), scene: scene))),
                  ),
                  // the panel's curved top edge, over the phone's lower part
                  Positioned(left: 0, right: 0, bottom: -1, height: curve + 1, child: CustomPaint(painter: _PanelEdgePainter(c.page))),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page + 4, 8, AnbessaSpace.page + 4, 16),
              child: Column(
                children: [
                  Semantics(header: true, child: Text(title, textAlign: TextAlign.center, style: AnbessaType.display.copyWith(color: c.text))),
                  const SizedBox(height: 14),
                  Text(body, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2, fontWeight: FontWeight.w400)),
                ],
              ),
            ),
          ],
        ),
      );
    });
  }
}

/// The page-coloured panel's top: higher at the sides, dipping in the middle (as the kit).
class _PanelEdgePainter extends CustomPainter {
  _PanelEdgePainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final p = Path()
      ..moveTo(0, 0)
      ..quadraticBezierTo(size.width / 2, size.height * 2, size.width, 0)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(p, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_PanelEdgePainter old) => old.color != color;
}

enum _PhoneScene { map, pay, drive }

/// A phone: a dark rounded body, a thin bezel, the island, and a screen drawn at a fixed design
/// size and scaled to [width] (so it looks the same on every phone).
class _PhoneFrame extends StatelessWidget {
  const _PhoneFrame({required this.width, required this.scene});
  final double width;
  final _PhoneScene scene;
  static const _designW = 300.0;
  static const _designH = 560.0;
  @override
  Widget build(BuildContext context) {
    final scale = width / (_designW + 20);
    return SizedBox(
      width: width,
      height: (_designH + 20) * scale,
      child: FittedBox(
        fit: BoxFit.contain,
        alignment: Alignment.topCenter,
        child: Container(
          width: _designW + 20,
          height: _designH + 20,
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: const Color(0xFF17191D),
            borderRadius: BorderRadius.circular(52),
            border: Border.all(color: const Color(0xFF3B4048), width: 2),
            boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 24, offset: Offset(0, 10))],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(42),
            child: Stack(
              children: [
                Positioned.fill(
                  child: _lightScreen(switch (scene) {
                    _PhoneScene.map => const _MapScene(),
                    _PhoneScene.pay => const _PayScene(),
                    _PhoneScene.drive => const _DriveScene(),
                  }),
                ),
                // the status bar and the island
                Positioned(top: 10, left: 26, child: Text('9:41', style: AnbessaType.label.copyWith(color: const Color(0xFF17191D), fontWeight: FontWeight.w700))),
                const Positioned(top: 12, right: 24, child: Row(children: [Icon(Icons.signal_cellular_alt_rounded, size: 13, color: Color(0xFF17191D)), SizedBox(width: 3), Icon(Icons.wifi_rounded, size: 13, color: Color(0xFF17191D)), SizedBox(width: 3), Icon(Icons.battery_full_rounded, size: 13, color: Color(0xFF17191D))])),
                Positioned(
                  top: 8,
                  left: 0,
                  right: 0,
                  child: Center(child: Container(width: 92, height: 24, decoration: BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(14)))),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A light city map (always light inside the phone, as the kit): blocks, avenues, a park, a
/// river, our top-down cars and the rider's pin.
class _MapScene extends StatelessWidget {
  const _MapScene({this.route = false});
  final bool route;
  static const cars = [(0.18, 0.22, 30.0), (0.62, 0.17, 120.0), (0.82, 0.34, 210.0), (0.30, 0.47, 300.0), (0.74, 0.58, 30.0), (0.14, 0.70, 120.0), (0.52, 0.80, 210.0), (0.86, 0.80, 300.0)];
  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final w = box.maxWidth;
      final h = box.maxHeight;
      return Stack(
        children: [
          Positioned.fill(child: CustomPaint(painter: _CityMapPainter(route: route))),
          if (!route)
            for (final (x, y, heading) in cars) Positioned(left: x * w - 11, top: y * h - 22, child: TopDownCar(width: 22, heading: heading)),
          if (route) ...[
            Positioned(left: 0.22 * w - 26, top: 0.42 * h - 63, child: const MapAvatarPin(name: 'Abebe Kebede', diameter: 46)),
            Positioned(left: 0.72 * w - 18, top: 0.68 * h - 45, child: const DestinationPin(diameter: 36)),
            Positioned(left: 0.44 * w - 11, top: 0.52 * h - 22, child: const TopDownCar(width: 22, heading: 140)),
          ] else
            Positioned(left: 0.50 * w - 30, top: 0.56 * h - 73, child: const MapAvatarPin(name: 'Abebe Kebede', diameter: 60)),
        ],
      );
    });
  }
}

class _CityMapPainter extends CustomPainter {
  _CityMapPainter({this.route = false});
  final bool route;
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFFF4F1EA));
    // blocks
    final block = Paint()..color = const Color(0xFFEAE5DA);
    for (var gx = 0; gx < 6; gx++) {
      for (var gy = 0; gy < 10; gy++) {
        canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(gx * w / 5 - 6 + (gy.isOdd ? 8 : 0), gy * h / 9 + 6, w / 5 - 18, h / 9 - 18), const Radius.circular(3)), block);
      }
    }
    // a park and a river
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(w * 0.36, h * 0.42, w * 0.30, h * 0.16), const Radius.circular(8)), Paint()..color = const Color(0xFFCFE8C9));
    final river = Path()
      ..moveTo(-10, h * 0.88)
      ..cubicTo(w * 0.3, h * 0.80, w * 0.6, h * 0.98, w + 10, h * 0.86);
    canvas.drawPath(river, Paint()
      ..color = const Color(0xFFBFDDF2)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 18);
    // avenues on a slant and streets
    final road = Paint()
      ..color = Colors.white
      ..strokeCap = StrokeCap.round;
    canvas.save();
    canvas.translate(w / 2, h / 2);
    canvas.rotate(-0.18);
    canvas.translate(-w / 2, -h / 2);
    for (var i = -1; i < 7; i++) {
      canvas.drawLine(Offset(i * w / 5, -40), Offset(i * w / 5, h + 40), road..strokeWidth = i == 2 ? 11 : 6);
    }
    for (var i = -1; i < 11; i++) {
      canvas.drawLine(Offset(-40, i * h / 9), Offset(w + 40, i * h / 9), road..strokeWidth = i == 4 ? 11 : 5);
    }
    canvas.restore();
    if (route) {
      final p = Path()
        ..moveTo(w * 0.22, h * 0.42)
        ..lineTo(w * 0.34, h * 0.47)
        ..lineTo(w * 0.44, h * 0.52)
        ..lineTo(w * 0.54, h * 0.58)
        ..lineTo(w * 0.60, h * 0.64)
        ..lineTo(w * 0.72, h * 0.68);
      canvas.drawPath(p, Paint()
        ..color = const Color(0xFF17191D)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 7
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round);
      canvas.drawPath(p, Paint()
        ..color = const Color(0xFFFFB300)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 4.5
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round);
    }
  }

  @override
  bool shouldRepaint(_CityMapPainter old) => old.route != route;
}

/// The light theme inside the phone whatever the app's brightness (the kit's mock-ups are light).
/// (the system text size doesn't apply inside the picture: it is drawn at a fixed design size)
Widget _lightScreen(Widget child) => Builder(
      builder: (context) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
        child: Theme(data: _light, child: Material(color: Colors.white, child: child)),
      ),
    );
final _light = anbessaTheme(brightness: Brightness.light);

/// Choosing how to pay.
class _PayScene extends StatelessWidget {
  const _PayScene();
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Builder(builder: (context) {
      final c = context.colors;
      Widget method(IconData icon, String name, String sub, bool selected) => Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: SelectableCard(
              selected: selected,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              child: Row(
                children: [
                  CircleIcon(icon, size: 40, color: selected ? c.onAccent : c.text, fill: selected ? c.accent : null, borderColor: selected ? c.accent : null),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name, style: AnbessaType.title.copyWith(fontSize: 14, color: c.text)),
                        Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(fontSize: 11, color: c.muted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 46, 16, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [Icon(Icons.arrow_back_rounded, size: 20, color: c.text), Expanded(child: Text(l.paymentPreferences, textAlign: TextAlign.center, style: AnbessaType.title.copyWith(color: c.text))), const SizedBox(width: 20)]),
            const SizedBox(height: 18),
            method(Icons.payments_rounded, l.cash, '—', false),
            method(Icons.phone_iphone_rounded, 'telebirr', '+251 9•• ••• 344', true),
            method(Icons.account_balance_rounded, 'CBE Birr', '+251 9•• ••• 344', false),
            method(Icons.credit_card_rounded, 'Visa', '•••• 4679', false),
            method(Icons.business_rounded, l.organizations, 'Anbessa Ltd.', false),
          ],
        ),
      );
    });
  }
}

/// A driver online on the map: the "Online" card with today's numbers at the top, a trip's route
/// below.
class _DriveScene extends StatelessWidget {
  const _DriveScene();
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    Widget stat(IconData icon, String value, String caption) => Expanded(
          child: Column(
            children: [
              CircleIcon(icon, size: 36),
              const SizedBox(height: 6),
              Text(value, style: AnbessaType.title.copyWith(fontSize: 14, color: c.text)),
              Text(caption, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(fontSize: 10, color: c.muted)),
            ],
          ),
        );
    return Stack(
      children: [
        const Positioned.fill(child: _MapScene(route: true)),
        Positioned(
          left: 12,
          right: 12,
          top: 44,
          child: Container(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            decoration: BoxDecoration(color: c.page, borderRadius: BorderRadius.circular(18), boxShadow: AnbessaElevation.floating(Brightness.light)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(children: [
                  Container(width: 9, height: 9, decoration: BoxDecoration(color: c.success, shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  Expanded(child: Text(l.online, style: AnbessaType.title.copyWith(fontSize: 15, color: c.text))),
                  const VehicleArt('economy', width: 64),
                ]),
                const SizedBox(height: 10),
                Row(children: [
                  stat(Icons.route_rounded, '12', l.tripsToday),
                  stat(Icons.account_balance_wallet_outlined, '1,840', 'ETB'),
                  stat(Icons.star_border_rounded, '4.9', l.accRating),
                ]),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
