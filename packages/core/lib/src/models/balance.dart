// payment-service, the driver's side (Payment.md §5, §8, §9): the balance, its state and limits,
// payment dues, the statement, and top-ups.

import 'package:meta/meta.dart';
import 'json.dart';

enum BalanceState { ok, warning, cashBlocked, blocked, unknown }

String balanceStateToApi(BalanceState s) => snakeOf(s.name).toUpperCase();

BalanceState balanceStateFromApi(String? v) => enumFrom(BalanceState.values, v, BalanceState.unknown, apiName: balanceStateToApi);

@immutable
class BalancePolicy {
  const BalancePolicy({required this.mode, required this.warningMinor, required this.cashLimitMinor, required this.hardLimitMinor, required this.prepaidMinimumMinor, required this.minPayoutMinor, required this.dueDays, required this.builtIn});
  /// POSTPAID | PREPAID
  final String mode;
  final int warningMinor;
  final int cashLimitMinor;
  final int hardLimitMinor;
  final int prepaidMinimumMinor;
  final int minPayoutMinor;
  final int dueDays;
  final bool builtIn;
  factory BalancePolicy.fromJson(Json j) => BalancePolicy(
        mode: str(j, 'mode', 'POSTPAID'), warningMinor: readInt(j, 'warningMinor'), cashLimitMinor: readInt(j, 'cashLimitMinor'), hardLimitMinor: readInt(j, 'hardLimitMinor'),
        prepaidMinimumMinor: readInt(j, 'prepaidMinimumMinor'), minPayoutMinor: readInt(j, 'minPayoutMinor'), dueDays: readInt(j, 'dueDays', 3), builtIn: readBool(j, 'builtIn'),
      );
  bool get prepaid => mode == 'PREPAID';
}

@immutable
class PaymentDue {
  const PaymentDue({required this.id, required this.amountMinor, required this.minimumMinor, required this.paidMinor, required this.dueAt, required this.status});
  final String id;
  final int amountMinor;
  final int minimumMinor;
  final int paidMinor;
  final DateTime dueAt;
  /// OPEN | MIN_PAID | PAID | OVERDUE | WRITTEN_OFF
  final String status;
  factory PaymentDue.fromJson(Json j) => PaymentDue(
        id: str(j, 'id'), amountMinor: readInt(j, 'amountMinor'), minimumMinor: readInt(j, 'minimumMinor'), paidMinor: readInt(j, 'paidMinor'),
        dueAt: readDate(j, 'dueAt'), status: str(j, 'status', 'OPEN'),
      );
  bool get isOpen => status == 'OPEN' || status == 'OVERDUE' || status == 'MIN_PAID';
  int get leftMinor => amountMinor - paidMinor;
  int get minimumLeftMinor => (minimumMinor - paidMinor).clamp(0, amountMinor);
}

@immutable
class PayoutMethod {
  const PayoutMethod({required this.provider, this.destination});
  final String provider;
  /// masked (•••3344)
  final String? destination;
  factory PayoutMethod.fromJson(Json j) => PayoutMethod(provider: str(j, 'provider'), destination: strOrNull(j, 'destination'));
}

/// GET /api/payments/balances/me (or /org/:id, /:accountId)
@immutable
class Balance {
  const Balance({
    this.accountId,
    required this.ownerType,
    required this.ownerId,
    required this.cityId,
    required this.balanceMinor,
    this.currency = 'ETB',
    required this.state,
    required this.cashAllowed,
    this.stateChangedAt,
    this.overdueSince,
    this.referenceCode,
    this.payoutMethod,
    required this.suggestedTopUpMinor,
    required this.policy,
    required this.dues,
  });

  /// null until the first trip or top-up opens the account
  final String? accountId;
  /// INDIVIDUAL | ORGANIZATION
  final String ownerType;
  final String ownerId;
  final String cityId;
  /// > 0: we owe them; < 0: they owe us
  final int balanceMinor;
  final String currency;
  final BalanceState state;
  final bool cashAllowed;
  final DateTime? stateChangedAt;
  final DateTime? overdueSince;
  /// quoted on bank transfers (ANB-7K2Q9X)
  final String? referenceCode;
  final PayoutMethod? payoutMethod;
  final int suggestedTopUpMinor;
  final BalancePolicy policy;
  final List<PaymentDue> dues;

  factory Balance.fromJson(Json j) {
    final b = asJson(j['beneficiary']);
    return Balance(
      accountId: strOrNull(j, 'accountId'), ownerType: str(b, 'type', 'INDIVIDUAL'), ownerId: str(b, 'id'), cityId: str(j, 'cityId'),
      balanceMinor: readInt(j, 'balanceMinor'), currency: str(j, 'currency', 'ETB'), state: balanceStateFromApi(strOrNull(j, 'state')),
      cashAllowed: readBool(j, 'cashAllowed', true), stateChangedAt: dateOrNull(j, 'stateChangedAt'), overdueSince: dateOrNull(j, 'overdueSince'),
      referenceCode: strOrNull(j, 'referenceCode'), payoutMethod: j['payoutMethod'] is Map ? PayoutMethod.fromJson(asJson(j['payoutMethod'])) : null,
      suggestedTopUpMinor: readInt(j, 'suggestedTopUpMinor'), policy: BalancePolicy.fromJson(asJson(j['policy'])),
      dues: asJsonList(j['dues']).map(PaymentDue.fromJson).toList(growable: false),
    );
  }

  bool get owes => balanceMinor < 0;
  List<PaymentDue> get openDues => dues.where((d) => d.isOpen).toList(growable: false);

  @override
  bool operator ==(Object other) => other is Balance && other.accountId == accountId && other.balanceMinor == balanceMinor && other.state == state && other.dues.length == dues.length;
  @override
  int get hashCode => Object.hash(accountId, balanceMinor, state, dues.length);
}

@immutable
class StatementEntry {
  const StatementEntry({required this.id, required this.at, required this.amountMinor, required this.kind, this.memo, required this.referenceType, required this.referenceId});
  final String id;
  final DateTime at;
  final int amountMinor;
  /// TRIP_SETTLEMENT, CANCELLATION_FEE, TOP_UP, PAYOUT, PAYOUT_REVERSAL, REFUND, RECEIVABLE_COLLECTION
  final String kind;
  final String? memo;
  final String referenceType;
  final String referenceId;
  factory StatementEntry.fromJson(Json j) {
    final ref = asJson(j['reference']);
    return StatementEntry(
      id: str(j, 'id'), at: readDate(j, 'at'), amountMinor: readInt(j, 'amountMinor'), kind: str(j, 'kind'), memo: strOrNull(j, 'memo'),
      referenceType: str(ref, 'type'), referenceId: str(ref, 'id'),
    );
  }
}

enum TopUpStatus { pending, actionRequired, succeeded, failed, pendingApproval, rejected, unknown }

@immutable
class TopUp {
  const TopUp({required this.id, required this.accountId, required this.channel, this.provider, required this.amountMinor, required this.status, this.checkoutUrl, this.failure, this.instructions, required this.createdAt, this.completedAt});
  final String id;
  final String accountId;
  /// MOBILE_MONEY | BANK_TRANSFER | OFFICE_CASH
  final String channel;
  final String? provider;
  final int amountMinor;
  final TopUpStatus status;
  final String? checkoutUrl;
  final String? failure;
  /// what to tell the payer (only on the create response)
  final String? instructions;
  final DateTime createdAt;
  final DateTime? completedAt;
  factory TopUp.fromJson(Json j) => TopUp(
        id: str(j, 'id'), accountId: str(j, 'accountId'), channel: str(j, 'channel'), provider: strOrNull(j, 'provider'), amountMinor: readInt(j, 'amountMinor'),
        status: enumFrom(TopUpStatus.values, strOrNull(j, 'status'), TopUpStatus.unknown, apiName: (s) => snakeOf(s.name).toUpperCase()),
        checkoutUrl: strOrNull(j, 'checkoutUrl'), failure: strOrNull(j, 'failure'), instructions: strOrNull(j, 'instructions'),
        createdAt: readDate(j, 'createdAt'), completedAt: dateOrNull(j, 'completedAt'),
      );
  bool get isOpen => status == TopUpStatus.pending || status == TopUpStatus.actionRequired || status == TopUpStatus.pendingApproval;
}
