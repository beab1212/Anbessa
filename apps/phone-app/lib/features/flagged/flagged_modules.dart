// Modules whose backend doesn't exist yet (workflow 16 account deletion). Each has its models, a
// repository interface, screens and entry points; the flag in client-config hides them until the
// service lands. The repositories answer `not_available` so a flag turned on early degrades to a
// clear message, not a crash.
// SOS and support moved to features/support/ once support-service landed; scheduled rides to
// features/rider/scheduled/ and promo codes into the quote screen once trip-service and
// pricing-service had them.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';

const _notAvailable = AppError(status: 501, code: ErrorCodes.notAvailable, message: 'Not available yet');

// Pieces of finished screens that wait for their backend (workflow 08 tips, 06 masked calls and chat).
const kTipsEnabled = false;
const kMaskedCallsEnabled = false;
const kChatEnabled = false;

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
