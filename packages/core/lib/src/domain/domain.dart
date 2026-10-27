// Pure logic shared by screens: what stage a trip is in for each side, versions, phone numbers,
// money and time formatting. No I/O, fully unit-tested.

import 'dart:math' as math;

import 'package:intl/intl.dart';
import '../models/trip.dart';

// ── trip stage ────────────────────────────────────────────────────────────────

/// What the rider sees (workflows 05–08). Derived from the trip, never stored.
enum RiderStage { finding, driverAssigned, driverArrived, inTrip, completed, cancelled, unknown }

RiderStage riderStageOf(Trip t) => switch (t.status) {
      TripStatus.requested => RiderStage.finding,
      TripStatus.matched => RiderStage.driverAssigned,
      TripStatus.enRoute => t.hasArrived ? RiderStage.driverArrived : RiderStage.driverAssigned,
      TripStatus.inProgress => RiderStage.inTrip,
      TripStatus.completed => RiderStage.completed,
      TripStatus.cancelled => RiderStage.cancelled,
      TripStatus.unknown => RiderStage.unknown,
    };

/// What the driver sees (workflow 06).
enum DriverStage { accepted, toPickup, waitingAtPickup, inTrip, completed, cancelled, unknown }

DriverStage driverStageOf(Trip t) => switch (t.status) {
      TripStatus.matched => DriverStage.accepted,
      TripStatus.enRoute => t.hasArrived ? DriverStage.waitingAtPickup : DriverStage.toPickup,
      TripStatus.inProgress => DriverStage.inTrip,
      TripStatus.completed => DriverStage.completed,
      TripStatus.cancelled => DriverStage.cancelled,
      _ => DriverStage.unknown,
    };

/// Rider cancellations are free within the free window after a driver accepted (workflow 07).
bool riderCancelIsFree(Trip t, DateTime now, {Duration freeWindow = const Duration(minutes: 2)}) {
  if (t.status == TripStatus.requested) return true;
  final matched = t.times.matchedAt;
  if (matched == null) return true;
  return now.difference(matched) <= freeWindow;
}

/// Waiting time at the pickup, from arrival (workflow 06: free for 3 min by default).
Duration waitingAtPickup(Trip t, DateTime now) {
  final a = t.times.arrivedAt;
  if (a == null) return Duration.zero;
  final end = t.times.startedAt ?? now;
  final d = end.difference(a);
  return d.isNegative ? Duration.zero : d;
}

// ── versions ──────────────────────────────────────────────────────────────────

/// semver compare of "1.4.0" style versions: negative when a < b.
int compareVersions(String a, String b) {
  List<int> parts(String v) => v.split('+').first.split('-').first.split('.').map((p) => int.tryParse(p) ?? 0).toList();
  final pa = parts(a);
  final pb = parts(b);
  for (var i = 0; i < math.max(pa.length, pb.length); i++) {
    final x = i < pa.length ? pa[i] : 0;
    final y = i < pb.length ? pb[i] : 0;
    if (x != y) return x.compareTo(y);
  }
  return 0;
}

bool isBelowMinimum(String current, String? minimum) => minimum != null && minimum.isNotEmpty && compareVersions(current, minimum) < 0;

// ── phone numbers ─────────────────────────────────────────────────────────────

/// Ethiopian mobile in E.164 from what people type: 0911…, 911…, +251911…; null when it isn't one.
String? toE164(String input) {
  final digits = input.replaceAll(RegExp(r'[^\d+]'), '');
  final m = RegExp(r'^(?:\+?251|0)?([79]\d{8})$').firstMatch(digits);
  return m == null ? null : '+251${m.group(1)}';
}

/// +251911223344 → +251 91 122 3344
String formatPhone(String? e164) {
  if (e164 == null || e164.isEmpty) return '—';
  final m = RegExp(r'^\+251(\d{2})(\d{3})(\d{4})$').firstMatch(e164);
  return m == null ? e164 : '+251 ${m.group(1)} ${m.group(2)} ${m.group(3)}';
}

/// Phone-only accounts carry a placeholder address derived from the number (Auth.md §17).
bool isPlaceholderName(String name) => RegExp(r'^\+?\d{9,15}$').hasMatch(name.trim());

// ── money ─────────────────────────────────────────────────────────────────────

/// Santim → "1,234.50 ETB" / "400 ETB" (whole birr shown without decimals). Amharic shows "ብር".
String birr(int? minor, {String locale = 'en', bool withUnit = true}) {
  if (minor == null) return '—';
  final v = minor / 100;
  final whole = minor % 100 == 0;
  final f = NumberFormat.decimalPatternDigits(locale: 'en', decimalDigits: whole ? 0 : 2);
  final n = f.format(v.abs());
  final unit = locale.startsWith('am') ? 'ብር' : 'ETB';
  return '${minor < 0 ? '−' : ''}$n${withUnit ? ' $unit' : ''}';
}

/// Birr typed by a person → santim; null when it isn't a positive amount.
int? toMinor(String input) {
  final v = double.tryParse(input.replaceAll(RegExp(r'[\s,]'), ''));
  if (v == null || !v.isFinite || v <= 0) return null;
  return (v * 100).round();
}

// ── time (Addis Ababa, UTC+3, no daylight saving) ─────────────────────────────

const addisOffset = Duration(hours: 3);

DateTime toAddis(DateTime utc) => utc.toUtc().add(addisOffset);

const _monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Gregorian month names in Amharic (the Ethiopian calendar is out of scope for v1).
const _monthsAm = ['ጃንዩ', 'ፌብሩ', 'ማርች', 'ኤፕሪ', 'ሜይ', 'ጁን', 'ጁላይ', 'ኦገስ', 'ሴፕቴ', 'ኦክቶ', 'ኖቬም', 'ዲሴም'];

String _month(int m, String locale) => (locale.startsWith('am') ? _monthsAm : _monthsEn)[m - 1];
String _two(int n) => n.toString().padLeft(2, '0');

/// "14:05"
String clockOf(DateTime? at) {
  if (at == null) return '—';
  final a = toAddis(at);
  return '${_two(a.hour)}:${_two(a.minute)}';
}

/// "26 Oct, 14:05"
String dayAndTime(DateTime? at, {String locale = 'en'}) {
  if (at == null) return '—';
  final a = toAddis(at);
  return '${a.day} ${_month(a.month, locale)}, ${_two(a.hour)}:${_two(a.minute)}';
}

/// "26 Oct 2026"
String dayOf(DateTime? at, {String locale = 'en'}) {
  if (at == null) return '—';
  final a = toAddis(at);
  return '${a.day} ${_month(a.month, locale)} ${a.year}';
}

/// "just now", "4 min", "1 h 05": how long ago.
String since(DateTime? at, DateTime now) {
  if (at == null) return '—';
  final s = math.max(0, now.difference(at).inSeconds);
  if (s < 45) return 'just now';
  final m = (s / 60).round();
  if (m < 60) return '$m min';
  return '${m ~/ 60} h ${(m % 60).toString().padLeft(2, '0')}';
}

/// "3:45" for timers.
String mmss(Duration d) => '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

/// "12 min", "1 h 05"
String minutesOf(int? seconds) {
  if (seconds == null) return '—';
  final m = (seconds / 60).round();
  if (m < 1) return '< 1 min';
  if (m < 60) return '$m min';
  return '${m ~/ 60} h ${(m % 60).toString().padLeft(2, '0')}';
}

/// "5.2 km"
String km(int? meters) => meters == null ? '—' : '${(meters / 1000).toStringAsFixed(meters < 10_000 ? 1 : 0)} km';

/// A distance as people say it: "850 m" under a kilometre (rounded to 10 m, "< 50 m" very
/// close), "2.4 km" up to 10 km, "14 km" beyond.
String formatDistance(double meters) {
  if (meters.isNaN || meters < 0) return '—';
  if (meters < 50) return '< 50 m';
  if (meters < 995) return '${((meters / 10).round() * 10)} m';
  final k = meters / 1000;
  return k < 9.95 ? '${k.toStringAsFixed(1)} km' : '${k.round()} km';
}

/// Short id for receipts and support: the last 6 characters, upper case.
String shortId(String id) => id.replaceAll('-', '').toUpperCase().let((s) => s.length > 6 ? s.substring(s.length - 6) : s);

/// Great-circle distance in metres.
double haversineMeters(double lat1, double lng1, double lat2, double lng2) {
  const r = 6371000.0;
  final dLat = _rad(lat2 - lat1);
  final dLng = _rad(lng2 - lng1);
  final a = math.sin(dLat / 2) * math.sin(dLat / 2) + math.cos(_rad(lat1)) * math.cos(_rad(lat2)) * math.sin(dLng / 2) * math.sin(dLng / 2);
  return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a));
}

double _rad(double deg) => deg * math.pi / 180;

/// Bearing from one point to another, degrees clockwise from north.
double bearingDegrees(double lat1, double lng1, double lat2, double lng2) {
  final y = math.sin(_rad(lng2 - lng1)) * math.cos(_rad(lat2));
  final x = math.cos(_rad(lat1)) * math.sin(_rad(lat2)) - math.sin(_rad(lat1)) * math.cos(_rad(lat2)) * math.cos(_rad(lng2 - lng1));
  return (math.atan2(y, x) * 180 / math.pi + 360) % 360;
}

extension Let<T> on T {
  R let<R>(R Function(T it) f) => f(this);
}
