// Modules whose backend doesn't exist yet (workflows 12 scheduled rides, 14 SOS, 13 support,
// 15 promotions, 16 account deletion). Each has its models, a repository interface, screens and
// entry points; the flag in client-config hides them until the service lands. The repositories
// answer `not_available` so a flag turned on early degrades to a clear message, not a crash.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/l10n/l10n.dart';
import '../../core/location/location_source.dart';
import '../../core/router/routes.dart';

const _notAvailable = AppError(status: 501, code: ErrorCodes.notAvailable, message: 'Not available yet');

// Pieces of finished screens that wait for their backend (workflow 08 tips, 06 masked calls and chat).
const kTipsEnabled = false;
const kMaskedCallsEnabled = false;
const kChatEnabled = false;

// ── scheduled rides (workflow 12) ─────────────────────────────────────────────

@immutable
class ScheduledTrip {
  const ScheduledTrip({required this.id, required this.pickup, required this.dropoff, required this.at, required this.vehicleType, required this.paymentMethod, required this.status});
  final String id;
  final Place pickup;
  final Place dropoff;
  final DateTime at;
  final String vehicleType;
  final PaymentMethod paymentMethod;
  /// SCHEDULED | RESERVED | DISPATCHING | DONE | CANCELLED
  final String status;
}

abstract class ScheduledRidesRepository {
  Future<List<ScheduledTrip>> list();
  Future<ScheduledTrip> schedule({required Place pickup, required Place dropoff, required DateTime at, required String vehicleType, required PaymentMethod paymentMethod});
  Future<void> cancel(String id);
}

class NotImplementedScheduledRides implements ScheduledRidesRepository {
  @override
  Future<List<ScheduledTrip>> list() async => const [];
  @override
  Future<ScheduledTrip> schedule({required Place pickup, required Place dropoff, required DateTime at, required String vehicleType, required PaymentMethod paymentMethod}) => throw _notAvailable;
  @override
  Future<void> cancel(String id) => throw _notAvailable;
}

final scheduledRidesRepositoryProvider = Provider<ScheduledRidesRepository>((ref) => NotImplementedScheduledRides());

class ScheduledRidesScreen extends ConsumerWidget {
  const ScheduledRidesScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l.scheduledRides)),
      body: FutureBuilder(
        future: ref.read(scheduledRidesRepositoryProvider).list(),
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 3));
          final list = snap.data ?? const [];
          if (list.isEmpty) {
            return _Soon(illustration: AnbessaIllustration.carWaiting, title: l.scheduledRides, body: l.scheduledRidesLede, action: PrimaryButton(label: l.scheduleRide, icon: Icons.schedule, onPressed: () => context.push(Routes.scheduledNew)));
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SectionGroup(
                margin: EdgeInsets.zero,
                children: [for (final t in list) SettingsTile(icon: Icons.schedule, title: t.dropoff.name, subtitle: dayAndTime(t.at, locale: context.localeTag), trailing: StatusPill(t.status, tone: Tone.grey), chevron: false)],
              ),
            ],
          );
        },
      ),
    );
  }
}

class ScheduleRideScreen extends StatelessWidget {
  const ScheduleRideScreen({super.key});
  @override
  Widget build(BuildContext context) => _NotYet(title: context.l10n.scheduleRide);
}

// ── SOS (workflow 14) ─────────────────────────────────────────────────────────

abstract class SafetyRepository {
  /// Alert the safety team with the trip and the live position.
  Future<void> raiseSos({String? tripId, double? lat, double? lng});
}

class NotImplementedSafety implements SafetyRepository {
  @override
  Future<void> raiseSos({String? tripId, double? lat, double? lng}) => throw _notAvailable;
}

final safetyRepositoryProvider = Provider<SafetyRepository>((ref) => NotImplementedSafety());

class SosScreen extends ConsumerStatefulWidget {
  const SosScreen({super.key, this.tripId});
  final String? tripId;
  @override
  ConsumerState<SosScreen> createState() => _SosScreenState();
}

class _SosScreenState extends ConsumerState<SosScreen> {
  Object? _error;
  bool _sent = false;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(l.sosTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Center(
            child: Pulse(
              child: Container(
                width: 112,
                height: 112,
                decoration: BoxDecoration(shape: BoxShape.circle, color: c.danger.withValues(alpha: 0.12)),
                child: Center(
                  child: Container(
                    width: 76,
                    height: 76,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: c.danger),
                    child: const Icon(Icons.sos, color: Colors.white, size: 38),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(l.sosLede, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2)),
          const SizedBox(height: 24),
          PrimaryButton(label: l.callPolice, icon: Icons.phone, danger: true, onPressed: () {
            Haptics.heavy();
            launchUrl(Uri.parse('tel:991'));
          }),
          const SizedBox(height: 12),
          if (_sent) Notice(l.done, tone: NoticeTone.ok) else Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () async {
              final pos = ref.read(lastPositionProvider);
              try {
                await ref.read(safetyRepositoryProvider).raiseSos(tripId: widget.tripId, lat: pos?.lat, lng: pos?.lng);
                setState(() => _sent = true);
              } catch (e) {
                setState(() => _error = e);
              }
            },
            icon: const Icon(Icons.shield_outlined),
            label: Text(l.alertSafety),
          ),
        ],
      ),
    );
  }
}

// ── support (workflow 13) ─────────────────────────────────────────────────────

@immutable
class Ticket {
  const Ticket({required this.id, required this.subject, required this.status, required this.createdAt});
  final String id;
  final String subject;
  final String status;
  final DateTime createdAt;
}

abstract class SupportRepository {
  Future<List<Ticket>> tickets();
  Future<Ticket> open({required String category, required String message, String? tripId});
}

class NotImplementedSupport implements SupportRepository {
  @override
  Future<List<Ticket>> tickets() async => const [];
  @override
  Future<Ticket> open({required String category, required String message, String? tripId}) => throw _notAvailable;
}

final supportRepositoryProvider = Provider<SupportRepository>((ref) => NotImplementedSupport());

class SupportScreen extends StatelessWidget {
  const SupportScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l.support)),
      body: _Soon(illustration: AnbessaIllustration.searchEmpty, title: l.support, body: l.supportLede, action: PrimaryButton(label: l.newTicket, icon: Icons.edit_outlined, onPressed: () => context.push(Routes.supportNew))),
    );
  }
}

class NewTicketScreen extends StatelessWidget {
  const NewTicketScreen({super.key});
  @override
  Widget build(BuildContext context) => _NotYet(title: context.l10n.newTicket);
}

// ── promotions (workflow 15) ──────────────────────────────────────────────────

abstract class PromosRepository {
  Future<List<String>> active();
  Future<void> redeem(String code);
}

class NotImplementedPromos implements PromosRepository {
  @override
  Future<List<String>> active() async => const [];
  @override
  Future<void> redeem(String code) => throw _notAvailable;
}

final promosRepositoryProvider = Provider<PromosRepository>((ref) => NotImplementedPromos());

class PromosScreen extends StatelessWidget {
  const PromosScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l.promos)),
      body: _Soon(illustration: AnbessaIllustration.wallet, title: l.promos, body: l.promosLede, action: PrimaryButton(label: l.redeemCode, icon: Icons.local_offer_outlined, onPressed: () => context.push(Routes.promosRedeem))),
    );
  }
}

class RedeemCodeScreen extends StatelessWidget {
  const RedeemCodeScreen({super.key});
  @override
  Widget build(BuildContext context) => _NotYet(title: context.l10n.redeemCode);
}

// ── account deletion (workflow 16) ────────────────────────────────────────────

abstract class AccountRepository {
  Future<void> requestDeletion();
}

class NotImplementedAccount implements AccountRepository {
  @override
  Future<void> requestDeletion() => throw _notAvailable;
}

final accountRepositoryProvider = Provider<AccountRepository>((ref) => NotImplementedAccount());

class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});
  @override
  ConsumerState<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  Object? _error;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l.deleteAccountTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Notice(l.deleteAccountLede, tone: NoticeTone.warning),
          const SizedBox(height: 16),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          PrimaryButton(
            label: l.deleteAccount,
            danger: true,
            onPressed: () async {
              try {
                await ref.read(accountRepositoryProvider).requestDeletion();
              } catch (e) {
                setState(() => _error = e);
              }
            },
          ),
        ],
      ),
    );
  }
}

class _NotYet extends StatelessWidget {
  const _NotYet({required this.title});
  final String title;
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(title)), body: _Soon(illustration: AnbessaIllustration.documents, title: title, body: context.l10n.notAvailableYet));
}

/// The empty state of a module that's on its way: illustration, a "Coming soon" chip, the lede.
class _Soon extends StatelessWidget {
  const _Soon({required this.illustration, required this.title, required this.body, this.action});
  final AnbessaIllustration illustration;
  final String title;
  final String body;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight - 48),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              StatusPill(context.l10n.comingSoon, tone: Tone.amber),
              const SizedBox(height: 12),
              FadeSlideIn(child: IllustratedEmpty(illustration: illustration, title: title, body: body, action: action)),
              const SizedBox(height: 8),
              Text(context.l10n.notAvailableYet, textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted)),
            ],
          ),
        ),
      ),
    );
  }
}
