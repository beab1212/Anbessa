// Localisation helpers: `context.l10n`, words for enums the backend sends, and an error → text
// mapping so every screen says the same thing for the same code.

import 'package:flutter/widgets.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'generated/app_localizations.dart';

export 'generated/app_localizations.dart';

extension L10nX on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);
  String get localeTag => Localizations.localeOf(this).languageCode;
}

/// What to show for an error, by its code (falls back to the backend's message).
String describeError(AppLocalizations l, Object? error) {
  if (error == null) return '';
  if (error is! AppError) return l.errorGeneric;
  return switch (error.code) {
    ErrorCodes.network => l.errorNetwork,
    ErrorCodes.timeout => l.errorTimeout,
    ErrorCodes.sessionEnded || ErrorCodes.tokenOutdated || ErrorCodes.invalidToken || ErrorCodes.unauthorized => l.errorSessionEnded,
    ErrorCodes.tokenRevoked => l.errorSuspended,
    ErrorCodes.forbidden => l.errorForbidden,
    ErrorCodes.rateLimited => l.errorRateLimited,
    ErrorCodes.maintenance => l.errorMaintenance,
    ErrorCodes.notAvailable => l.errorNotAvailable,
    ErrorCodes.activeTripExists => l.activeTripExists,
    ErrorCodes.quoteExpired || ErrorCodes.invalidQuote => l.quoteExpired,
    ErrorCodes.paymentMethodUnavailable => l.paymentMethodUnavailable,
    ErrorCodes.vehicleTypeUnavailable => l.vehicleTypeUnavailable,
    ErrorCodes.outsideServiceArea => l.outsideServiceArea,
    ErrorCodes.positionUnknown => l.positionUnknown,
    ErrorCodes.notArrived => l.notArrived,
    ErrorCodes.wrongPin => l.wrongPin,
    ErrorCodes.alreadyRated => l.alreadyRated,
    ErrorCodes.ratingClosed => l.ratingClosed,
    ErrorCodes.offerClosed => l.offerExpired,
    ErrorCodes.driverNotActive => l.denialDriverNotActive,
    ErrorCodes.documentsExpired => l.denialDocumentsExpired,
    ErrorCodes.vehicleNotVerified => l.denialVehicleNotVerified,
    ErrorCodes.vehicleInUse => l.denialVehicleInUse,
    ErrorCodes.notYourVehicle => l.denialNotYourVehicle,
    ErrorCodes.notInThisFleet => l.denialNotInThisFleet,
    ErrorCodes.notAuthorizedForVehicle => l.denialNotAuthorizedForVehicle,
    ErrorCodes.alreadyOnline => l.denialAlreadyOnline,
    ErrorCodes.balanceBlocked => l.denialBalanceBlocked,
    ErrorCodes.expiryRequired => l.expiryRequired,
    ErrorCodes.amountOutOfRange => l.amountOutOfRange,
    ErrorCodes.validation => error.issues.isNotEmpty ? error.issues.map((i) => i.message).join(' ') : error.message,
    _ => error.message.isNotEmpty ? error.message : l.errorGeneric,
  };
}

String paymentMethodLabel(AppLocalizations l, PaymentMethod m) => switch (m) {
      PaymentMethod.cash => l.cash,
      PaymentMethod.mobileMoney => l.mobileMoney,
      PaymentMethod.card => l.card,
      PaymentMethod.corporate => l.corporate,
      PaymentMethod.unknown => '—',
    };

String tripStatusLabel(AppLocalizations l, TripStatus s) => switch (s) {
      TripStatus.requested => l.statusRequested,
      TripStatus.matched => l.statusMatched,
      TripStatus.enRoute => l.statusEnRoute,
      TripStatus.inProgress => l.statusInProgress,
      TripStatus.completed => l.statusCompleted,
      TripStatus.cancelled => l.statusCancelled,
      TripStatus.unknown => '—',
    };

String documentKindLabel(AppLocalizations l, DocumentKind k) => switch (k) {
      DocumentKind.license => l.docLicense,
      DocumentKind.nationalId => l.docNationalId,
      DocumentKind.photo => l.docPhoto,
      DocumentKind.registration => l.docRegistration,
      DocumentKind.insurance => l.docInsurance,
      DocumentKind.inspection => l.docInspection,
      DocumentKind.businessLicense => l.docBusinessLicense,
      DocumentKind.tinCertificate => l.docTinCertificate,
      DocumentKind.unknown => '—',
    };

String driverStatusLabel(AppLocalizations l, DriverStatus s) => switch (s) {
      DriverStatus.applied => l.statusApplied,
      DriverStatus.pendingReview => l.statusPendingReview,
      DriverStatus.changesRequested => l.statusChangesRequested,
      DriverStatus.active => l.statusActive,
      DriverStatus.suspended => l.statusSuspended,
      DriverStatus.unknown => '—',
    };

String vehicleStatusLabel(AppLocalizations l, VehicleStatus s) => switch (s) {
      VehicleStatus.verified => l.vehicleVerified,
      VehicleStatus.pendingReview => l.vehiclePending,
      VehicleStatus.rejected => l.vehicleRejected,
      VehicleStatus.suspended => l.vehicleSuspended,
      _ => l.vehicleDraft,
    };

String offlineReasonLabel(AppLocalizations l, String? reason) => switch (reason) {
      'CONNECTION_LOST' => l.offlineReasonConnectionLost,
      'BALANCE_BLOCKED' => l.offlineReasonBalanceBlocked,
      'SUSPENDED' => l.offlineReasonSuspended,
      'VEHICLE_UNAVAILABLE' => l.offlineReasonVehicleUnavailable,
      'FLEET_SUSPENDED' => l.offlineReasonFleetSuspended,
      _ => reason ?? '',
    };

String statementKindLabel(AppLocalizations l, String kind) => switch (kind) {
      'TRIP_SETTLEMENT' => l.entryTrip,
      'CANCELLATION_FEE' => l.entryCancellationFee,
      'TOP_UP' => l.entryTopUp,
      'PAYOUT' => l.entryPayout,
      'PAYOUT_REVERSAL' => l.entryPayoutReversal,
      'REFUND' => l.entryRefund,
      'RECEIVABLE_COLLECTION' => l.entryLatePayment,
      _ => kind,
    };

String cancelReasonLabel(AppLocalizations l, CancelReason r) => switch (r) {
      CancelReason.changedPlans => l.reasonChangedPlans,
      CancelReason.driverTooFar => l.reasonDriverTooFar,
      CancelReason.driverAskedToCancel => l.reasonDriverAskedToCancel,
      CancelReason.wrongPickup => l.reasonWrongPickup,
      CancelReason.noShow => l.reasonNoShow,
      CancelReason.safety => l.reasonSafety,
      CancelReason.other => l.reasonOther,
    };

const providerLabels = {'telebirr': 'telebirr', 'cbebirr': 'CBE Birr', 'chapa': 'Chapa', 'bank': 'Bank'};
/// A turn in words, from the key `maneuverKey()` gives and the street name.
String maneuverLabel(AppLocalizations l, String key, String name) {
  final n = name.isEmpty ? l.unnamedRoad : name;
  return switch (key) {
    'depart' => l.maneuverDepart,
    'arrive' => l.maneuverArrive(n),
    'left' => l.maneuverLeft(n),
    'right' => l.maneuverRight(n),
    'slightLeft' => l.maneuverSlightLeft(n),
    'slightRight' => l.maneuverSlightRight(n),
    'sharpLeft' => l.maneuverSharpLeft(n),
    'sharpRight' => l.maneuverSharpRight(n),
    'uturn' => l.maneuverUturn,
    'roundabout' => l.maneuverRoundabout,
    'exitRoundabout' => l.maneuverExitRoundabout(n),
    'merge' => l.maneuverMerge(n),
    'onRamp' => l.maneuverOnRamp(n),
    'offRamp' => l.maneuverOffRamp(n),
    'forkLeft' => l.maneuverForkLeft,
    'forkRight' => l.maneuverForkRight,
    _ => l.maneuverStraight(n),
  };
}

/// A rating tag's words.
String ratingTagLabel(AppLocalizations l, String tag) => switch (tag) {
      'polite' => l.tag_polite,
      'safe_driving' => l.tag_safe_driving,
      'clean_car' => l.tag_clean_car,
      'on_time' => l.tag_on_time,
      'good_navigation' => l.tag_good_navigation,
      'rude' => l.tag_rude,
      'unsafe_driving' => l.tag_unsafe_driving,
      'dirty_car' => l.tag_dirty_car,
      'late' => l.tag_late,
      'took_long_route' => l.tag_took_long_route,
      'clear_pickup' => l.tag_clear_pickup,
      'respectful' => l.tag_respectful,
      'wrong_pickup' => l.tag_wrong_pickup,
      'left_mess' => l.tag_left_mess,
      _ => tag,
    };

String providerLabel(String p) => providerLabels[p] ?? p;

/// What a good upload of this kind looks like.
String documentHint(AppLocalizations l, DocumentKind k) => switch (k) {
      DocumentKind.license => l.docHint_license,
      DocumentKind.nationalId => l.docHint_nationalId,
      DocumentKind.photo => l.docHint_photo,
      DocumentKind.registration => l.docHint_registration,
      DocumentKind.insurance => l.docHint_insurance,
      DocumentKind.inspection => l.docHint_inspection,
      _ => l.docHint_generic,
    };
