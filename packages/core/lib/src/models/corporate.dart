// trip-service company ride policies (workflow 11, `trips/corporate.ts`): what trips billed to a
// company may be. Anyone who may bill the company reads the rules they book under; a trip that
// breaks one is refused with 422 `policy_violation` and the rule's name.

import 'package:meta/meta.dart';
import 'json.dart';

/// The rules `AppError.rule` can name.
abstract final class PolicyRule {
  static const vehicleType = 'vehicle_type';
  static const day = 'day';
  static const hours = 'hours';
  static const maxFare = 'max_fare';
  static const monthlyBudget = 'monthly_budget';
  static const purpose = 'purpose';
}

/// GET /api/trips/corporate/:orgId/policy
@immutable
class CorporatePolicy {
  const CorporatePolicy({
    required this.orgId,
    this.allowedVehicleTypes = const [],
    this.allowedDays = const [],
    this.startMinute,
    this.endMinute,
    this.maxFareMinor,
    this.monthlyBudgetMinor,
    this.requirePurpose = false,
    this.configured = false,
    this.spentThisMonthMinor = 0,
  });
  final String orgId;
  /// empty = any
  final List<String> allowedVehicleTypes;
  /// 0 = Sunday … 6 = Saturday, Addis time; empty = any
  final List<int> allowedDays;
  /// minutes after midnight, Addis time; both null = any time
  final int? startMinute;
  final int? endMinute;
  final int? maxFareMinor;
  final int? monthlyBudgetMinor;
  /// a trip purpose or cost centre must be sent with every ride billed to the company
  final bool requirePurpose;
  /// false until an admin saves a policy
  final bool configured;
  final int spentThisMonthMinor;

  factory CorporatePolicy.fromJson(Json j) => CorporatePolicy(
        orgId: str(j, 'orgId'),
        allowedVehicleTypes: strList(j, 'allowedVehicleTypes'),
        allowedDays: j['allowedDays'] is List ? (j['allowedDays'] as List).whereType<num>().map((n) => n.toInt()).toList(growable: false) : const [],
        startMinute: intOrNull(j, 'startMinute'),
        endMinute: intOrNull(j, 'endMinute'),
        maxFareMinor: intOrNull(j, 'maxFareMinor'),
        monthlyBudgetMinor: intOrNull(j, 'monthlyBudgetMinor'),
        requirePurpose: readBool(j, 'requirePurpose'),
        configured: readBool(j, 'configured'),
        spentThisMonthMinor: readInt(j, 'spentThisMonthMinor', 0),
      );
}
