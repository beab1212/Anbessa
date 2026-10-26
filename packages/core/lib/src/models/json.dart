// Tolerant JSON reading for the API mirrors. Services send ISO 8601 strings, numbers that may
// arrive as int or double, and nulls; a missing field never throws for optional values.

typedef Json = Map<String, dynamic>;

Json asJson(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

List<Json> asJsonList(Object? v) => v is List ? v.map(asJson).toList(growable: false) : const [];

String str(Json j, String key, [String fallback = '']) => j[key] is String ? j[key] as String : fallback;

String? strOrNull(Json j, String key) => j[key] is String ? j[key] as String : null;

int readInt(Json j, String key, [int fallback = 0]) => j[key] is num ? (j[key] as num).toInt() : fallback;

int? intOrNull(Json j, String key) => j[key] is num ? (j[key] as num).toInt() : null;

double readDouble(Json j, String key, [double fallback = 0]) => j[key] is num ? (j[key] as num).toDouble() : fallback;

double? doubleOrNull(Json j, String key) => j[key] is num ? (j[key] as num).toDouble() : null;

bool readBool(Json j, String key, [bool fallback = false]) => j[key] is bool ? j[key] as bool : fallback;

DateTime? dateOrNull(Json j, String key) {
  final v = j[key];
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v)?.toUtc();
  if (v is num) return DateTime.fromMillisecondsSinceEpoch(v.toInt(), isUtc: true);
  return null;
}

DateTime readDate(Json j, String key) => dateOrNull(j, key) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

List<String> strList(Json j, String key) => j[key] is List ? (j[key] as List).whereType<String>().toList(growable: false) : const [];

/// Enum lookup by the API's name; unknown values map to [unknown] so a newer backend never crashes
/// an older app (a future `scheduled` trip status, a new balance state, …).
T enumFrom<T extends Enum>(List<T> values, String? raw, T unknown, {String Function(T)? apiName}) {
  if (raw == null) return unknown;
  for (final v in values) {
    if ((apiName?.call(v) ?? v.name) == raw) return v;
  }
  return unknown;
}

/// snake_case ↔ camelCase for the enums that use API names like `en_route`.
String snakeOf(String camel) => camel.replaceAllMapped(RegExp('[A-Z]'), (m) => '_${m[0]!.toLowerCase()}');
