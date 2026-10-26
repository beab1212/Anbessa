// Rating the other side after a trip (workflow 08 E): 1–5 stars and a comment; once per side,
// within 7 days.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../trip/active_trip_controller.dart';

class RatingScreen extends ConsumerStatefulWidget {
  const RatingScreen({super.key, required this.tripId, required this.asDriver, required this.doneRoute});
  final String tripId;
  final bool asDriver;
  final String doneRoute;
  @override
  ConsumerState<RatingScreen> createState() => _RatingScreenState();
}

class _RatingScreenState extends ConsumerState<RatingScreen> {
  int _stars = 0;
  final _comment = TextEditingController();
  bool _busy = false;
  bool _done = false;
  Object? _error;

  Future<void> _send() async {
    if (_stars == 0) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apisProvider).trips.rate(widget.tripId, stars: _stars, comment: _comment.text.trim());
      setState(() => _done = true);
    } on AppError catch (e) {
      if (e.code == ErrorCodes.alreadyRated) {
        setState(() => _done = true);
      } else {
        setState(() => _error = e);
      }
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _finish() {
    ref.read(activeTripProvider.notifier).clearIfEnded();
    context.go(widget.doneRoute);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final parties = ref.watch(tripPartiesProvider(widget.tripId)).value;
    final name = widget.asDriver ? (parties?.riderName ?? l.riderLabel) : (parties?.driverName ?? l.driverLabel);
    return Scaffold(
      appBar: AppBar(title: Text(l.rateTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (_done) ...[
            Notice(l.thanksRating, tone: NoticeTone.ok),
            const SizedBox(height: 16),
            PrimaryButton(label: l.done, onPressed: _finish),
          ] else ...[
            Text(widget.asDriver ? l.rateRiderLede : l.rateDriverLede(name), style: TextStyle(color: c.text2, fontSize: 16)),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 1; i <= 5; i++)
                  IconButton(
                    iconSize: 44,
                    onPressed: () => setState(() => _stars = i),
                    icon: Icon(i <= _stars ? Icons.star : Icons.star_border, color: i <= _stars ? c.accent : c.faint),
                    tooltip: '$i',
                  ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(controller: _comment, maxLines: 3, maxLength: 500, decoration: InputDecoration(labelText: l.ratingComment)),
            const SizedBox(height: 8),
            Problem(_error, describe: (e) => describeError(l, e)),
            const SizedBox(height: 8),
            PrimaryButton(label: l.submitRating, busy: _busy, onPressed: _stars == 0 ? null : _send),
            TextButton(onPressed: _finish, child: Text(l.skip)),
          ],
        ],
      ),
    );
  }
}
