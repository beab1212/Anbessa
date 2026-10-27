// payment-service driver incentives (workflow 15 E, `money/incentives.ts` `mine`): "complete N
// trips between two dates, earn X". A driver sees the running and recently closed programs of
// their city with their own count of settled trips; the reward is credited when the window closes.

import 'package:meta/meta.dart';
import 'json.dart';

/// GET /api/payments/incentives/me → incentives[]
@immutable
class Incentive {
  const Incentive({
    required this.id,
    required this.name,
    required this.cityId,
    this.vehicleType,
    required this.targetTrips,
    required this.rewardMinor,
    required this.startsAt,
    required this.endsAt,
    required this.status,
    required this.trips,
    required this.awardedMinor,
  });
  final String id;
  final String name;
  final String cityId;
  /// only trips in this vehicle type count; null = any
  final String? vehicleType;
  final int targetTrips;
  final int rewardMinor;
  final DateTime startsAt;
  final DateTime endsAt;
  /// APPROVED (running or about to start) | CLOSED (counted and paid)
  final String status;
  /// the driver's settled trips in the window so far
  final int trips;
  /// what was credited to the driver for this program (after it closed)
  final int awardedMinor;

  bool get closed => status == 'CLOSED';
  bool get reached => trips >= targetTrips;
  double get progress => targetTrips <= 0 ? 1 : (trips / targetTrips).clamp(0, 1).toDouble();
  bool startsLater(DateTime now) => startsAt.isAfter(now);
  /// the window ended but the program wasn't counted yet
  bool counting(DateTime now) => !closed && !endsAt.isAfter(now);

  factory Incentive.fromJson(Json j) => Incentive(
        id: str(j, 'id'), name: str(j, 'name'), cityId: str(j, 'cityId'), vehicleType: strOrNull(j, 'vehicleType'),
        targetTrips: readInt(j, 'targetTrips'), rewardMinor: readInt(j, 'rewardMinor'), startsAt: readDate(j, 'startsAt'), endsAt: readDate(j, 'endsAt'),
        status: str(j, 'status', 'APPROVED'), trips: readInt(j, 'trips'), awardedMinor: readInt(j, 'awardedMinor'),
      );
}
