// Help, tickets, lost items and SOS against in-memory repositories: what each screen shows and
// what it sends, on a small phone with large text, in light and dark.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/location/location_source.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:phone_app/features/rider/history/history_screens.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:phone_app/features/support/lost_item_screens.dart';
import 'package:phone_app/features/support/sos_screen.dart';
import 'package:phone_app/features/support/support_repository.dart';
import 'package:phone_app/features/support/support_screens.dart';
import 'package:phone_app/features/support/support_widgets.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

class _Config extends ClientConfigController {
  @override
  Future<ClientConfig> build() async {
    final j = Map<String, dynamic>.from(fixture('client_config.json'));
    j['features'] = {...asJson(j['features']), 'sos': true, 'support': true};
    return ClientConfig.fromJson(j);
  }
}

const _driverRoles = [{'r': 'RIDER'}, {'r': 'DRIVER'}];

Trip tripAt(String status, {Duration? completedAgo}) {
  final j = Map<String, dynamic>.from(fixture('trip.json'));
  j['status'] = status;
  if (completedAgo != null) j['times'] = {...asJson(j['times']), 'completedAt': DateTime.now().toUtc().subtract(completedAgo).toIso8601String()};
  return Trip.fromJson(j);
}

/// The screens under their real paths (the same table as app_router.dart's /sos and /support).
GoRouter _router(String location) => GoRouter(
      initialLocation: location,
      routes: [
        GoRoute(path: Routes.sos, builder: (_, s) => SosScreen(tripId: s.uri.queryParameters['trip'])),
        GoRoute(path: '/receipt/:id', builder: (_, s) => ReceiptScreen(tripId: s.pathParameters['id']!, asDriver: false)),
        GoRoute(path: Routes.support, builder: (_, _) => const SupportScreen(), routes: [
          GoRoute(path: 'new', builder: (_, s) => NewTicketScreen(tripId: s.uri.queryParameters['trip'])),
          GoRoute(path: 'tickets/:id', builder: (_, s) => TicketScreen(ticketId: s.pathParameters['id']!)),
          GoRoute(path: 'lost-items', builder: (_, _) => const DriverLostItemsScreen(), routes: [
            GoRoute(path: 'report', builder: (_, s) => ReportLostItemScreen(tripId: s.uri.queryParameters['trip'] ?? '')),
            GoRoute(path: ':id', builder: (_, s) => LostItemScreen(lostItemId: s.pathParameters['id']!)),
          ]),
        ]),
      ],
    );

Future<void> pumpSupport(
  WidgetTester tester,
  String location, {
  AppMode mode = AppMode.rider,
  Brightness brightness = Brightness.light,
  FakeSupportRepository? support,
  FakeSafetyRepository? safety,
  Trip? trip,
  List<Override> overrides = const [],
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final t = trip ?? tripAt('en_route');
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      secureStoreProvider.overrideWithValue(MemorySecureStore()),
      localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
      realtimeHubProvider.overrideWithValue(fakeHub()),
      clientConfigProvider.overrideWith(_Config.new),
      sessionProvider.overrideWith(() => FixedSession(session(roles: mode == AppMode.driver ? _driverRoles : const [{'r': 'RIDER'}]))),
      modeProvider.overrideWith(() => FixedMode(mode)),
      driverHomeProvider.overrideWith(() => FixedDriverHome(DriverHome.fromJson(fixture('driver_home.json')))),
      activeTripProvider.overrideWith(() => FixedActiveTrip(t.isActive ? t : null)),
      tripProvider.overrideWith((ref, id) async => t),
      tripPartiesProvider.overrideWith((ref, id) async => const TripParties(driverName: 'Dawit Bekele')),
      tripHistoryProvider.overrideWith2((as) => _History(as, [t])),
      locationSourceProvider.overrideWithValue(FakeLocationSource(lat: 9.0107, lng: 38.7613)),
      supportRepositoryProvider.overrideWithValue(support ?? FakeSupportRepository()),
      safetyRepositoryProvider.overrideWithValue(safety ?? FakeSafetyRepository()),
      ...overrides,
    ],
    child: MaterialApp.router(
      theme: anbessaTheme(brightness: brightness),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      routerConfig: _router(location),
    ),
  ));
  await _frames(tester);
}

Future<void> _frames(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
}

class _History extends TripHistory {
  _History(super.arg, this.trips);
  final List<Trip> trips;
  @override
  Future<({List<Trip> trips, String? next})> build() async => (trips: trips, next: null);
}

/// Scroll the page's list until [f] is built and on screen (lists build lazily).
Future<void> _reveal(WidgetTester tester, Finder f) async {
  for (var i = 0; i < 30 && f.evaluate().isEmpty; i++) {
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -200));
    await tester.pump();
  }
  // centred, so nothing pinned at the list's edges (app bar, reply box) covers it
  await Scrollable.ensureVisible(tester.element(f.first), alignment: 0.5);
  await tester.pump();
}

/// Hold the SOS button for its two seconds, then let the send land.
Future<void> _holdSos(WidgetTester tester) async {
  final g = await tester.startGesture(tester.getCenter(find.byType(HoldToConfirm)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 1000));
  await tester.pump(const Duration(milliseconds: 1100));
  await g.up();
  await _frames(tester);
}

Ticket _ticket(String status, {DateTime? resolvedAt}) => Ticket.fromJson({
      ...asJson(fixture('ticket.json')['ticket']),
      'status': status,
      'resolvedAt': resolvedAt?.toIso8601String(),
    });

LostItem _lost(String role, String status) => LostItem.fromJson({...asJson(fixture('lost_item.json')['lostItem']), 'viewerRole': role, 'status': status});

void main() {
  group('help', () {
    for (final b in Brightness.values) {
      testWidgets('the list of requests and lost items (${b.name})', (tester) async {
        await pumpSupport(tester, Routes.support, brightness: b);
        expect(find.text('Contact support'), findsOneWidget);
        expect(find.text('Charged twice for one trip'), findsOneWidget);
        expect(find.text('Answered'), findsOneWidget);
        expect(find.textContaining('#1042'), findsOneWidget);
        expect(find.text('Lost items'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('nothing yet: an empty state that says how to start', (tester) async {
      await pumpSupport(tester, Routes.support, support: FakeSupportRepository(tickets: const [], lostItems: const []));
      expect(find.text('No requests yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    for (final b in Brightness.values) {
      testWidgets('a new request: category, message, send → the thread (${b.name})', (tester) async {
        final repo = FakeSupportRepository(tickets: const []);
        await pumpSupport(tester, Routes.supportNew, support: repo, brightness: b);
        await tester.tap(find.text('Payment'));
        await tester.pump();
        await _reveal(tester, find.text('Not about a trip'));
        expect(find.text('Not about a trip'), findsOneWidget);
        await _reveal(tester, find.byType(TextField));
        await tester.enterText(find.byType(TextField), 'I was charged twice for the same trip.\nReference 8CQ2X1');
        await tester.pump();
        await _reveal(tester, find.text('Send'));
        await tester.tap(find.text('Send'));
        await _frames(tester);
        expect(repo.calls.single, 'open PAYMENT trip=null city=addis-ababa as=RIDER subject=I was charged twice for the same trip.');
        expect(find.text('#2001'), findsOneWidget); // replaced by the new ticket's thread
        expect(find.text('Received'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('from a receipt: the trip is attached and the city comes from it', (tester) async {
      final t = tripAt('completed', completedAgo: const Duration(hours: 2));
      final repo = FakeSupportRepository(tickets: const []);
      await pumpSupport(tester, Routes.supportNewAbout(t.id), support: repo, trip: t);
      await _reveal(tester, find.textContaining('Piassa'));
      expect(find.textContaining('Piassa'), findsWidgets);
      await _reveal(tester, find.byType(TextField));
        await tester.enterText(find.byType(TextField), 'The driver took a long detour.');
      await tester.pump();
      await _reveal(tester, find.text('Send'));
      await tester.tap(find.text('Send'));
      await _frames(tester);
      expect(repo.calls.single, startsWith('open TRIP trip=${t.id} city=null as=null'));
    });

    testWidgets('a driver writing without a trip is sent as DRIVER', (tester) async {
      final repo = FakeSupportRepository(tickets: const []);
      await pumpSupport(tester, Routes.supportNew, support: repo, mode: AppMode.driver);
      await tester.tap(find.text('Your account'));
      await tester.pump();
      await _reveal(tester, find.byType(TextField));
        await tester.enterText(find.byType(TextField), 'My licence was renewed, how do I upload it?');
      await tester.pump();
      await _reveal(tester, find.text('Send'));
      await tester.tap(find.text('Send'));
      await _frames(tester);
      expect(repo.calls.single, contains('as=DRIVER'));
    });

    testWidgets('an answered ticket: the answer, the thread, and reopening within 7 days (dark)', (tester) async {
      final resolved = _ticket('RESOLVED', resolvedAt: DateTime.now().toUtc().subtract(const Duration(days: 1)));
      final repo = FakeSupportRepository(tickets: [resolved]);
      await pumpSupport(tester, Routes.supportTicket(resolved.id), support: repo, brightness: Brightness.dark);
      expect(find.text('Our answer'), findsOneWidget);
      expect(find.textContaining('We refunded the second charge'), findsOneWidget);
      await _reveal(tester, find.text('Thanks, we\'re checking with telebirr.'));
      expect(find.text('Thanks, we\'re checking with telebirr.'), findsOneWidget);
      expect(find.byType(ReplyComposer), findsNothing);
      await _reveal(tester, find.widgetWithText(OutlinedButton, 'Reopen'));
      await tester.tap(find.widgetWithText(OutlinedButton, 'Reopen'));
      await _frames(tester);
      await tester.enterText(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), 'Still charged twice');
      await tester.tap(find.widgetWithText(FilledButton, 'Reopen'));
      await _frames(tester);
      expect(repo.calls.single, 'reopen ${resolved.id} Still charged twice');
      expect(repo.threads[resolved.id]!.ticket.status, TicketStatus.open);
      expect(find.widgetWithText(OutlinedButton, 'Reopen'), findsNothing);
      expect(find.byType(ReplyComposer), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an answered ticket past the window: closed, start a new one', (tester) async {
      final old = _ticket('RESOLVED', resolvedAt: DateTime.now().toUtc().subtract(const Duration(days: 9)));
      await pumpSupport(tester, Routes.supportTicket(old.id), support: FakeSupportRepository(tickets: [old]));
      expect(find.widgetWithText(OutlinedButton, 'Reopen'), findsNothing);
      await _reveal(tester, find.textContaining('This request is closed'));
      expect(find.textContaining('This request is closed'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a ticket waiting for the requester: reply from the composer', (tester) async {
      final waiting = _ticket('WAITING_REQUESTER');
      final repo = FakeSupportRepository(tickets: [waiting]);
      await pumpSupport(tester, Routes.supportTicket(waiting.id), support: repo);
      expect(find.text('Waiting for you'), findsOneWidget);
      await tester.enterText(find.descendant(of: find.byType(ReplyComposer), matching: find.byType(TextField)), 'The reference is 8CQ2X1');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await _frames(tester);
      expect(repo.calls.single, 'reply ${waiting.id} The reference is 8CQ2X1');
      await _reveal(tester, find.text('The reference is 8CQ2X1'));
      expect(find.text('The reference is 8CQ2X1'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('lost items', () {
    for (final b in Brightness.values) {
      testWidgets('the rider reports from a completed trip (${b.name})', (tester) async {
        final t = tripAt('completed', completedAgo: const Duration(hours: 3));
        final repo = FakeSupportRepository(lostItems: const []);
        await pumpSupport(tester, Routes.lostItemReport(t.id), support: repo, trip: t, brightness: b);
        expect(find.text('The trip'), findsOneWidget);
        await _reveal(tester, find.byType(TextField));
        await tester.enterText(find.byType(TextField), 'A black backpack on the back seat');
        await tester.pump();
        await _reveal(tester, find.text('Send to the driver'));
        await tester.tap(find.text('Send to the driver'));
        await _frames(tester);
        expect(repo.calls.single, 'report ${t.id} A black backpack on the back seat');
        expect(find.text('Reported'), findsOneWidget);
        expect(find.textContaining("We've told your driver"), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a trip older than 7 days can no longer be reported', (tester) async {
      final t = tripAt('completed', completedAgo: const Duration(days: 8));
      await pumpSupport(tester, Routes.lostItemReport(t.id), trip: t);
      expect(find.textContaining('up to 7 days after a completed trip'), findsOneWidget);
      await _reveal(tester, find.byType(PrimaryButton));
      final button = tester.widget<PrimaryButton>(find.byType(PrimaryButton));
      expect(button.onPressed, isNull);
    });

    testWidgets('found by the driver: the rider confirms it came back', (tester) async {
      final repo = FakeSupportRepository();
      final id = repo.lostThreads.keys.single;
      await pumpSupport(tester, Routes.lostItem(id), support: repo);
      expect(find.text('Found'), findsOneWidget);
      await _reveal(tester, find.textContaining('Bole tonight'));
      expect(find.textContaining('Bole tonight'), findsWidgets);
      await _reveal(tester, find.text('I got it back'));
      await tester.tap(find.text('I got it back'));
      await _frames(tester);
      expect(repo.calls.single, 'returned $id');
      expect(repo.lostThreads[id]!.lostItem.status, LostItemStatus.returned);
      expect(find.text('I got it back'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    for (final b in Brightness.values) {
      testWidgets('the driver: the list of reports, then Found with a note (${b.name})', (tester) async {
        final reported = _lost('DRIVER', 'REPORTED');
        final repo = FakeSupportRepository(lostItems: [reported]);
        await pumpSupport(tester, Routes.lostItems, support: repo, mode: AppMode.driver, brightness: b);
        expect(find.textContaining('A black backpack'), findsOneWidget);
        expect(find.text('Reported'), findsOneWidget);
        await tester.tap(find.textContaining('A black backpack'));
        await _frames(tester);
        await _reveal(tester, find.text("It's not in the car"));
        expect(find.text('I found it'), findsOneWidget);
        await _reveal(tester, find.widgetWithText(TextField, 'Note for the rider (optional)'));
        await tester.enterText(find.widgetWithText(TextField, 'Note for the rider (optional)'), 'At Bole Medhanialem at 8');
        await _reveal(tester, find.text('I found it'));
        await tester.tap(find.text('I found it'));
        await _frames(tester);
        expect(repo.calls.single, 'answer ${reported.id} found=true note=At Bole Medhanialem at 8');
        expect(repo.lostThreads[reported.id]!.lostItem.status, LostItemStatus.found);
        expect(find.text('I found it'), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('the driver with no reports sees an empty state', (tester) async {
      await pumpSupport(tester, Routes.lostItems, support: FakeSupportRepository(lostItems: const []), mode: AppMode.driver);
      expect(find.text('No lost items reported'), findsOneWidget);
    });

    testWidgets('the receipt offers "I left something" and help with the trip', (tester) async {
      final t = tripAt('completed', completedAgo: const Duration(hours: 1));
      await pumpSupport(tester, '/receipt/${t.id}', support: FakeSupportRepository(lostItems: const []), trip: t);
      await tester.scrollUntilVisible(find.text('I left something'), 200);
      expect(find.text('Report a problem with this trip'), findsOneWidget);
      await tester.tap(find.text('I left something'));
      await _frames(tester);
      expect(find.text('What did you leave?'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('SOS', () {
    for (final b in Brightness.values) {
      testWidgets('hold two seconds: the alert goes with the trip and position, then its state is polled (${b.name})', (tester) async {
        final t = tripAt('in_progress');
        final safety = FakeSafetyRepository(statuses: [FakeSafetyRepository.alert('ACKNOWLEDGED')]);
        await pumpSupport(tester, '${Routes.sos}?trip=${t.id}', trip: t, safety: safety, brightness: b);
        expect(find.text('Call 991'), findsOneWidget);
        expect(find.text('Alert Anbessa safety'), findsWidgets);

        // a short press does nothing
        final g = await tester.startGesture(tester.getCenter(find.byType(HoldToConfirm)));
        await tester.pump(const Duration(milliseconds: 600));
        await g.up();
        await tester.pump(const Duration(milliseconds: 300));
        expect(safety.sent, isEmpty);

        await _holdSos(tester);
        expect(safety.sent.single.tripId, t.id);
        expect(safety.sent.single.lat, 9.0107);
        expect(safety.sent.single.cityId, 'addis-ababa');
        expect(find.text('Help is coming'), findsOneWidget);
        expect(find.text('Alert sent'), findsOneWidget);

        await tester.pump(sosPollEvery);
        await _frames(tester);
        expect(safety.polls, 1);
        expect(find.text('The safety team has your alert'), findsOneWidget);
        expect(find.text('Seen by the team'), findsOneWidget);
        expect(find.text('Call 991'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a driver within 30 min of drop-off can still alert; a resolved alert stops polling', (tester) async {
      final t = tripAt('completed', completedAgo: const Duration(minutes: 10));
      final safety = FakeSafetyRepository(statuses: [FakeSafetyRepository.alert('RESOLVED')]);
      await pumpSupport(tester, '${Routes.sos}?trip=${t.id}', trip: t, safety: safety, mode: AppMode.driver);
      await _holdSos(tester);
      expect(safety.sent, hasLength(1));
      await tester.pump(sosPollEvery);
      await _frames(tester);
      expect(find.text('This alert is closed'), findsOneWidget);
      await tester.pump(sosPollEvery * 2);
      expect(safety.polls, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('offline: say so, keep the police number first, retry with the same key', (tester) async {
      final t = tripAt('matched');
      final safety = FakeSafetyRepository(fail: const AppError(status: 0, code: ErrorCodes.network, message: 'offline', retryable: true));
      await pumpSupport(tester, '${Routes.sos}?trip=${t.id}', trip: t, safety: safety, brightness: Brightness.dark);
      await _holdSos(tester);
      expect(find.textContaining("We couldn't send the alert"), findsOneWidget);
      expect(find.text('Call 991'), findsOneWidget);
      safety.fail = null;
      await _reveal(tester, find.text('Send the alert again'));
      await tester.tap(find.text('Send the alert again'));
      await _frames(tester);
      expect(safety.sent, hasLength(2));
      expect(safety.sent[0].key, safety.sent[1].key);
      expect(find.text('Help is coming'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('more than 30 min after drop-off: only the police call', (tester) async {
      final t = tripAt('completed', completedAgo: const Duration(hours: 2));
      final safety = FakeSafetyRepository();
      await pumpSupport(tester, '${Routes.sos}?trip=${t.id}', trip: t, safety: safety);
      expect(find.textContaining('30 minutes after it'), findsOneWidget);
      await _holdSos(tester);
      expect(safety.sent, isEmpty);
      expect(find.text('Call 991'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
