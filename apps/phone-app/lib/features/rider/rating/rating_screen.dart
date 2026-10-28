// Rating the other side after a trip (workflow 08 E), as the GoRide kit's "How was the driver?":
// ✕ (skip), the photo, the question, five big stars; once rated, what stood out and a comment;
// the ride and fare cards behind "Show details"; "Give Rate" at the bottom. Then "Thanks for
// your feedback!". Once per side, within 7 days. Riders and drivers use the same page.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../shell/rider_map_shell.dart' show driverAvatarHeroTag;
import '../trip/active_trip_controller.dart';
import '../trip/rider_trip_screen.dart' show TripCards;

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
  final _tags = <String>{};
  final _comment = TextEditingController();
  bool _busy = false;
  bool _done = false;
  bool _details = true;
  Object? _error;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_stars == 0) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apisProvider).trips.rate(widget.tripId, stars: _stars, comment: _comment.text.trim(), tags: _tags.toList());
      Haptics.success();
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
    if (_done) return _Thanks(onDone: _finish);
    final parties = ref.watch(tripPartiesProvider(widget.tripId)).value;
    final trip = ref.watch(tripProvider(widget.tripId)).value;
    final name = widget.asDriver ? (parties?.riderName ?? l.riderLabel) : (parties?.driverName ?? l.driverLabel);
    final photo = widget.asDriver ? parties?.riderPhoto : parties?.driverPhoto;
    final all = widget.asDriver ? RatingTags.ofRider : RatingTags.ofDriver;
    // good tags first for good ratings, the other way round otherwise
    final tags = _stars == 0 ? all : [...all.where((t) => RatingTags.positive.contains(t) == (_stars >= 4)), ...all.where((t) => RatingTags.positive.contains(t) != (_stars >= 4))];
    final avatar = AvatarImage(src: photo, name: name, size: 104);
    return Scaffold(
      appBar: AppTopBar(leadingKind: TopBarLeading.close, onLeading: _finish, leadingTooltip: l.skip),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          // the driver's photo flies in from the trip sheet or the pay page
          Center(child: widget.asDriver ? avatar : Hero(tag: driverAvatarHeroTag(widget.tripId), child: avatar)),
          const SizedBox(height: 20),
          Semantics(header: true, child: Text(widget.asDriver ? l.grHowWasRider : l.grHowWasDriver, textAlign: TextAlign.center, style: AnbessaType.h1.copyWith(color: c.text))),
          const SizedBox(height: 8),
          Text(l.grRateLede, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.muted, fontWeight: FontWeight.w400)),
          Divider(height: 41, color: c.border),
          Center(child: RatingStars(value: _stars, size: 48, gap: 12, onChanged: (v) => setState(() => _stars = v))),
          AnimatedSwitcherX(
            child: _stars == 0
                ? const SizedBox(height: 20, key: ValueKey('none'))
                : Padding(
                    key: const ValueKey('tags'),
                    padding: const EdgeInsets.only(top: 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(l.whatStoodOut, style: AnbessaType.title.copyWith(color: c.text)),
                        const SizedBox(height: 12),
                        TagChips(tags: tags, selected: _tags, label: (t) => ratingTagLabel(l, t), onToggle: (t) => setState(() => _tags.contains(t) ? _tags.remove(t) : (_tags.length < 5 ? _tags.add(t) : null))),
                        const SizedBox(height: 16),
                        FilledField(controller: _comment, hint: l.ratingComment, maxLines: 3, maxLength: 500),
                        const SizedBox(height: 20),
                      ],
                    ),
                  ),
          ),
          if (trip != null) ...[
            AnimatedSwitcherX(child: _details ? TripCards(key: const ValueKey('cards'), trip: trip, paid: true) : const SizedBox.shrink(key: ValueKey('nocards'))),
            const SizedBox(height: 4),
            Center(child: TextButton(onPressed: () => setState(() => _details = !_details), child: Text(_details ? l.grHideDetails : l.grShowDetails))),
          ],
          Problem(_error, describe: (e) => describeError(l, e)),
        ],
      ),
      bottomNavigationBar: BottomActionBar(child: PrimaryButton(key: const ValueKey('give-rate'), label: l.grGiveRate, busy: _busy, onPressed: _stars == 0 ? null : _send)),
    );
  }
}

/// "Thanks for your feedback!"
class _Thanks extends StatelessWidget {
  const _Thanks({required this.onDone});
  final VoidCallback onDone;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppTopBar(leadingKind: TopBarLeading.close, onLeading: onDone, leadingTooltip: l.close),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: AnbessaSpace.page),
          child: Column(
            children: [
              const PopIn(child: ResultBadge()),
              const SizedBox(height: 24),
              Semantics(header: true, liveRegion: true, child: Text(l.grThanksFeedback, textAlign: TextAlign.center, style: AnbessaType.display.copyWith(color: c.text))),
              const SizedBox(height: 16),
              Text(l.grSeeYouNext, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2, fontWeight: FontWeight.w400)),
              const SizedBox(height: 64),
            ],
          ),
        ),
      ),
      bottomNavigationBar: BottomActionBar(child: PrimaryButton(key: const ValueKey('thanks-ok'), label: l.ok, onPressed: onDone)),
    );
  }
}
