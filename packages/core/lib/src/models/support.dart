// support-service, the app's side (services/support-service/src/support/views.ts): tickets in the
// requester view, lost-item reports as the rider or driver sees them, and the owner's view of an
// SOS alert. Staff-only fields (assignee, priority, incident links, user ids) never reach the app.

import 'package:meta/meta.dart';
import 'json.dart';
import 'trip.dart';

/// The windows support-service enforces (src/support/policy.ts `LIMITS`), mirrored so the app can
/// hide an action the server would refuse.
abstract final class SupportLimits {
  /// a resolved ticket can be reopened for this long (`reopen_window_closed` after)
  static const reopenWindow = Duration(days: 7);
  /// a lost item can be reported this long after the trip completed (`report_window_closed`)
  static const lostItemReportWindow = Duration(days: 7);
  /// SOS works on an active trip and this long after drop-off (`sos_unavailable`)
  static const sosAfterDropoff = Duration(minutes: 30);
}

/// SOS is open on a matched, en-route or in-progress trip, and for 30 min after it completed
/// (policy.ts `sosAvailable`; a trip still looking for a driver doesn't qualify).
bool sosAvailable(Trip t, DateTime now) {
  if (t.status == TripStatus.matched || t.status == TripStatus.enRoute || t.status == TripStatus.inProgress) return true;
  final done = t.times.completedAt;
  return t.status == TripStatus.completed && done != null && !now.difference(done).isNegative && now.difference(done) <= SupportLimits.sosAfterDropoff;
}

/// A lost item can be reported on a completed trip up to 7 days later (policy.ts `lostItemReportable`).
bool lostItemReportable(Trip t, DateTime now) {
  final done = t.times.completedAt;
  return t.status == TripStatus.completed && done != null && now.difference(done) <= SupportLimits.lostItemReportWindow;
}

// ── tickets ───────────────────────────────────────────────────────────────────

enum TicketCategory { safety, payment, trip, lostItem, account, feedback, unknown }

String ticketCategoryToApi(TicketCategory c) => snakeOf(c.name).toUpperCase();
TicketCategory ticketCategoryFromApi(String? raw) => enumFrom(TicketCategory.values, raw, TicketCategory.unknown, apiName: ticketCategoryToApi);

/// What the app offers in "Contact support": LOST_ITEM is refused there (`use_lost_items`), lost
/// items are reported from the trip instead.
const ticketCategoriesForApp = [TicketCategory.trip, TicketCategory.payment, TicketCategory.safety, TicketCategory.account, TicketCategory.feedback];

enum TicketStatus { open, inProgress, waitingRequester, resolved, closed, unknown }

String ticketStatusToApi(TicketStatus s) => snakeOf(s.name).toUpperCase();
TicketStatus ticketStatusFromApi(String? raw) => enumFrom(TicketStatus.values, raw, TicketStatus.unknown, apiName: ticketStatusToApi);

/// A ticket as its requester sees it (`requesterTicketView`).
@immutable
class Ticket {
  const Ticket({
    required this.id,
    required this.ref,
    required this.cityId,
    required this.category,
    required this.status,
    required this.subject,
    required this.description,
    this.tripId,
    this.resolution,
    this.resolutionNote,
    this.resolvedAt,
    this.closedAt,
    this.lostItemId,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  /// the human number, shown as "#1042"
  final int ref;
  final String cityId;
  final TicketCategory category;
  final TicketStatus status;
  final String subject;
  final String description;
  final String? tripId;
  /// NO_ACTION | EXPLAINED | REFUND | ADJUSTMENT | DRIVER_WARNING | ESCALATE_SAFETY
  final String? resolution;
  final String? resolutionNote;
  final DateTime? resolvedAt;
  final DateTime? closedAt;
  /// set when the ticket was opened by a lost-item report
  final String? lostItemId;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory Ticket.fromJson(Json j) => Ticket(
        id: str(j, 'id'), ref: readInt(j, 'ref'), cityId: str(j, 'cityId'),
        category: ticketCategoryFromApi(strOrNull(j, 'category')), status: ticketStatusFromApi(strOrNull(j, 'status')),
        subject: str(j, 'subject'), description: str(j, 'description'), tripId: strOrNull(j, 'tripId'),
        resolution: strOrNull(j, 'resolution'), resolutionNote: strOrNull(j, 'resolutionNote'),
        resolvedAt: dateOrNull(j, 'resolvedAt'), closedAt: dateOrNull(j, 'closedAt'), lostItemId: strOrNull(j, 'lostItemId'),
        createdAt: readDate(j, 'createdAt'), updatedAt: readDate(j, 'updatedAt'),
      );

  /// still being worked on
  bool get isOpen => status == TicketStatus.open || status == TicketStatus.inProgress || status == TicketStatus.waitingRequester;

  /// the requester may add a message (a resolved ticket must be reopened first: `ticket_resolved`)
  bool get canReply => isOpen;

  /// resolved less than 7 days ago
  bool canReopen(DateTime now) => status == TicketStatus.resolved && resolvedAt != null && now.difference(resolvedAt!) <= SupportLimits.reopenWindow;

  @override
  bool operator ==(Object other) => other is Ticket && other.id == id && other.status == status && other.updatedAt == updatedAt;
  @override
  int get hashCode => Object.hash(id, status, updatedAt);
}

enum TicketAuthor { requester, staff, system, unknown }

String ticketAuthorToApi(TicketAuthor a) => a.name.toUpperCase();

/// One message of a ticket. Requesters only ever get public messages; staff and system messages
/// come without a user id.
@immutable
class TicketMessage {
  const TicketMessage({required this.id, this.authorUserId, required this.author, this.internal = false, required this.body, required this.createdAt});
  final String id;
  final String? authorUserId;
  final TicketAuthor author;
  final bool internal;
  final String body;
  final DateTime createdAt;

  factory TicketMessage.fromJson(Json j) => TicketMessage(
        id: str(j, 'id'), authorUserId: strOrNull(j, 'authorUserId'),
        author: enumFrom(TicketAuthor.values, strOrNull(j, 'authorKind'), TicketAuthor.unknown, apiName: ticketAuthorToApi),
        internal: readBool(j, 'internal'), body: str(j, 'body'), createdAt: readDate(j, 'createdAt'),
      );
}

/// `GET /api/support/tickets/:id` for the requester: the ticket and its public messages (oldest first).
@immutable
class TicketThread {
  const TicketThread({required this.ticket, required this.messages});
  final Ticket ticket;
  final List<TicketMessage> messages;

  factory TicketThread.fromJson(Json j) => TicketThread(
        ticket: Ticket.fromJson(asJson(j['ticket'])),
        messages: asJsonList(j['messages']).map(TicketMessage.fromJson).where((m) => !m.internal).toList(growable: false),
      );

  TicketThread copyWith({Ticket? ticket, List<TicketMessage>? messages}) => TicketThread(ticket: ticket ?? this.ticket, messages: messages ?? this.messages);
}

// ── lost items ────────────────────────────────────────────────────────────────

enum LostItemStatus { reported, found, notFound, returned, closed, unknown }

String lostItemStatusToApi(LostItemStatus s) => snakeOf(s.name).toUpperCase();
LostItemStatus lostItemStatusFromApi(String? raw) => enumFrom(LostItemStatus.values, raw, LostItemStatus.unknown, apiName: lostItemStatusToApi);

/// Who looks at a lost item (`viewerRole`) and who wrote a message (`authorKind`).
enum LostItemRole { rider, driver, fleet, staff, unknown }

String lostItemRoleToApi(LostItemRole r) => r.name.toUpperCase();
LostItemRole lostItemRoleFromApi(String? raw) => enumFrom(LostItemRole.values, raw, LostItemRole.unknown, apiName: lostItemRoleToApi);

/// A lost-item report (`lostItemView` for RIDER, DRIVER or FLEET viewers: no user ids).
@immutable
class LostItem {
  const LostItem({
    required this.id,
    required this.ticketId,
    required this.tripId,
    required this.cityId,
    required this.description,
    required this.status,
    this.driverNote,
    this.respondedAt,
    this.returnedAt,
    this.closedAt,
    required this.createdAt,
    required this.updatedAt,
    required this.viewerRole,
  });

  final String id;
  final String ticketId;
  final String tripId;
  final String cityId;
  final String description;
  final LostItemStatus status;
  final String? driverNote;
  final DateTime? respondedAt;
  final DateTime? returnedAt;
  final DateTime? closedAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  /// how the server sees the caller: the rider who reported, the trip's driver, or its fleet
  final LostItemRole viewerRole;

  factory LostItem.fromJson(Json j) => LostItem(
        id: str(j, 'id'), ticketId: str(j, 'ticketId'), tripId: str(j, 'tripId'), cityId: str(j, 'cityId'),
        description: str(j, 'description'), status: lostItemStatusFromApi(strOrNull(j, 'status')), driverNote: strOrNull(j, 'driverNote'),
        respondedAt: dateOrNull(j, 'respondedAt'), returnedAt: dateOrNull(j, 'returnedAt'), closedAt: dateOrNull(j, 'closedAt'),
        createdAt: readDate(j, 'createdAt'), updatedAt: readDate(j, 'updatedAt'), viewerRole: lostItemRoleFromApi(strOrNull(j, 'viewerRole')),
      );

  bool get isRider => viewerRole == LostItemRole.rider;
  /// the driver or the fleet owner: they answer found / not found
  bool get isDriverSide => viewerRole == LostItemRole.driver || viewerRole == LostItemRole.fleet;
  /// messages are refused once closed (`lost_item_closed`)
  bool get canMessage => status != LostItemStatus.closed && status != LostItemStatus.unknown;
  /// the driver side may say "found" (a later "found" after "not found" is allowed)
  bool get canAnswerFound => isDriverSide && (status == LostItemStatus.reported || status == LostItemStatus.notFound);
  /// the driver side may say "not found" (also after an earlier "found")
  bool get canAnswerNotFound => isDriverSide && (status == LostItemStatus.reported || status == LostItemStatus.found);
  /// the rider confirms they got it back (FOUND → RETURNED)
  bool get canConfirmReturned => isRider && status == LostItemStatus.found;

  @override
  bool operator ==(Object other) => other is LostItem && other.id == id && other.status == status && other.updatedAt == updatedAt;
  @override
  int get hashCode => Object.hash(id, status, updatedAt);
}

/// One message on a lost-item report (no user ids; `authorKind` says which side wrote it).
@immutable
class LostItemMessage {
  const LostItemMessage({required this.id, required this.author, required this.body, required this.createdAt});
  final String id;
  final LostItemRole author;
  final String body;
  final DateTime createdAt;

  factory LostItemMessage.fromJson(Json j) =>
      LostItemMessage(id: str(j, 'id'), author: lostItemRoleFromApi(strOrNull(j, 'authorKind')), body: str(j, 'body'), createdAt: readDate(j, 'createdAt'));
}

/// `GET /api/support/lost-items/:id`: the report and its messages (oldest first).
@immutable
class LostItemThread {
  const LostItemThread({required this.lostItem, required this.messages});
  final LostItem lostItem;
  final List<LostItemMessage> messages;

  factory LostItemThread.fromJson(Json j) =>
      LostItemThread(lostItem: LostItem.fromJson(asJson(j['lostItem'])), messages: asJsonList(j['messages']).map(LostItemMessage.fromJson).toList(growable: false));

  LostItemThread copyWith({LostItem? lostItem, List<LostItemMessage>? messages}) => LostItemThread(lostItem: lostItem ?? this.lostItem, messages: messages ?? this.messages);
}

// ── SOS ───────────────────────────────────────────────────────────────────────

enum SosStatus { open, acknowledged, resolved, unknown }

String sosStatusToApi(SosStatus s) => s.name.toUpperCase();

enum SosOutcome { falseAlarm, assisted, escalated, unknown }

String sosOutcomeToApi(SosOutcome o) => snakeOf(o.name).toUpperCase();

/// What the person who pressed SOS sees (`ownSosView`): that help is coming, not who handles it.
@immutable
class SosAlert {
  const SosAlert({required this.id, required this.tripId, required this.status, this.outcome, required this.triggeredAt, this.acknowledgedAt, this.resolvedAt});
  final String id;
  final String tripId;
  final SosStatus status;
  /// set once resolved
  final SosOutcome? outcome;
  final DateTime triggeredAt;
  final DateTime? acknowledgedAt;
  final DateTime? resolvedAt;

  factory SosAlert.fromJson(Json j) {
    final outcome = strOrNull(j, 'outcome');
    return SosAlert(
      id: str(j, 'id'), tripId: str(j, 'tripId'),
      status: enumFrom(SosStatus.values, strOrNull(j, 'status'), SosStatus.unknown, apiName: sosStatusToApi),
      outcome: outcome == null ? null : enumFrom(SosOutcome.values, outcome, SosOutcome.unknown, apiName: sosOutcomeToApi),
      triggeredAt: readDate(j, 'triggeredAt'), acknowledgedAt: dateOrNull(j, 'acknowledgedAt'), resolvedAt: dateOrNull(j, 'resolvedAt'),
    );
  }

  /// OPEN or ACKNOWLEDGED: someone is (or will be) on it
  bool get isLive => status == SosStatus.open || status == SosStatus.acknowledged;

  @override
  bool operator ==(Object other) => other is SosAlert && other.id == id && other.status == status && other.acknowledgedAt == acknowledgedAt && other.resolvedAt == resolvedAt;
  @override
  int get hashCode => Object.hash(id, status, acknowledgedAt, resolvedAt);
}

/// `POST /api/support/sos`: the alert, and whether it already existed (a live alert for the same
/// trip, or one pressed in the last 2 minutes, is returned instead of a new one).
@immutable
class SosTrigger {
  const SosTrigger({required this.alert, required this.duplicate});
  final SosAlert alert;
  final bool duplicate;

  factory SosTrigger.fromJson(Json j) => SosTrigger(alert: SosAlert.fromJson(asJson(j['alert'])), duplicate: readBool(j, 'duplicate'));
}
