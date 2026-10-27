// support-service on the app's side: the requester / owner views parse from real-shaped
// fixtures, the windows match policy.ts, and SupportApi sends exactly what routes.ts validates.

import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

Map<String, dynamic> fixture(String name) => jsonDecode(File('test/fixtures/$name.json').readAsStringSync()) as Map<String, dynamic>;

Trip tripWith(String status, {DateTime? completedAt}) {
  final j = fixture('trip');
  j['status'] = status;
  j['times'] = {...asJson(j['times']), 'completedAt': completedAt?.toIso8601String()};
  return Trip.fromJson(j);
}

class _Adapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  Object Function(RequestOptions o)? reply;
  @override
  Future<ResponseBody> fetch(RequestOptions o, Stream<List<int>>? requestStream, Future<void>? cancelFuture) async {
    requests.add(o);
    return ResponseBody.fromString(jsonEncode(reply?.call(o) ?? {}), 200, headers: {'content-type': ['application/json']});
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('models', () {
    test('a ticket thread in the requester view', () {
      final t = TicketThread.fromJson(fixture('ticket'));
      expect(t.ticket.ref, 1042);
      expect(t.ticket.category, TicketCategory.payment);
      expect(t.ticket.status, TicketStatus.resolved);
      expect(t.ticket.resolution, 'REFUND');
      expect(t.ticket.tripId, '01a17852-92d0-7c01-8f2f-301de1969537');
      expect(t.ticket.isOpen, isFalse);
      expect(t.ticket.canReply, isFalse);
      expect(t.ticket.canReopen(DateTime.utc(2026, 10, 30)), isTrue);
      expect(t.ticket.canReopen(DateTime.utc(2026, 11, 3)), isFalse, reason: 'more than 7 days after resolution');
      expect(t.messages.map((m) => m.author), [TicketAuthor.staff, TicketAuthor.requester, TicketAuthor.system]);
      expect(t.messages.first.authorUserId, isNull);
    });

    test('ticket enums map to the backend literals both ways; new values degrade to unknown', () {
      for (final s in ['SAFETY', 'PAYMENT', 'TRIP', 'LOST_ITEM', 'ACCOUNT', 'FEEDBACK']) {
        expect(ticketCategoryToApi(ticketCategoryFromApi(s)), s);
      }
      for (final s in ['OPEN', 'IN_PROGRESS', 'WAITING_REQUESTER', 'RESOLVED', 'CLOSED']) {
        expect(ticketStatusToApi(ticketStatusFromApi(s)), s);
      }
      expect(ticketCategoryFromApi('BILLING'), TicketCategory.unknown);
      expect(ticketStatusFromApi(null), TicketStatus.unknown);
      expect(ticketCategoriesForApp, isNot(contains(TicketCategory.lostItem)));
      final waiting = Ticket.fromJson({...asJson(fixture('ticket')['ticket']), 'status': 'WAITING_REQUESTER'});
      expect(waiting.canReply, isTrue);
      expect(waiting.canReopen(DateTime.utc(2026, 10, 27)), isFalse);
    });

    test('internal messages never show, even if a server sent one', () {
      final j = fixture('ticket');
      (j['messages'] as List).add({'id': 'x', 'authorKind': 'STAFF', 'internal': true, 'body': 'note', 'createdAt': '2026-10-26T15:00:00Z'});
      expect(TicketThread.fromJson(j).messages.length, 3);
    });

    test('a lost item as the rider sees it, and what each side may do', () {
      final t = LostItemThread.fromJson(fixture('lost_item'));
      final l = t.lostItem;
      expect(l.status, LostItemStatus.found);
      expect(l.viewerRole, LostItemRole.rider);
      expect(l.driverNote, contains('Bole'));
      expect(l.canConfirmReturned, isTrue);
      expect(l.canAnswerFound, isFalse);
      expect(l.canMessage, isTrue);
      expect(t.messages.map((m) => m.author), [LostItemRole.driver, LostItemRole.rider]);

      LostItem as(String role, String status) => LostItem.fromJson({...asJson(fixture('lost_item')['lostItem']), 'viewerRole': role, 'status': status});
      expect(as('DRIVER', 'REPORTED').canAnswerFound, isTrue);
      expect(as('DRIVER', 'REPORTED').canAnswerNotFound, isTrue);
      expect(as('FLEET', 'NOT_FOUND').canAnswerFound, isTrue);
      expect(as('DRIVER', 'NOT_FOUND').canAnswerNotFound, isFalse);
      expect(as('DRIVER', 'FOUND').canAnswerNotFound, isTrue);
      expect(as('DRIVER', 'FOUND').canConfirmReturned, isFalse);
      expect(as('RIDER', 'CLOSED').canMessage, isFalse);
      expect(lostItemStatusToApi(LostItemStatus.notFound), 'NOT_FOUND');
    });

    test('an SOS alert in the owner view', () {
      final s = SosTrigger.fromJson(fixture('sos_alert'));
      expect(s.duplicate, isFalse);
      expect(s.alert.status, SosStatus.acknowledged);
      expect(s.alert.isLive, isTrue);
      expect(s.alert.outcome, isNull);
      expect(s.alert.acknowledgedAt, DateTime.utc(2026, 10, 26, 13, 20, 40));
      final resolved = SosAlert.fromJson({...asJson(fixture('sos_alert')['alert']), 'status': 'RESOLVED', 'outcome': 'FALSE_ALARM'});
      expect(resolved.isLive, isFalse);
      expect(resolved.outcome, SosOutcome.falseAlarm);
    });

    test('SOS and lost-item windows follow policy.ts', () {
      final done = DateTime.utc(2026, 10, 26, 14);
      expect(sosAvailable(tripWith('requested'), done), isFalse, reason: 'no driver yet');
      for (final s in ['matched', 'en_route', 'in_progress']) {
        expect(sosAvailable(tripWith(s), done), isTrue, reason: s);
      }
      final completed = tripWith('completed', completedAt: done);
      expect(sosAvailable(completed, done.add(const Duration(minutes: 29))), isTrue);
      expect(sosAvailable(completed, done.add(const Duration(minutes: 31))), isFalse);
      expect(sosAvailable(tripWith('cancelled'), done), isFalse);
      expect(lostItemReportable(completed, done.add(const Duration(days: 6))), isTrue);
      expect(lostItemReportable(completed, done.add(const Duration(days: 8))), isFalse);
      expect(lostItemReportable(tripWith('in_progress'), done), isFalse);
    });
  });

  group('SupportApi', () {
    late _Adapter adapter;
    late SupportApi api;
    setUp(() {
      adapter = _Adapter();
      final client = ApiClient(endpoints: const ApiEndpoints.host(), newId: () => 'id', dio: Dio()..httpClientAdapter = adapter, retryDelays: const []);
      api = Apis(client).support;
    });

    test('host mode sends /api/support to port 3009; gateway mode passes it through', () async {
      adapter.reply = (_) => {'tickets': [], 'next': null};
      await api.myTickets();
      expect(adapter.requests.single.uri.toString(), 'http://localhost:3009/api/support/me/tickets?limit=50');
      expect(const ApiEndpoints.gateway('http://localhost:8000').resolve('/api/support/sos'), 'http://localhost:8000/api/support/sos');
    });

    test('a ticket is created with the route\'s fields and the caller\'s key', () async {
      adapter.reply = (_) => {'ticket': fixture('ticket')['ticket']};
      final t = await api.createTicket(category: TicketCategory.payment, subject: 'Charged twice', description: 'twice', cityId: 'addis-ababa', as: 'RIDER', idempotencyKey: 'k-123456');
      final o = adapter.requests.single;
      expect(o.method, 'POST');
      expect(o.path, 'http://localhost:3009/api/support/tickets');
      expect(o.headers['idempotency-key'], 'k-123456');
      expect(o.data, {'category': 'PAYMENT', 'subject': 'Charged twice', 'description': 'twice', 'cityId': 'addis-ababa', 'as': 'RIDER'});
      expect(t.ref, 1042);
    });

    test('ticket thread, reply and reopen', () async {
      adapter.reply = (o) => switch (o.path) {
            final p when p.endsWith('/messages') => {'message': (fixture('ticket')['messages'] as List)[1]},
            final p when p.endsWith('/reopen') => {'ticket': {...asJson(fixture('ticket')['ticket']), 'status': 'OPEN'}},
            _ => fixture('ticket'),
          };
      expect((await api.ticket('t1')).messages.length, 3);
      expect((await api.replyToTicket('t1', 'hello')).author, TicketAuthor.requester);
      expect(adapter.requests[1].data, {'body': 'hello'});
      expect((await api.reopenTicket('t1', 'still charged')).status, TicketStatus.open);
      expect(adapter.requests[2].path, endsWith('/api/support/tickets/t1/reopen'));
      expect(adapter.requests[2].data, {'reason': 'still charged'});
    });

    test('lost items: report, list, reply, confirm returned, and the driver\'s answer', () async {
      final item = asJson(fixture('lost_item')['lostItem']);
      adapter.reply = (o) => o.method == 'GET' ? {'lostItems': [item], 'next': 'c2'} : (o.path.endsWith('/messages') ? {'message': (fixture('lost_item')['messages'] as List)[1]} : {'lostItem': item});
      await api.reportLostItem(tripId: 'trip-1', description: 'backpack', idempotencyKey: 'k-lost-1');
      expect(adapter.requests.last.data, {'tripId': 'trip-1', 'description': 'backpack'});
      expect(adapter.requests.last.headers['idempotency-key'], 'k-lost-1');
      final page = await api.myLostItems(cursor: 'c1');
      expect(page.next, 'c2');
      expect(adapter.requests.last.uri.query, 'cursor=c1&limit=50');
      await api.replyToLostItem('l1', 'thanks');
      expect(adapter.requests.last.data, {'body': 'thanks'});
      await api.confirmReturned('l1');
      expect(adapter.requests.last.path, endsWith('/lost-items/l1/status'));
      expect(adapter.requests.last.data, {'status': 'RETURNED'});
      await api.respondToLostItem('l1', found: false, note: 'checked the boot');
      expect(adapter.requests.last.path, endsWith('/lost-items/l1/respond'));
      expect(adapter.requests.last.data, {'found': false, 'note': 'checked the boot'});
    });

    test('SOS: trigger with the key, the trip, the position and the city; then status', () async {
      adapter.reply = (_) => fixture('sos_alert');
      final s = await api.triggerSos(tripId: 'trip-1', lat: 9.01, lng: 38.76, accuracy: 250000, cityId: 'addis-ababa', idempotencyKey: 'sos-key-1');
      final o = adapter.requests.single;
      expect(o.path, 'http://localhost:3009/api/support/sos');
      expect(o.headers['idempotency-key'], 'sos-key-1');
      expect(o.data, {'tripId': 'trip-1', 'location': {'lat': 9.01, 'lng': 38.76, 'accuracy': 100000.0}, 'cityId': 'addis-ababa'});
      expect(s.alert.isLive, isTrue);
      await api.sosAlert(s.alert.id);
      expect(adapter.requests.last.path, endsWith('/api/support/sos/${s.alert.id}'));
      await api.updateSosLocation(s.alert.id, lat: 9.02, lng: 38.77);
      expect(adapter.requests.last.data, {'lat': 9.02, 'lng': 38.77});
    });
  });
}
