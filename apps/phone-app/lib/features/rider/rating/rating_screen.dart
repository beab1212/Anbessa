// Rating the other side after a trip (workflow 08 E): 1–5 stars, what stood out, a comment;
// once per side, within 7 days.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../flagged/flagged_modules.dart';
import '../shell/rider_map_shell.dart' show driverAvatarHeroTag;
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
  final _tags = <String>{};
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
    final parties = ref.watch(tripPartiesProvider(widget.tripId)).value;
    final name = widget.asDriver ? (parties?.riderName ?? l.riderLabel) : (parties?.driverName ?? l.driverLabel);
    final photo = widget.asDriver ? parties?.riderPhoto : parties?.driverPhoto;
    final all = widget.asDriver ? RatingTags.ofRider : RatingTags.ofDriver;
    // good tags first for good ratings, the other way round otherwise
    final tags = _stars == 0 ? all : [...all.where((t) => RatingTags.positive.contains(t) == (_stars >= 4)), ...all.where((t) => RatingTags.positive.contains(t) != (_stars >= 4))];
    return Scaffold(
      appBar: AppBar(title: Text(l.rateTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (_done) ...[
            IllustratedEmpty(illustration: AnbessaIllustration.celebrate, title: l.thanksRating, action: SizedBox(width: 200, child: PrimaryButton(label: l.done, onPressed: _finish))),
          ] else ...[
            Center(
              child: widget.asDriver
                  ? AvatarImage(src: photo, name: name, size: 80, ring: true)
                  // the driver's photo flies in from the trip sheet or the pay page
                  : Hero(tag: driverAvatarHeroTag(widget.tripId), child: AvatarImage(src: photo, name: name, size: 80, ring: true)),
            ),
            const SizedBox(height: 12),
            Text(name, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text)),
            const SizedBox(height: 4),
            Text(widget.asDriver ? l.rateRiderLede : l.rateDriverLede(name), textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2)),
            const SizedBox(height: 20),
            Center(child: RatingStars(value: _stars, size: 46, onChanged: (v) => setState(() => _stars = v))),
            AnimatedSwitcherX(
              child: _stars == 0
                  ? const SizedBox(height: 16, key: ValueKey('none'))
                  : Padding(
                      key: const ValueKey('tags'),
                      padding: const EdgeInsets.only(top: 20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(l.whatStoodOut, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4)),
                          const SizedBox(height: 8),
                          TagChips(tags: tags, selected: _tags, label: (t) => ratingTagLabel(l, t), onToggle: (t) => setState(() => _tags.contains(t) ? _tags.remove(t) : (_tags.length < 5 ? _tags.add(t) : null))),
                          const SizedBox(height: 16),
                        ],
                      ),
                    ),
            ),
            TextField(controller: _comment, maxLines: 3, maxLength: 500, decoration: InputDecoration(labelText: l.ratingComment)),
            if (!widget.asDriver) ...[
              const SizedBox(height: 8),
              SectionGroup(
                margin: EdgeInsets.zero,
                children: [SettingsTile(icon: Icons.volunteer_activism_outlined, title: l.addTip, badge: kTipsEnabled ? null : StatusPill(l.comingSoon, tone: Tone.grey), chevron: false)],
              ),
            ],
            const SizedBox(height: 12),
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
