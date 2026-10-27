// Every failure leaves the API layer as an AppError: an HTTP status (0 for no network), the
// backend's error code (services answer { error: "<code>", message }), a message, and whether a
// retry can help. Screens switch on [code] to say something useful; unknown codes fall back to the
// message.

import 'package:meta/meta.dart';

/// Error codes the services answer with. Add here when a service adds one; screens that care
/// match on these instead of on strings.
abstract final class ErrorCodes {
  // transport
  static const network = 'network';
  static const timeout = 'timeout';
  static const cancelled = 'cancelled';
  // auth
  static const unauthorized = 'unauthorized';
  static const tokenOutdated = 'token_outdated';
  static const tokenRevoked = 'token_revoked';
  static const invalidToken = 'invalid_token';
  static const forbidden = 'forbidden';
  static const sessionEnded = 'session_ended';
  // common
  static const validation = 'validation_error';
  static const notFound = 'not_found';
  static const rateLimited = 'rate_limited';
  static const maintenance = 'maintenance';
  static const featureDisabled = 'feature_disabled';
  static const dependencyUnavailable = 'dependency_unavailable';
  static const notAvailable = 'not_available';
  // trips
  static const invalidState = 'invalid_state';
  static const driverUnavailable = 'driver_unavailable';
  static const driverBusy = 'driver_busy';
  static const activeTripExists = 'active_trip_exists';
  static const offerClosed = 'offer_closed';
  static const quoteExpired = 'quote_expired';
  static const invalidQuote = 'invalid_quote';
  static const paymentMethodUnavailable = 'payment_method_unavailable';
  static const tooFarFromPickup = 'too_far_from_pickup';
  static const positionUnknown = 'position_unknown';
  static const notArrived = 'not_arrived';
  static const wrongPin = 'wrong_pin';
  static const tooEarlyForNoShow = 'too_early_for_no_show';
  static const ratingClosed = 'rating_closed';
  static const alreadyRated = 'already_rated';
  static const outsideServiceArea = 'outside_service_area';
  static const vehicleTypeUnavailable = 'vehicle_type_unavailable';
  /// a company ride policy refused a trip billed to it (422; [AppError.rule] names the rule)
  static const policyViolation = 'policy_violation';
  // scheduled rides (trip-service scheduled.ts)
  static const tooSoon = 'too_soon';
  static const tooFarAhead = 'too_far_ahead';
  static const tooManyScheduled = 'too_many_scheduled';
  static const scheduleConflict = 'schedule_conflict';
  static const quoteUsed = 'quote_used';
  // fleet
  static const licenceRegistered = 'licence_registered';
  static const alreadyApplied = 'already_applied';
  static const documentsMissing = 'documents_missing';
  static const driverNotActive = 'driver_not_active';
  static const documentsExpired = 'documents_expired';
  static const vehicleNotVerified = 'vehicle_not_verified';
  static const vehicleInUse = 'vehicle_in_use';
  static const notYourVehicle = 'not_your_vehicle';
  static const notInThisFleet = 'not_in_this_fleet';
  static const notAuthorizedForVehicle = 'not_authorized_for_vehicle';
  static const alreadyOnline = 'already_online';
  static const balanceBlocked = 'balance_blocked';
  static const uploadMismatch = 'upload_mismatch';
  static const expiryRequired = 'expiry_required';
  static const documentExpired = 'document_expired';
  // payments
  static const amountOutOfRange = 'amount_out_of_range';
  static const unknownProvider = 'unknown_provider';
  static const providerUnavailable = 'provider_unavailable';
  // support
  static const useLostItems = 'use_lost_items';
  static const reopenWindowClosed = 'reopen_window_closed';
  static const ticketResolved = 'ticket_resolved';
  static const ticketClosed = 'ticket_closed';
  static const alreadyReported = 'already_reported';
  static const reportWindowClosed = 'report_window_closed';
  static const lostItemClosed = 'lost_item_closed';
  static const sosUnavailable = 'sos_unavailable';
  static const sosResolved = 'sos_resolved';
  static const invalidTransition = 'invalid_transition';
  static const requestInProgress = 'request_in_progress';
  static const idempotencyMismatch = 'idempotency_mismatch';
  // dev
  static const noCodeYet = 'no_code_yet';
  static const notADevAccount = 'not_a_dev_account';
}

@immutable
class AppError implements Exception {
  const AppError({required this.status, required this.code, required this.message, this.retryable = false, this.issues = const [], this.rule});

  /// HTTP status; 0 when the request never reached a server.
  final int status;
  final String code;
  final String message;
  /// a retry could succeed (network, timeout, 502/503/504, rate limit)
  final bool retryable;
  /// validation_error: field problems from zod
  final List<FieldIssue> issues;
  /// policy_violation: the company rule that refused the trip (vehicle_type, day, hours,
  /// max_fare, monthly_budget, purpose)
  final String? rule;

  bool get isNetwork => status == 0;
  bool get isAuth => status == 401 || code == ErrorCodes.sessionEnded;
  bool get isForbidden => status == 403;
  bool get isNotFound => status == 404;
  bool get isConflict => status == 409;
  bool is_(String code) => this.code == code;

  AppError copyWith({String? message}) => AppError(status: status, code: code, message: message ?? this.message, retryable: retryable, issues: issues, rule: rule);

  @override
  String toString() => 'AppError($status $code: $message)';
}

@immutable
class FieldIssue {
  const FieldIssue({required this.path, required this.message});
  final String path;
  final String message;
}
