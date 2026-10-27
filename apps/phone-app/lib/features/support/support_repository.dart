// The support-service seams (workflows 13 support, 14 SOS). Screens talk to the two repository
// interfaces; the defaults go through `SupportApi` on the shared `apiClientProvider`, and tests
// override the providers with fakes. The flags `features.support` and `features.sos` only hide
// the entry points.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/network/providers.dart';
import '../../core/session/session_controller.dart';

/// No automatic retries: the screens show the error with a "Try again" button instead (and tests
/// keep no pending timers).
Duration? noRetry(int _, Object _) => null;

// ── SOS ───────────────────────────────────────────────────────────────────────

abstract class SafetyRepository {
  /// Alert the safety team with the trip and the position. The same [idempotencyKey] is reused
  /// when the person retries, and the server returns the live alert for a second press.
  Future<SosTrigger> raiseSos({required String tripId, required double lat, required double lng, double? accuracy, String? cityId, required String idempotencyKey});

  /// The alert's state (OPEN → ACKNOWLEDGED → RESOLVED).
  Future<SosAlert> sosStatus(String alertId);

  /// A newer position while the alert is live.
  Future<void> updateSosLocation(String alertId, {required double lat, required double lng, double? accuracy});
}

class ApiSafetyRepository implements SafetyRepository {
  const ApiSafetyRepository(this._api);
  final SupportApi _api;
  @override
  Future<SosTrigger> raiseSos({required String tripId, required double lat, required double lng, double? accuracy, String? cityId, required String idempotencyKey}) =>
      _api.triggerSos(tripId: tripId, lat: lat, lng: lng, accuracy: accuracy, cityId: cityId, idempotencyKey: idempotencyKey);
  @override
  Future<SosAlert> sosStatus(String alertId) => _api.sosAlert(alertId);
  @override
  Future<void> updateSosLocation(String alertId, {required double lat, required double lng, double? accuracy}) => _api.updateSosLocation(alertId, lat: lat, lng: lng, accuracy: accuracy);
}

final safetyRepositoryProvider = Provider<SafetyRepository>((ref) => ApiSafetyRepository(ref.watch(apisProvider).support));

// ── tickets and lost items ────────────────────────────────────────────────────

abstract class SupportRepository {
  Future<TicketPage> tickets({String? cursor});
  Future<Ticket> open({required TicketCategory category, required String subject, required String message, String? tripId, String? cityId, String? as, required String idempotencyKey});
  Future<TicketThread> ticket(String id);
  Future<TicketMessage> reply(String ticketId, String body);
  Future<Ticket> reopen(String ticketId, String reason);

  Future<LostItemPage> lostItems({String? cursor});
  Future<LostItem> reportLostItem({required String tripId, required String description, required String idempotencyKey});
  Future<LostItemThread> lostItem(String id);
  Future<LostItemMessage> replyToLostItem(String id, String body);
  Future<LostItem> confirmReturned(String id);
  Future<LostItem> answerLostItem(String id, {required bool found, String? note});
}

class ApiSupportRepository implements SupportRepository {
  const ApiSupportRepository(this._api);
  final SupportApi _api;
  @override
  Future<TicketPage> tickets({String? cursor}) => _api.myTickets(cursor: cursor);
  @override
  Future<Ticket> open({required TicketCategory category, required String subject, required String message, String? tripId, String? cityId, String? as, required String idempotencyKey}) =>
      _api.createTicket(category: category, subject: subject, description: message, tripId: tripId, cityId: cityId, as: as, idempotencyKey: idempotencyKey);
  @override
  Future<TicketThread> ticket(String id) => _api.ticket(id);
  @override
  Future<TicketMessage> reply(String ticketId, String body) => _api.replyToTicket(ticketId, body);
  @override
  Future<Ticket> reopen(String ticketId, String reason) => _api.reopenTicket(ticketId, reason);
  @override
  Future<LostItemPage> lostItems({String? cursor}) => _api.myLostItems(cursor: cursor);
  @override
  Future<LostItem> reportLostItem({required String tripId, required String description, required String idempotencyKey}) =>
      _api.reportLostItem(tripId: tripId, description: description, idempotencyKey: idempotencyKey);
  @override
  Future<LostItemThread> lostItem(String id) => _api.lostItem(id);
  @override
  Future<LostItemMessage> replyToLostItem(String id, String body) => _api.replyToLostItem(id, body);
  @override
  Future<LostItem> confirmReturned(String id) => _api.confirmReturned(id);
  @override
  Future<LostItem> answerLostItem(String id, {required bool found, String? note}) => _api.respondToLostItem(id, found: found, note: note);
}

final supportRepositoryProvider = Provider<SupportRepository>((ref) => ApiSupportRepository(ref.watch(apisProvider).support));

/// The person's tickets, newest first (the first 50).
final myTicketsProvider = FutureProvider<List<Ticket>>((ref) async {
  if (ref.watch(currentSessionProvider) == null) return const [];
  return (await ref.watch(supportRepositoryProvider).tickets()).tickets;
}, retry: noRetry);

/// Lost-item reports the person made, about trips they drove, or about their fleet's cars.
final myLostItemsProvider = FutureProvider<List<LostItem>>((ref) async {
  if (ref.watch(currentSessionProvider) == null) return const [];
  return (await ref.watch(supportRepositoryProvider).lostItems()).lostItems;
}, retry: noRetry);

/// One ticket and its messages, with the requester's actions.
class TicketThreadController extends AsyncNotifier<TicketThread> {
  TicketThreadController(this.id);
  final String id;

  SupportRepository get _repo => ref.read(supportRepositoryProvider);

  @override
  Future<TicketThread> build() => ref.watch(supportRepositoryProvider).ticket(id);

  Future<void> refresh() async => state = AsyncData(await _repo.ticket(id));

  /// Throws the AppError for the screen to show; a reply to a waiting ticket moves it back to
  /// IN_PROGRESS on the server, so the thread is fetched again.
  Future<void> reply(String body) async {
    await _repo.reply(id, body);
    await _reload();
  }

  Future<void> reopen(String reason) async {
    await _repo.reopen(id, reason);
    await _reload();
  }

  Future<void> _reload() async {
    try {
      state = AsyncData(await _repo.ticket(id));
    } catch (_) {}
    ref.invalidate(myTicketsProvider);
  }
}

final ticketThreadProvider = AsyncNotifierProvider.family<TicketThreadController, TicketThread, String>(TicketThreadController.new, retry: noRetry);

/// One lost-item report and its messages, with the actions of whichever side is looking.
class LostItemThreadController extends AsyncNotifier<LostItemThread> {
  LostItemThreadController(this.id);
  final String id;

  SupportRepository get _repo => ref.read(supportRepositoryProvider);

  @override
  Future<LostItemThread> build() => ref.watch(supportRepositoryProvider).lostItem(id);

  Future<void> refresh() async => state = AsyncData(await _repo.lostItem(id));

  Future<void> reply(String body) async {
    await _repo.replyToLostItem(id, body);
    await _reload();
  }

  Future<void> confirmReturned() async {
    await _repo.confirmReturned(id);
    await _reload();
  }

  Future<void> answer({required bool found, String? note}) async {
    await _repo.answerLostItem(id, found: found, note: note);
    await _reload();
  }

  Future<void> _reload() async {
    try {
      state = AsyncData(await _repo.lostItem(id));
    } catch (_) {}
    ref.invalidate(myLostItemsProvider);
  }
}

final lostItemThreadProvider = AsyncNotifierProvider.family<LostItemThreadController, LostItemThread, String>(LostItemThreadController.new, retry: noRetry);
