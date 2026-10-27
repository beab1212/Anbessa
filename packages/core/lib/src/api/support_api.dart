// support-service (/api/support, port 3009 in host mode): the app's half of
// services/support-service/src/http/routes.ts. Tickets, lost items (both the rider who reports and
// the driver or fleet who answers) and SOS. Staff routes (queues, incidents) are not wrapped.

import '../models/json.dart';
import '../models/support.dart';
import 'api_client.dart';

typedef TicketPage = ({List<Ticket> tickets, String? next});
typedef LostItemPage = ({List<LostItem> lostItems, String? next});

class SupportApi {
  const SupportApi(this._c);
  final ApiClient _c;
  static const base = '/api/support';

  // ── tickets ─────────────────────────────────────────────────────────────────

  /// `POST /tickets` (idempotent). The city is the trip's when [tripId] is set, else [cityId]
  /// (400 without either). [as] (`RIDER` | `DRIVER`) says which side a ticket without a trip is
  /// from. LOST_ITEM is refused here (`use_lost_items`): use [reportLostItem].
  Future<Ticket> createTicket({
    required TicketCategory category,
    required String subject,
    required String description,
    String? tripId,
    String? cityId,
    String? as,
    required String idempotencyKey,
  }) =>
      _c
          .postJson('$base/tickets',
              body: {'category': ticketCategoryToApi(category), 'subject': subject, 'description': description, 'tripId': ?tripId, 'cityId': ?cityId, 'as': ?as},
              idempotencyKey: idempotencyKey)
          .then((j) => Ticket.fromJson(asJson(j['ticket'])));

  /// `GET /me/tickets`: the caller's tickets, newest first.
  Future<TicketPage> myTickets({String? cursor, int limit = 50}) => _c
      .getJson('$base/me/tickets', query: {'cursor': ?cursor, 'limit': limit})
      .then((j) => (tickets: asJsonList(j['tickets']).map(Ticket.fromJson).toList(growable: false), next: strOrNull(j, 'next')));

  /// `GET /tickets/:id`: the ticket and its public messages.
  Future<TicketThread> ticket(String id) => _c.getJson('$base/tickets/$id').then(TicketThread.fromJson);

  /// `POST /tickets/:id/messages`. 409 `ticket_resolved` (reopen first) or `ticket_closed`.
  Future<TicketMessage> replyToTicket(String id, String body) =>
      _c.postJson('$base/tickets/$id/messages', body: {'body': body}).then((j) => TicketMessage.fromJson(asJson(j['message'])));

  /// `POST /tickets/:id/reopen`: RESOLVED and at most 7 days old (409 `reopen_window_closed`).
  Future<Ticket> reopenTicket(String id, String reason) =>
      _c.postJson('$base/tickets/$id/reopen', body: {'reason': reason}).then((j) => Ticket.fromJson(asJson(j['ticket'])));

  // ── lost items ──────────────────────────────────────────────────────────────

  /// `POST /lost-items` (idempotent): the rider (or booker) of a trip completed ≤ 7 days ago.
  /// 409 `report_window_closed`, `already_reported`.
  Future<LostItem> reportLostItem({required String tripId, required String description, required String idempotencyKey}) => _c
      .postJson('$base/lost-items', body: {'tripId': tripId, 'description': description}, idempotencyKey: idempotencyKey)
      .then((j) => LostItem.fromJson(asJson(j['lostItem'])));

  /// `GET /me/lost-items`: reports the caller made, about trips they drove, or about their fleet's cars.
  Future<LostItemPage> myLostItems({String? cursor, int limit = 50}) => _c
      .getJson('$base/me/lost-items', query: {'cursor': ?cursor, 'limit': limit})
      .then((j) => (lostItems: asJsonList(j['lostItems']).map(LostItem.fromJson).toList(growable: false), next: strOrNull(j, 'next')));

  /// `GET /lost-items/:id`: the report and its messages.
  Future<LostItemThread> lostItem(String id) => _c.getJson('$base/lost-items/$id').then(LostItemThread.fromJson);

  /// `POST /lost-items/:id/messages`. 409 `lost_item_closed`.
  Future<LostItemMessage> replyToLostItem(String id, String body) =>
      _c.postJson('$base/lost-items/$id/messages', body: {'body': body}).then((j) => LostItemMessage.fromJson(asJson(j['message'])));

  /// The rider got it back: `POST /lost-items/:id/status {status: RETURNED}` (from FOUND only).
  Future<LostItem> confirmReturned(String id, {String? note}) =>
      _c.postJson('$base/lost-items/$id/status', body: {'status': 'RETURNED', 'note': ?note}).then((j) => LostItem.fromJson(asJson(j['lostItem'])));

  /// The driver or fleet answers: `POST /lost-items/:id/respond {found, note?}` → FOUND / NOT_FOUND.
  Future<LostItem> respondToLostItem(String id, {required bool found, String? note}) =>
      _c.postJson('$base/lost-items/$id/respond', body: {'found': found, 'note': ?note}).then((j) => LostItem.fromJson(asJson(j['lostItem'])));

  // ── SOS ─────────────────────────────────────────────────────────────────────

  /// `POST /sos` (idempotent): the trip's rider, booker or driver, on an active trip or ≤ 30 min
  /// after drop-off (409 `sos_unavailable`). [cityId] lets the alert through unverified when
  /// trip-service is down. 201 for a new alert, 200 with `duplicate: true` for a live or recent one.
  Future<SosTrigger> triggerSos({required String tripId, required double lat, required double lng, double? accuracy, String? cityId, required String idempotencyKey}) => _c
      .postJson('$base/sos', body: {'tripId': tripId, 'location': {'lat': lat, 'lng': lng, 'accuracy': ?_accuracy(accuracy)}, 'cityId': ?cityId}, idempotencyKey: idempotencyKey)
      .then(SosTrigger.fromJson);

  /// `POST /sos/:id/location`: a newer position for a live alert (409 `sos_resolved`).
  Future<SosAlert> updateSosLocation(String id, {required double lat, required double lng, double? accuracy}) =>
      _c.postJson('$base/sos/$id/location', body: {'lat': lat, 'lng': lng, 'accuracy': ?_accuracy(accuracy)}).then((j) => SosAlert.fromJson(asJson(j['alert'])));

  /// `GET /sos/:id`: the owner's view of the alert.
  Future<SosAlert> sosAlert(String id) => _c.getJson('$base/sos/$id').then((j) => SosAlert.fromJson(asJson(j['alert'])));

  /// the route accepts 0–100 000 m
  static double? _accuracy(double? a) => a == null || a.isNaN ? null : a.clamp(0, 100000).toDouble();
}
