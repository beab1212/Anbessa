// Past trips grouped by day (Addis Ababa) and filtered by period, outside the screen's build.

import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/rider/history/history_screens.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'support/fakes.dart';

Trip at(String id, DateTime requested) {
  final j = fixture('trip.json');
  return Trip.fromJson({...j, 'id': id, 'status': 'completed', 'times': {...asJson(j['times']), 'requestedAt': requested.toUtc().toIso8601String()}});
}

void main() {
  final now = DateTime.utc(2026, 10, 27, 12);
  final trips = [
    at('a', DateTime.utc(2026, 10, 27, 9)),
    at('b', DateTime.utc(2026, 10, 27, 6)),
    at('c', DateTime.utc(2026, 10, 26, 22)), // 01:00 on the 27th in Addis (UTC+3)
    at('d', DateTime.utc(2026, 10, 25, 10)),
    at('e', DateTime.utc(2026, 9, 1, 10)),
  ];

  test('one group per Addis day, in list order', () {
    final days = groupTripsByDay(trips, now: now);
    expect([for (final d in days) d.trips.map((t) => t.id).join()], ['abc', 'd', 'e']);
    expect(days.first.day, DateTime.utc(2026, 10, 27));
    expect(days.first.firstAt, trips.first.times.requestedAt);
  });

  test('the week and month filters drop older trips', () {
    expect(groupTripsByDay(trips, period: HistoryPeriod.week, now: now).expand((d) => d.trips).map((t) => t.id), ['a', 'b', 'c', 'd']);
    expect(groupTripsByDay(trips, period: HistoryPeriod.month, now: now).expand((d) => d.trips).length, 4);
    expect(groupTripsByDay(const [], now: now), isEmpty);
  });
}
