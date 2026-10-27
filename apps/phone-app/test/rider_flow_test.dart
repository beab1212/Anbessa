// The rider map shell from home to choosing a ride, on a 360 dp phone with 1.3× text, in light
// and dark, English and Amharic: the home sheet (search bar, services, Home/Work, nearby chip),
// the search (results with category icons and distances, choose on the map), the choose-ride
// stage (carousel, strikethrough, "Arrive HH:MM", Request) and the routes around the shell.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
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

void main() {
  group('home', () {
    for (final b in Brightness.values) {
      testWidgets('the sheet: Where to, Now, services, Home and Work; cars nearby with the ETA (${b.name})', (tester) async {
        final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend(), brightness: b);
        expect(find.text('Where to?'), findsOneWidget);
        expect(find.text('Now'), findsOneWidget);
        expect(find.byType(ServiceTile), findsNWidgets(2)); // Ride and Places: scheduling is off
        expect(find.text('Later'), findsNothing);
        expect(find.text('Home'), findsWidgets);
        expect(find.text('Work'), findsWidgets);
        expect(find.byIcon(Icons.home_rounded), findsOneWidget);
        expect(find.text('3 cars nearby · ~4 min'), findsOneWidget);
        expect(find.byType(NavigationBar), findsOneWidget);
        // one map, following the rider, with the cars as a listenable (not a rebuild per frame)
        final map = mapOf(tester);
        expect(map.follow, FollowMode.me);
        expect(map.nearbyCars, isNotNull);
        expect(map.sheetHeight, isNotNull);
        expect(tester.takeException(), isNull);
        await endShell(tester, h);
      });
    }

    testWidgets('with scheduled rides on there is a Later service', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend(), flags: {'scheduledRides': true});
      expect(find.text('Later'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });

    testWidgets('Amharic renders the home sheet', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend(), locale: const Locale('am'));
      expect(find.text('ወዴት?'), findsOneWidget);
      expect(find.text('ጉዞ'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });

    testWidgets('Where to opens the search in the same shell, without the tab bar; back returns', (tester) async {
      final h = await pumpRiderShell(tester, at: Routes.riderHome, backend: riderBackend());
      final shell = tester.state(find.byType(RiderMapShell));
      await tester.tap(find.text('Where to?'));
      await settle(tester);
      expect(locationOf(h.router), '${Routes.riderRoute}?focus=dropoff');
      expect(find.byKey(const ValueKey('search-dropoff')), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
      expect(tester.state(find.byType(RiderMapShell)), same(shell));
      h.router.pop();
      await settle(tester);
      expect(locationOf(h.router), Routes.riderHome);
      expect(find.byType(NavigationBar), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });
  });

  group('search', () {
    testWidgets('results lead with their kind and show the distance from the pickup (dark)', (tester) async {
      final h = await pumpRiderShell(tester, at: '${Routes.riderRoute}?focus=dropoff', backend: riderBackend(), brightness: Brightness.dark);
      // the pickup defaults to where the rider is
      expect(h.container.read(bookingProvider).pickup?.name, 'Current location');
      await tester.enterText(find.byKey(const ValueKey('search-dropoff')), 'ho');
      await settle(tester);
      expect(find.text('Black Lion Hospital'), findsOneWidget);
      expect(find.byIcon(Icons.local_hospital_rounded), findsOneWidget);
      expect(find.byIcon(Icons.hotel_rounded), findsOneWidget);
      expect(find.byIcon(Icons.church_rounded), findsOneWidget);
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

    testWidgets('choose on the map: the pin card names the place, a superseded lookup is dropped, confirm picks it', (tester) async {
      final h = await pumpRiderShell(tester, at: '${Routes.riderRoute}?focus=dropoff', backend: riderBackend());
      await tapText(tester, 'Choose on the map');
      expect(find.byType(PinCard), findsOneWidget);
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

      await tapText(tester, 'Confirm drop-off');
      expect(h.container.read(bookingProvider).dropoff?.name, 'Arat Kilo');
      expect(locationOf(h.router), Routes.riderQuote);
      expect(h.container.read(pinPickerProvider).active, isFalse);
      await endShell(tester, h);
    });
  });

  group('choose ride', () {
    for (final b in Brightness.values) {
      testWidgets('the classes carousel, the struck-through fare, the callouts and Request (${b.name})', (tester) async {
        final h = await pumpRiderShell(tester, at: Routes.riderQuote, backend: riderBackend(), brightness: b, before: ready);
        expect(find.byType(VehicleClassCard), findsNWidgets(2)); // economy and comfort
        expect(find.byType(VehicleArt), findsNWidgets(2));
        // economy: 260 struck through, 210 to pay
        expect(find.byWidgetPredicate((w) => w is Text && w.data == birr(26000) && w.style?.decoration == TextDecoration.lineThrough), findsOneWidget);
        final button = tester.widget<PrimaryButton>(find.byType(PrimaryButton).last);
        expect(button.label, 'Request Economy');
        expect(button.trailing, birr(21000));
        // "4 min" at the pickup, "Arrive HH:MM" at the drop-off
        final labels = mapOf(tester).callouts.map((c) => c.label).toList();
        expect(labels, contains('4 min'));
        expect(labels.where((s) => RegExp(r'^Arrive \d\d:\d\d$').hasMatch(s)), hasLength(1));
        expect(find.byType(Countdown), findsOneWidget); // the expiry ticks in its own widget
        expect(find.byType(NavigationBar), findsNothing);
        expect(tester.takeException(), isNull);

        await tester.tap(find.byKey(const ValueKey('class-comfort')));
        await settle(tester);
        expect(tester.widget<PrimaryButton>(find.byType(PrimaryButton).last).label, 'Request Comfort');
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
    expect(HomeSheet, isNotNull);
    expect(RouteField.values, hasLength(2));
  });
}
