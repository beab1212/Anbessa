// The rider map shell from home to choosing a ride, in the GoRide kit's look, on a 360 dp phone
// with 1.3× text, in light and dark, English and Amharic: the home sheet ("Where to?", the
// "Enter location" field, Home/Work chips, the rider as their avatar pin, round map controls),
// "Searching your location..." and "Enable Location", the "Where do you want to go?" page
// (Recent | Suggested, results with category icons, distances and bookmarks, "Select from map"
// and its "Set destination" sheet), the choose-ride stage (route card, class rows,
// strikethrough, "Arrive HH:MM", Payment and Book) and the routes around the shell.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:phone_app/core/location/location_source.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/rider/booking/booking_controller.dart';
import 'package:phone_app/features/rider/booking/pin_picker.dart';
import 'package:phone_app/features/rider/booking/search_sheet.dart';
import 'package:phone_app/features/rider/home/rider_home_screen.dart';
import 'package:phone_app/features/rider/shell/map_intent.dart';
import 'package:phone_app/features/rider/shell/rider_map_shell.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'support/fakes.dart';
import 'support/rider_shell.dart';

const meskel = Place(name: 'Meskel Square', lat: 9.0107, lng: 38.7613);
const bole = Place(name: 'Bole International Airport', lat: 8.9779, lng: 38.7993);

/// The search results mapping-service gives for "ho": a hospital, a hotel, a school.
List<Map<String, Object?>> searchResults() => [
      {'name': 'Black Lion Hospital', 'label': 'Lideta, Addis Ababa', 'lat': 9.0205, 'lng': 38.7468, 'category': 'amenity', 'type': 'hospital'},
      {'name': 'Hilton Addis', 'label': 'Menelik II Ave', 'lat': 9.0199, 'lng': 38.7633, 'category': 'tourism', 'type': 'hotel'},
      {'name': 'Holy Trinity Cathedral', 'label': 'Arat Kilo', 'lat': 9.0300, 'lng': 38.7660, 'category': 'amenity', 'type': 'place_of_worship'},
    ];

FakeBackend riderBackend() {
  final b = FakeBackend();
  b.on('GET', '/api/locations/nearby', (_) => {
        'cars': [
          {'lat': 9.0120, 'lng': 38.7620, 'heading': 90},
          {'lat': 9.0090, 'lng': 38.7600, 'heading': 180},
          {'lat': 9.0130, 'lng': 38.7590},
        ],
        'etaSeconds': 220,
        'driversNearby': 3,
        'approximate': false,
      });
  b.on('GET', '/api/maps/search', (_) => {'results': searchResults()});
  // the address under the pin follows the latitude asked for
  b.on('GET', '/api/maps/reverse', (o) {
    final lat = double.parse('${o.queryParameters['lat']}');
    return {'name': lat > 9.02 ? 'Arat Kilo' : 'Meskel Square', 'label': 'Addis Ababa', 'lat': lat, 'lng': double.parse('${o.queryParameters['lng']}')};
  });
  b.on('GET', '/api/maps/snap', (o) => {'lat': double.parse('${o.queryParameters['lat']}'), 'lng': double.parse('${o.queryParameters['lng']}')});
  b.on('POST', '/api/pricing/estimates', (_) => fixture('estimates_promo.json'));
  return b;
}

void ready(ProviderContainer c) {
  c.read(bookingProvider.notifier).setPickup(meskel, quote: false);
  c.read(bookingProvider.notifier).setDropoff(bole, quote: false);
}

AnbessaMap mapOf(WidgetTester tester) => tester.widget<AnbessaMap>(find.byType(AnbessaMap));

const quiet = <String, Object>{'dismissed_announcements': ['01a17900-0000-7000-8000-000000000001']};

void main() {
  group('home', () {
    for (final b in Brightness.values) {
      testWidgets('the sheet: Where to, Enter location, Home and Work chips; the avatar pin and round controls (${b.name})', (tester) async {
        final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend(), brightness: b);
        expect(find.text('Where to?'), findsOneWidget);
        expect(find.text('Enter location'), findsOneWidget);
        expect(find.byType(OutlineChip), findsNWidgets(2)); // Home and Work (to set): scheduling is off
        expect(find.text('Later'), findsNothing);
        expect(find.text('Home'), findsWidgets);
        expect(find.text('Work'), findsWidgets);
        expect(find.byTooltip('Map view'), findsOneWidget); // the layers button
        expect(find.byType(NavigationBar), findsOneWidget);
        expect(find.byIcon(Icons.home_rounded), findsOneWidget); // the selected tab, filled
        // one map, following the rider drawn as their avatar, with the cars as a listenable
        final map = mapOf(tester);
        expect(map.follow, FollowMode.me);
        expect(map.meAsAvatar, isTrue);
        expect(map.person?.name, 'Abebe');
        expect(map.roundControls, isTrue);
        expect(map.nearbyCars, isNotNull);
        expect(map.nearbyLabel, '4 min');
        expect(map.sheetHeight, isNotNull);
        expect(map.sheetHeight!.value, greaterThan(0)); // the map hears the sheet from the start
        expect(tester.takeException(), isNull);
        await endShell(tester, h);
      });
    }

    testWidgets('with scheduled rides on there is a Later chip', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend(), flags: {'scheduledRides': true});
      expect(find.text('Later'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });

    testWidgets('Amharic renders the home sheet', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend(), locale: const Locale('am'));
      expect(find.text('ወዴት?'), findsOneWidget);
      expect(find.text('ቦታ ያስገቡ'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });

    testWidgets('Where to opens the search page over the same shell, without the tab bar; ✕ returns', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend());
      final shell = tester.state(find.byType(RiderMapShell));
      await tester.tap(find.byKey(const ValueKey('where-to')));
      await settle(tester);
      expect(locationOf(h.router), '${Routes.riderRoute}?focus=dropoff');
      expect(find.text('Where do you want to go?'), findsOneWidget);
      expect(find.byKey(const ValueKey('search-dropoff')), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
      expect(tester.state(find.byType(RiderMapShell)), same(shell));
      await tester.tap(find.byTooltip('Close').first);
      await settle(tester);
      expect(locationOf(h.router), Routes.riderHome);
      expect(find.byType(NavigationBar), findsOneWidget);
      expect(find.text('Where do you want to go?'), findsNothing);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });
  });

  group('locating', () {
    ProviderContainer container(Stream<DevicePosition?> fixes) {
      final c = ProviderContainer(overrides: [riderLocationProvider.overrideWith((ref) => fixes)]);
      addTearDown(c.dispose);
      return c;
    }

    test('searching until the first position; not when permission is refused', () async {
      final c = container(const Stream.empty());
      expect(c.read(riderLocatingProvider), isTrue);
      c.read(riderLocationPermissionProvider.notifier).set(LocationPermissionState.denied);
      expect(c.read(riderLocatingProvider), isFalse);
      c.read(riderLocationPermissionProvider.notifier).set(LocationPermissionState.granted);
      c.read(lastPositionProvider.notifier).set(DevicePosition(lat: 9, lng: 38.7, at: DateTime.utc(2026)));
      expect(c.read(riderLocatingProvider), isFalse);
    });

    for (final b in Brightness.values) {
      testWidgets('the sheet says so over the target dot (${b.name})', (tester) async {
        tester.view.physicalSize = const Size(360 * 3, 740 * 3);
        tester.view.devicePixelRatio = 3;
        tester.platformDispatcher.textScaleFactorTestValue = 1.3;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pumpWidget(MaterialApp(
          theme: anbessaTheme(brightness: b),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const Scaffold(body: LocatingSheet()),
        ));
        await tester.pump();
        expect(find.text('Searching your location...'), findsOneWidget);
        expect(find.byType(LocatingDot), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('search', () {
    testWidgets('results lead with their kind and show the distance from the pickup (dark)', (tester) async {
      final h = await pumpRiderShell(tester, at: '${Routes.riderRoute}?focus=dropoff', backend: riderBackend(), brightness: Brightness.dark);
      // the pickup defaults to where the rider is
      expect(h.container.read(bookingProvider).pickup?.name, 'Current location');
      expect(find.text('Where do you want to go?'), findsOneWidget);
      expect(find.text('Select from map'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('search-dropoff')), 'ho');
      await settle(tester);
      expect(find.text('Black Lion Hospital'), findsOneWidget);
      expect(find.byIcon(Icons.local_hospital_rounded), findsOneWidget);
      expect(find.byIcon(Icons.hotel_rounded), findsOneWidget);
      expect(find.byIcon(Icons.church_rounded), findsOneWidget);
      expect(find.byType(SegmentedTabs<Object>), findsNothing); // typing: one list, no tabs
      final r = searchResults().first;
      expect(find.text(formatDistance(haversineMeters(9.0107, 38.7613, r['lat']! as double, r['lng']! as double))), findsOneWidget);
      expect(tester.takeException(), isNull);

      // a pick with the pickup set: on to choosing the ride, in place of the search
      await tapText(tester, 'Black Lion Hospital');
      expect(locationOf(h.router), Routes.riderQuote);
      expect(h.container.read(bookingProvider).dropoff?.category, 'amenity');
      expect(h.router.canPop(), isFalse); // the search was replaced
      await endShell(tester, h);
    });

    testWidgets('Recent | Suggested while nothing is typed; a bookmark saves the place', (tester) async {
      final backend = riderBackend();
      final h = await pumpRiderShell(tester, at: '${Routes.riderRoute}?focus=dropoff', backend: backend, prefs: {
        'recent_places': ['Edna Mall|Bole Medhanialem|8.9964|38.7856|shop|mall'],
      });
      expect(find.text('Recent'), findsOneWidget);
      expect(find.text('Suggested'), findsOneWidget);
      expect(find.text('Edna Mall'), findsOneWidget);
      backend.on('POST', '/api/trips/places', (o) => {'id': 'p9', 'label': 'other', 'name': 'Edna Mall', 'lat': 8.9964, 'lng': 38.7856});
      await tester.tap(find.byTooltip('Save this place').first);
      await settle(tester);
      expect(backend.bodies('POST', '/api/trips/places').single['name'], 'Edna Mall');
      await tapText(tester, 'Suggested');
      expect(find.byKey(const ValueKey('recent:8.9964,38.7856,Edna Mall')), findsNothing);
      expect(find.byWidgetPredicate((w) => w is ValueKey<String> ? false : w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('common:')), findsWidgets);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });

    testWidgets('Select from map: the "Set destination" sheet names the place, a superseded lookup is dropped, Next picks it', (tester) async {
      final h = await pumpRiderShell(tester, at: '${Routes.riderRoute}?focus=dropoff', backend: riderBackend());
      await tapText(tester, 'Select from map');
      expect(find.byType(PinCard), findsOneWidget);
      expect(find.text('Set destination'), findsOneWidget);
      expect(find.text('Where do you want to go?'), findsNothing); // the page gave way to the map
      expect(mapOf(tester).sheetHeight, isNull); // the camera centre is the pin: no insets
      expect(find.text('Meskel Square'), findsWidgets);

      final pin = h.container.read(pinPickerProvider.notifier);
      pin.lift();
      await tester.pump();
      expect(h.container.read(pinPickerProvider).lifted, isTrue);
      pin.moved(const LatLng(9.0105, 38.7615)); // Meskel again…
      await tester.pump(const Duration(milliseconds: 100));
      pin.moved(const LatLng(9.0333, 38.7631)); // …then moved on before the lookup ran
      await settle(tester);
      expect(h.container.read(pinPickerProvider).place?.name, 'Arat Kilo');
      expect(find.text('Arat Kilo'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tapText(tester, 'Next');
      expect(h.container.read(bookingProvider).dropoff?.name, 'Arat Kilo');
      expect(locationOf(h.router), Routes.riderQuote);
      expect(h.container.read(pinPickerProvider).active, isFalse);
      await endShell(tester, h);
    });
  });

  group('choose ride', () {
    for (final b in Brightness.values) {
      testWidgets('the route card, the class rows, the struck-through fare, the callouts and Book (${b.name})', (tester) async {
        final h = await pumpRiderShell(tester, at: Routes.riderQuote, backend: riderBackend(), brightness: b, before: ready);
        expect(find.byType(RoutePointsCard), findsOneWidget);
        expect(find.text('Bole International Airport'), findsOneWidget);
        expect(find.byType(RideClassTile), findsNWidgets(2)); // economy and comfort
        expect(find.byType(VehicleArt), findsNWidgets(2));
        expect(find.text('4 passengers'), findsWidgets);
        // economy: 260 struck through, 210 to pay
        expect(find.byWidgetPredicate((w) => w is Text && w.data == birr(26000) && w.style?.decoration == TextDecoration.lineThrough), findsOneWidget);
        final button = tester.widget<PrimaryButton>(find.byType(PrimaryButton).last);
        expect(button.label, 'Book Economy');
        expect(find.text('Payment'), findsOneWidget);
        expect(find.text('Cash'), findsOneWidget);
        // "4 min" at the pickup, "Arrive HH:MM" at the drop-off; the pickup is the rider's avatar
        final map = mapOf(tester);
        final labels = map.callouts.map((c) => c.label).toList();
        expect(labels, contains('4 min'));
        expect(labels.where((s) => RegExp(r'^Arrive \d\d:\d\d$').hasMatch(s)), hasLength(1));
        expect(map.person?.name, 'Abebe');
        expect(map.mePose, isNull);
        expect(find.byType(Countdown), findsOneWidget); // the expiry ticks in its own widget
        expect(find.byType(NavigationBar), findsNothing);
        expect(find.byTooltip('Back'), findsOneWidget);
        expect(tester.takeException(), isNull);

        await tester.tap(find.byKey(const ValueKey('class-comfort')));
        await settle(tester);
        expect(tester.widget<PrimaryButton>(find.byType(PrimaryButton).last).label, 'Book Comfort');
        await endShell(tester, h);
      });
    }

    testWidgets('the fare details fold out', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderQuote, backend: riderBackend(), before: ready);
      expect(find.text('Base fare'), findsNothing);
      await tester.ensureVisible(find.byKey(const ValueKey('fare-details')));
      await tester.tap(find.byKey(const ValueKey('fare-details')));
      await settle(tester);
      expect(find.text('Base fare'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });

    testWidgets('Choose Payment Method: our methods as cards, OK takes the chosen one', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderQuote, backend: riderBackend(), before: ready);
      await tester.ensureVisible(find.byKey(const ValueKey('payment-row')));
      await tester.tap(find.byKey(const ValueKey('payment-row')));
      await settle(tester);
      expect(find.text('Choose Payment Method'), findsOneWidget);
      expect(find.byType(SelectableCard), findsNWidgets(2)); // cash and mobile money
      await tapText(tester, 'Mobile money');
      await tapText(tester, 'OK');
      expect(h.container.read(bookingProvider).paymentMethod, PaymentMethod.mobileMoney);
      expect(find.text('Mobile money'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });
  });

  group('routes', () {
    testWidgets('an old saved-place link goes to the account picker', (tester) async {
      final h = await pumpRiderShell(tester, at: '${Routes.riderRoute}?mode=savedPlace&label=home', backend: riderBackend());
      expect(find.text('pick home'), findsOneWidget);
      await endShell(tester, h);
    });

    testWidgets('pay opens full-screen over the shell', (tester) async {
      final t = Trip.fromJson({...fixture('trip.json'), 'status': 'completed'});
      final backend = riderBackend();
      backend.on('GET', '/api/trips/${t.id}', (_) => {'trip': fixture('trip.json')..['status'] = 'completed'});
      final h = await pumpRiderShell(tester, at: Routes.riderPay(t.id), backend: backend);
      expect(find.text('Payment'), findsWidgets);
      expect(find.byType(RiderMapShell, skipOffstage: false), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });
  });

  test('the stage of a location', () {
    expect(RiderMapStage.fromUri(Uri.parse('/rider/home')).kind, RiderMapStageKind.home);
    expect(RiderMapStage.fromUri(Uri.parse('/rider/book/route?focus=pickup')), const RiderMapStage(RiderMapStageKind.search, focusPickup: true));
    expect(RiderMapStage.fromUri(Uri.parse('/rider/book/quote')).kind, RiderMapStageKind.quote);
    expect(RiderMapStage.fromUri(Uri.parse('/rider/trip/t1/pay')), const RiderMapStage(RiderMapStageKind.trip, tripId: 't1'));
    expect(sheetStopsFor(const RiderMapStage(RiderMapStageKind.search), pin: true).snaps.first, lessThan(0.5));
    // short stages are sized to their content and grow with the text
    final small = sheetStopsFor(RiderMapStage.home, pin: false, height: 700).snaps.single;
    final big = sheetStopsFor(RiderMapStage.home, pin: false, height: 700, textScale: 1.3).snaps.single;
    expect(big, greaterThan(small));
    expect(sheetStopsFor(const RiderMapStage(RiderMapStageKind.trip, tripId: 't'), pin: false, tripStage: RiderStage.driverAssigned).snaps, hasLength(2));
    expect(HomeSheet, isNotNull);
    expect(RouteField.values, hasLength(2));
  });
}
