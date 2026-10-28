// Driver onboarding (workflow 02): apply, upload the driver's documents, register a car and its
// documents, submit for review, wait. Uploads: sha256 → upload-url ticket → PUT bytes → confirm.
// The hub shows where the driver is (Apply → Documents → Vehicle → Review) and the one thing to
// do next.

import 'dart:typed_data';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/ux/kit_group.dart';
import '../../config/client_config_provider.dart';
import '../shift/shift_controller.dart';

Tone _docTone(DocumentStatus? s) => switch (s) { DocumentStatus.approved => Tone.green, DocumentStatus.pending => Tone.amber, DocumentStatus.rejected || DocumentStatus.expired => Tone.red, _ => Tone.grey };
Tone _driverTone(DriverStatus s) => switch (s) { DriverStatus.active => Tone.green, DriverStatus.pendingReview => Tone.amber, DriverStatus.suspended || DriverStatus.changesRequested => Tone.red, _ => Tone.grey };
Tone _vehicleTone(VehicleStatus s) => switch (s) { VehicleStatus.verified => Tone.green, VehicleStatus.pendingReview => Tone.amber, VehicleStatus.rejected || VehicleStatus.suspended => Tone.red, _ => Tone.grey };

String _docLabel(AppLocalizations l, DocumentView d) => switch (d.status) {
      DocumentStatus.approved => d.expiringSoon ? l.expiringSoon : l.docApproved,
      DocumentStatus.pending => l.docPending,
      DocumentStatus.rejected => l.vehicleRejected,
      DocumentStatus.expired => l.docExpired.split(':').first,
      DocumentStatus.unknown => '—',
    };

/// Where the driver is in the four steps, and what's done.
class OnboardingProgress {
  const OnboardingProgress({required this.current, required this.done, required this.docsDone, required this.docsTotal});
  final int current;
  final Set<int> done;
  final int docsDone;
  final int docsTotal;

  static OnboardingProgress of(DriverHome? home, {required bool canDrive}) {
    final d = home?.driver;
    if (d == null) return const OnboardingProgress(current: 0, done: {}, docsDone: 0, docsTotal: 0);
    final req = d.checklist.items.where((i) => i.required).toList();
    final docsDone = req.where((i) => !i.needsUpload).length;
    final hasCar = home!.allVehicles.isNotEmpty;
    if (d.status == DriverStatus.active) return OnboardingProgress(current: 3, done: const {0, 1, 2, 3}, docsDone: docsDone, docsTotal: req.length);
    if (d.status == DriverStatus.pendingReview) return OnboardingProgress(current: 3, done: const {0, 1, 2}, docsDone: docsDone, docsTotal: req.length);
    final done = <int>{0, if (d.checklist.readyToSubmit) 1, if (hasCar) 2};
    final current = !d.checklist.readyToSubmit ? 1 : !hasCar ? 2 : 3;
    return OnboardingProgress(current: current, done: done, docsDone: docsDone, docsTotal: req.length);
  }

  /// 0..1 across apply + required docs + a car + submitted
  double get fraction {
    if (done.contains(3)) return 1;
    final steps = 2 + docsTotal + 1;
    final got = (done.contains(0) ? 1 : 0) + docsDone + (done.contains(2) ? 1 : 0) + (done.contains(3) || current == 3 && done.contains(2) ? 1 : 0);
    return (got / steps).clamp(0.0, 1.0);
  }
}

class OnboardingHubScreen extends ConsumerWidget {
  const OnboardingHubScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final homeAsync = ref.watch(driverHomeProvider);
    final home = homeAsync.value;
    final session = ref.watch(currentSessionProvider);
    final d = home?.driver;
    final p = OnboardingProgress.of(home, canDrive: session?.canDrive == true);
    final approved = d?.status == DriverStatus.active;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.onboardingTitle, leadingKind: Navigator.of(context).canPop() ? TopBarLeading.back : TopBarLeading.none),
      body: RefreshIndicator(
        onRefresh: () async {
          await ref.read(driverHomeProvider.notifier).refresh();
          await ref.read(sessionProvider.notifier).refreshClaims();
        },
        child: CustomScrollView(
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 32),
              sliver: SliverList.list(
                children: [
                  if (homeAsync.hasError) Problem(homeAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(driverHomeProvider.notifier).refresh(), retryLabel: l.retry),
                  if (home == null && !homeAsync.hasError) const SkeletonList(rows: 4),
                  if (home != null) ...[
                    AppCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          StepperHeader(steps: [l.stepApply, l.stepDocuments, l.stepVehicle, l.stepReview], current: p.current, done: p.done),
                          const SizedBox(height: 18),
                          if (approved)
                            IllustratedEmpty(illustration: AnbessaIllustration.celebrate, title: l.waitingForReviewTitle.replaceFirst(l.waitingForReviewTitle, driverStatusLabel(l, DriverStatus.active)), body: session?.canDrive == true ? l.approvedLede : l.waitingForReviewLede, compact: true, action: session?.canDrive == true ? PrimaryButton(label: l.goOnline, icon: Icons.power_settings_new_rounded, onPressed: () => context.go(Routes.driverHome)) : null)
                          else if (d?.status == DriverStatus.pendingReview)
                            IllustratedEmpty(illustration: AnbessaIllustration.documents, title: l.waitingForReviewTitle, body: l.waitingForReviewLede, compact: true)
                          else
                            _NextAction(progress: p, driver: d, home: home),
                        ],
                      ),
                    ),
                    if (d != null) ...[
                      if (d.reviewNote != null) Padding(padding: const EdgeInsets.only(top: 12), child: Notice(l.reviewNote(d.reviewNote!), tone: NoticeTone.warning)),
                      const SizedBox(height: 20),
                      KitGroup(
                        title: l.yourApplication,
                        children: [
                          ListRowTile(leading: const KitRowIcon(Icons.badge_outlined), title: d.fullName, subtitle: '${l.licenseNumber} ${d.licenseNumber}', valueSub: driverStatusLabel(l, d.status), valueSubColor: kitToneText(context, _driverTone(d.status))),
                        ],
                      ),
                      const SizedBox(height: 20),
                      _ChecklistGroup(title: l.driverDocuments, items: d.checklist.items, onOpen: () => context.push(Routes.driverDocuments('DRIVER', d.userId))),
                      const SizedBox(height: 20),
                      KitGroup(
                        title: l.vehiclesTitle,
                        children: [
                          if (home.allVehicles.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Text(l.noVehicles, style: AnbessaType.body2.copyWith(color: c.muted))),
                          for (final v in home.allVehicles)
                            ListRowTile(
                              leading: KitRowIcon(vehicleIcon(v.vehicleType)),
                              title: '${v.plateNumber} · ${v.label}',
                              subtitle: v.isFleet ? l.fleetCar : null,
                              valueSub: vehicleStatusLabel(l, v.status), valueSubColor: kitToneText(context, _vehicleTone(v.status)),
                              chevron: !v.isFleet,
                              onTap: v.isFleet ? null : () => context.push(Routes.driverVehicle(v.id)),
                            ),
                          ListRowTile(leading: const KitRowIcon(Icons.add_rounded), title: l.addVehicle, titleColor: c.accentText, onTap: () => context.push(Routes.driverVehicleNew)),
                        ],
                      ),
                    ],
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The ring and the one button that moves the application forward.
class _NextAction extends ConsumerWidget {
  const _NextAction({required this.progress, required this.driver, required this.home});
  final OnboardingProgress progress;
  final DriverProfile? driver;
  final DriverHome home;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final d = driver;
    final (title, body) = switch (progress.current) {
      0 => (l.onboardingTitle, l.onboardingLede),
      1 => (l.uploadDocuments, progress.docsTotal - progress.docsDone > 0 ? l.docsMissingCount(progress.docsTotal - progress.docsDone) : l.allDocsIn),
      2 => (l.registerCar, l.noVehicles),
      _ => (l.reviewAndSubmit, d?.checklist.readyToSubmit == true ? l.submittedForReview.split('.').last.trim() : l.missingDocs(d?.checklist.missingForSubmit.map((k) => documentKindLabel(l, k)).join(', ') ?? '')),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            _ProgressRing(fraction: progress.fraction, label: progress.docsTotal == 0 ? null : l.checklistProgress(progress.docsDone, progress.docsTotal)),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l.nextStep, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4)),
                  const SizedBox(height: 2),
                  Text(title, style: AnbessaType.h2.copyWith(color: c.text)),
                  const SizedBox(height: 4),
                  Text(body, style: AnbessaType.body2.copyWith(color: c.text2)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        switch (progress.current) {
          0 => PrimaryButton(label: l.apply, icon: Icons.badge_rounded, onPressed: () => context.push(Routes.driverApply)),
          1 => PrimaryButton(label: l.upload, icon: Icons.upload_file_rounded, onPressed: () => context.push(Routes.driverDocuments('DRIVER', d!.userId))),
          2 => PrimaryButton(label: l.addVehicle, icon: Icons.directions_car_rounded, onPressed: () => context.push(Routes.driverVehicleNew)),
          _ => _SubmitButton(ready: d?.checklist.readyToSubmit == true, missing: d?.checklist.missingForSubmit ?? const []),
        },
      ],
    );
  }
}

class _ProgressRing extends StatelessWidget {
  const _ProgressRing({required this.fraction, this.label});
  final double fraction;
  final String? label;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      label: label,
      value: '${(fraction * 100).round()}%',
      child: SizedBox(
        width: 72,
        height: 72,
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: fraction),
          duration: AnbessaMotion.of(context, AnbessaMotion.slow),
          curve: Curves.easeOutCubic,
          builder: (context, v, _) => Stack(
            fit: StackFit.expand,
            children: [
              CircularProgressIndicator(value: v, strokeWidth: 7, strokeCap: StrokeCap.round, backgroundColor: c.border, color: c.accent),
              Center(child: Text('${(v * 100).round()}%', style: AnbessaType.label.copyWith(color: c.text, fontFeatures: AnbessaType.tabular))),
            ],
          ),
        ),
      ),
    );
  }
}

class _ChecklistGroup extends StatelessWidget {
  const _ChecklistGroup({this.title, required this.items, required this.onOpen});
  final String? title;
  final List<ChecklistItem> items;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return KitGroup(
      title: title,
      children: [
        for (final i in items)
          ListRowTile(
            leading: KitRowIcon(
              i.document?.status == DocumentStatus.approved ? Icons.check_rounded : i.document == null ? Icons.upload_file_outlined : Icons.hourglass_top_rounded,
              color: i.document?.status == DocumentStatus.approved ? c.success : i.document == null ? c.muted : c.warning,
            ),
            title: documentKindLabel(l, i.kind),
            subtitle: i.required ? null : l.optional,
            valueSub: i.document == null ? null : _docLabel(l, i.document!),
            valueSubColor: i.document == null ? null : kitToneText(context, _docTone(i.document!.status)),
            chevron: true,
            onTap: onOpen,
          ),
      ],
    );
  }
}

class _SubmitButton extends ConsumerStatefulWidget {
  const _SubmitButton({required this.ready, required this.missing});
  final bool ready;
  final List<DocumentKind> missing;
  @override
  ConsumerState<_SubmitButton> createState() => _SubmitButtonState();
}

class _SubmitButtonState extends ConsumerState<_SubmitButton> {
  bool _busy = false;
  Object? _error;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Problem(_error, describe: (e) => describeError(l, e)),
        PrimaryButton(
          label: l.submitForReview,
          icon: Icons.send_rounded,
          busy: _busy,
          onPressed: !widget.ready
              ? null
              : () async {
                  setState(() {
                    _busy = true;
                    _error = null;
                  });
                  try {
                    await ref.read(apisProvider).fleet.submit();
                    await ref.read(driverHomeProvider.notifier).refresh();
                    Haptics.success();
                    if (context.mounted) showToast(context, l.submittedForReview);
                  } catch (e) {
                    Haptics.error();
                    setState(() => _error = e);
                  } finally {
                    if (mounted) setState(() => _busy = false);
                  }
                },
        ),
      ],
    );
  }
}

class ApplyScreen extends ConsumerStatefulWidget {
  const ApplyScreen({super.key});
  @override
  ConsumerState<ApplyScreen> createState() => _ApplyScreenState();
}

class _ApplyScreenState extends ConsumerState<ApplyScreen> {
  final _name = TextEditingController();
  final _licence = TextEditingController();
  String? _city;
  bool _busy = false;
  Object? _error;

  Future<void> _apply() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apisProvider).fleet.apply(fullName: _name.text.trim(), licenseNumber: _licence.text.trim(), cityId: _city ?? ref.read(currentCityProvider).id);
      await ref.read(driverHomeProvider.notifier).refresh();
      Haptics.success();
      if (mounted) context.pop();
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final cfg = ref.watch(configProvider);
    final city = _city ?? ref.watch(currentCityProvider).id;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.applyTitle),
      bottomNavigationBar: BottomActionBar(child: PillButton(label: l.apply, busy: _busy, onPressed: _name.text.trim().length < 3 || _licence.text.trim().length < 4 ? null : _apply)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          StepperHeader(steps: [l.stepApply, l.stepDocuments, l.stepVehicle, l.stepReview], current: 0),
          const SizedBox(height: 20),
          Text(l.applyLede, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 24),
          FilledField(label: l.fullName, controller: _name, icon: Icons.person_outline_rounded, textCapitalization: TextCapitalization.words, autofillHints: const [AutofillHints.name], onChanged: (_) => setState(() {})),
          const SizedBox(height: 24),
          FilledField(label: l.licenseNumber, controller: _licence, icon: Icons.badge_outlined, textCapitalization: TextCapitalization.characters, onChanged: (_) => setState(() {})),
          const SizedBox(height: 24),
          FieldLabel(l.cityLabel),
          DropdownButtonFormField<String>(
            initialValue: city,
            icon: const Icon(Icons.keyboard_arrow_down_rounded),
            decoration: const InputDecoration(prefixIcon: Icon(Icons.location_city_outlined)),
            items: [for (final c in cfg.cities) DropdownMenuItem(value: c.id, child: Text(c.name))],
            onChanged: (v) => setState(() => _city = v),
          ),
          const SizedBox(height: 16),
          Problem(_error, describe: (e) => describeError(l, e)),
        ],
      ),
    );
  }
}

/// Upload the documents of a driver or a car: one card per kind with a thumbnail, camera /
/// gallery, expiry date, and the upload's progress.
class DocumentsScreen extends ConsumerStatefulWidget {
  const DocumentsScreen({super.key, required this.subjectType, required this.subjectId});
  final String subjectType;
  final String subjectId;
  @override
  ConsumerState<DocumentsScreen> createState() => _DocumentsScreenState();
}

class _DocumentsScreenState extends ConsumerState<DocumentsScreen> {
  late Future<List<ChecklistItem>> _items = _load();
  DocumentKind? _uploading;
  double _progress = 0;
  Object? _error;

  Future<List<ChecklistItem>> _load() => ref.read(apisProvider).fleet.documents(subjectType: widget.subjectType, subjectId: widget.subjectId);

  Future<void> _pick(ChecklistItem item) async {
    final l = context.l10n;
    final c = context.colors;
    final choice = await showHandleSheet<String>(
      context,
      title: documentKindLabel(l, item.kind),
      builder: (ctx) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(documentHint(l, item.kind), textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 8),
          ListRowTile(leading: const KitRowIcon(Icons.photo_camera_outlined), title: l.takePhoto, chevron: true, divider: true, onTap: () => Navigator.pop(ctx, 'camera')),
          ListRowTile(leading: const KitRowIcon(Icons.photo_library_outlined), title: l.chooseFromGallery, chevron: true, onTap: () => Navigator.pop(ctx, 'gallery')),
        ],
      ),
    );
    if (choice == null) return;
    final picker = ImagePicker();
    final file = await picker.pickImage(source: choice == 'camera' ? ImageSource.camera : ImageSource.gallery, maxWidth: 2000, imageQuality: 85);
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (bytes.length > 10 * 1024 * 1024) return setState(() => _error = AppError(status: 400, code: 'too_large', message: l.uploadTooLarge));
    String? expiresAt;
    if (item.expires) {
      if (!mounted) return;
      final d = await showDatePicker(context: context, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365 * 15)), initialDate: DateTime.now().add(const Duration(days: 365)), helpText: l.expiresOn);
      if (d == null) return;
      expiresAt = '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
    }
    await _upload(item.kind, bytes, file.mimeType ?? 'image/jpeg', expiresAt);
  }

  Future<void> _upload(DocumentKind kind, Uint8List bytes, String contentType, String? expiresAt) async {
    setState(() {
      _uploading = kind;
      _progress = 0;
      _error = null;
    });
    try {
      final fleet = ref.read(apisProvider).fleet;
      final hash = sha256.convert(bytes).toString();
      final ticket = await fleet.uploadUrl(subjectType: widget.subjectType, subjectId: widget.subjectId, kind: kind, contentType: contentType, sizeBytes: bytes.length, sha256Hex: hash);
      await fleet.putFile(ticket, bytes, onProgress: (sent, total) {
        if (mounted && total > 0) setState(() => _progress = sent / total);
      });
      await fleet.confirmDocument(ticket.ticket, expiresAt: expiresAt);
      Haptics.success();
      setState(() => _items = _load());
      ref.read(driverHomeProvider.notifier).refresh();
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _uploading = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Scaffold(
      backgroundColor: context.colors.page,
      appBar: AppTopBar(title: widget.subjectType == 'DRIVER' ? l.driverDocuments : l.vehicleDocuments),
      body: FutureBuilder(
        future: _items,
        builder: (context, snap) {
          if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e), onRetry: () => setState(() => _items = _load()), retryLabel: l.retry));
          final items = snap.data;
          if (items == null) return const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 4));
          return ListView(
            padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
            children: [
              Problem(_error, describe: (e) => describeError(l, e)),
              for (final (n, i) in items.indexed)
                FadeSlideIn(
                  delay: Duration(milliseconds: 40 * n),
                  child: _DocumentCard(item: i, uploading: _uploading == i.kind, progress: _progress, enabled: _uploading == null, onPick: () => _pick(i)),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _DocumentCard extends StatelessWidget {
  const _DocumentCard({required this.item, required this.uploading, required this.progress, required this.enabled, required this.onPick});
  final ChecklistItem item;
  final bool uploading;
  final double progress;
  final bool enabled;
  final VoidCallback onPick;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final d = item.document;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: AppCard(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DocumentThumb(document: d, kind: item.kind),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(child: Text(documentKindLabel(l, item.kind), style: AnbessaType.title.copyWith(color: c.text))),
                          if (d != null) StatusPill(_docLabel(l, d), tone: _docTone(d.status)),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        d == null
                            ? '${documentHint(l, item.kind)}${item.expires ? ' ${l.expiryRequired}' : ''}'
                            : d.status == DocumentStatus.rejected
                                ? l.docRejected(d.rejectReason ?? '')
                                : d.expiresAt != null
                                    ? '${l.expiresOn} ${d.expiresAt}'
                                    : documentHint(l, item.kind),
                        style: AnbessaType.caption.copyWith(color: d?.status == DocumentStatus.rejected ? c.danger : c.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (uploading) ...[
              LinearProgressIndicator(value: progress <= 0 ? null : progress, minHeight: 6, borderRadius: BorderRadius.circular(3)),
              const SizedBox(height: 6),
              Text(l.uploadingPercent((progress * 100).round()), style: AnbessaType.caption.copyWith(color: c.muted)),
            ] else
              Row(
                children: [
                  if (d != null) ...[
                    Expanded(child: PillButton(label: l.viewDocument, variant: PillVariant.outlineNeutral, compact: true, onPressed: enabled ? () => _view(context, d) : null)),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    child: item.needsUpload
                        ? PillButton(label: l.upload, icon: Icons.upload_file_rounded, compact: true, onPressed: enabled ? onPick : null)
                        : PillButton(label: l.replace, variant: PillVariant.tonal, compact: true, onPressed: enabled ? onPick : null),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _view(BuildContext context, DocumentView d) async {
    final container = ProviderScope.containerOf(context);
    try {
      final u = await container.read(apisProvider).fleet.documentUrl(d.id);
      await launchUrl(Uri.parse(u.url), mode: LaunchMode.inAppBrowserView);
    } catch (e) {
      if (context.mounted) showToast(context, describeError(context.l10n, e));
    }
  }
}

/// A small preview of an uploaded document: the image when it's one, otherwise a glyph.
class DocumentThumb extends ConsumerStatefulWidget {
  const DocumentThumb({super.key, required this.document, required this.kind, this.size = 64});
  final DocumentView? document;
  final DocumentKind kind;
  final double size;
  @override
  ConsumerState<DocumentThumb> createState() => _DocumentThumbState();
}

class _DocumentThumbState extends ConsumerState<DocumentThumb> {
  Future<DocumentUrl>? _url;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  @override
  void didUpdateWidget(DocumentThumb old) {
    super.didUpdateWidget(old);
    if (old.document?.id != widget.document?.id) _fetch();
  }

  void _fetch() {
    final d = widget.document;
    _url = d != null && d.isImage ? ref.read(apisProvider).fleet.documentUrl(d.id) : null;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = widget.document;
    // a plain file-type label instead of a glyph; an empty slot stays blank
    final glyph = Text(d == null ? '' : d.isImage ? 'IMG' : 'PDF', style: AnbessaType.caption.copyWith(color: c.muted, fontWeight: FontWeight.w700, letterSpacing: 0.5));
    return ClipRRect(
      borderRadius: BorderRadius.circular(AnbessaRadius.sm),
      child: Container(
        width: widget.size,
        height: widget.size,
        color: c.isDark ? c.surface2 : c.canvas,
        child: _url == null
            ? Center(child: glyph)
            : FutureBuilder(
                future: _url,
                builder: (context, snap) {
                  final u = snap.data;
                  if (u == null) return snap.hasError ? Center(child: glyph) : const Skeleton.box();
                  return CachedNetworkImage(imageUrl: u.url, fit: BoxFit.cover, errorWidget: (_, _, _) => Center(child: glyph), placeholder: (_, _) => const Skeleton.box());
                },
              ),
      ),
    );
  }
}

class VehicleFormScreen extends ConsumerStatefulWidget {
  const VehicleFormScreen({super.key});
  @override
  ConsumerState<VehicleFormScreen> createState() => _VehicleFormScreenState();
}

class _VehicleFormScreenState extends ConsumerState<VehicleFormScreen> {
  final _plate = TextEditingController();
  final _make = TextEditingController();
  final _model = TextEditingController();
  final _year = TextEditingController(text: '2018');
  final _color = TextEditingController();
  int _seats = 4;
  String? _type;
  bool _busy = false;
  Object? _error;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final v = await ref.read(apisProvider).fleet.registerVehicle(
            plateNumber: _plate.text.trim(), vehicleType: _type ?? ref.read(configProvider).vehicleTypes.firstOrNull?.code ?? 'economy', make: _make.text.trim(), model: _model.text.trim(),
            year: int.tryParse(_year.text) ?? 2018, color: _color.text.trim(), seats: _seats,
          );
      await ref.read(driverHomeProvider.notifier).refresh();
      Haptics.success();
      if (mounted) context.pushReplacement(Routes.driverVehicle(v.id));
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final cfg = ref.watch(configProvider);
    final type = _type ?? cfg.vehicleTypes.firstOrNull?.code;
    final ok = _plate.text.trim().length >= 4 && _make.text.trim().isNotEmpty && _model.text.trim().isNotEmpty && _color.text.trim().isNotEmpty;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.addVehicle),
      bottomNavigationBar: BottomActionBar(child: PillButton(label: l.registerVehicle, busy: _busy, onPressed: ok ? _save : null)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          Text(l.vehicleFormLede, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 24),
          FilledField(label: l.plateNumber, hint: '3-A40402', controller: _plate, icon: Icons.pin_outlined, textCapitalization: TextCapitalization.characters, onChanged: (_) => setState(() {})),
          const SizedBox(height: 24),
          FieldLabel(l.vehicleType),
          SizedBox(
            height: 104,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: cfg.vehicleTypes.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final t = cfg.vehicleTypes[i];
                final sel = t.code == type;
                return Semantics(
                  button: true,
                  selected: sel,
                  child: GestureDetector(
                    onTap: () {
                      Haptics.selection();
                      setState(() => _type = t.code);
                    },
                    child: AnimatedContainer(
                      duration: AnbessaMotion.of(context, AnbessaMotion.base),
                      width: 112,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: sel ? c.selectedFill : c.cardFill,
                        borderRadius: BorderRadius.circular(AnbessaRadius.md),
                        border: Border.all(color: sel ? c.accent : c.cardBorder, width: sel ? 1.5 : 1),
                      ),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          ExcludeSemantics(child: VehicleArt(t.code, width: 72)),
                          const SizedBox(height: 6),
                          Text(t.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.text, fontWeight: FontWeight.w700)),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 24),
          // two fields side by side, as on the kit's card form
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: FilledField(label: l.make, controller: _make, onChanged: (_) => setState(() {}))),
            const SizedBox(width: 12),
            Expanded(child: FilledField(label: l.model, controller: _model, onChanged: (_) => setState(() {}))),
          ]),
          const SizedBox(height: 24),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: FilledField(label: l.year, controller: _year, keyboardType: TextInputType.number)),
            const SizedBox(width: 12),
            Expanded(child: FilledField(label: l.color, controller: _color, onChanged: (_) => setState(() {}))),
          ]),
          const SizedBox(height: 24),
          FieldLabel(l.seats),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (var s = 2; s <= 8; s++)
                OutlineChip(
                  label: '$s',
                  selected: _seats == s,
                  onTap: () {
                    Haptics.selection();
                    setState(() => _seats = s);
                  },
                ),
            ],
          ),
          const SizedBox(height: 16),
          Problem(_error, describe: (e) => describeError(l, e)),
        ],
      ),
    );
  }
}

class VehicleScreen extends ConsumerStatefulWidget {
  const VehicleScreen({super.key, required this.vehicleId});
  final String vehicleId;
  @override
  ConsumerState<VehicleScreen> createState() => _VehicleScreenState();
}

class _VehicleScreenState extends ConsumerState<VehicleScreen> {
  late Future<(Vehicle, Checklist)> _data = _load();
  bool _busy = false;
  Object? _error;

  Future<(Vehicle, Checklist)> _load() async {
    final fleet = ref.read(apisProvider).fleet;
    final v = await fleet.vehicle(widget.vehicleId);
    final cl = await fleet.vehicleChecklist(widget.vehicleId);
    return (v, cl);
  }

  Future<void> _submit(Vehicle v) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apisProvider).fleet.submitVehicle(v.id);
      await ref.read(driverHomeProvider.notifier).refresh();
      Haptics.success();
      setState(() => _data = _load());
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.vehicleLabel),
      body: FutureBuilder(
        future: _data,
        builder: (context, snap) {
          if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e), onRetry: () => setState(() => _data = _load()), retryLabel: l.retry));
          final d = snap.data;
          if (d == null) return const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 4));
          final (v, cl) = d;
          final req = cl.items.where((i) => i.required).toList();
          final done = req.where((i) => !i.needsUpload).length;
          return ListView(
            padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
            children: [
              AppCard(
                child: Row(
                  children: [
                    ExcludeSemantics(child: VehicleArt(v.vehicleType, width: 88)),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(v.plateNumber, style: AnbessaType.h2.copyWith(color: c.text, fontFeatures: AnbessaType.tabular)),
                          Text('${v.label} · ${v.year} · ${v.seats} ${l.seats.toLowerCase()}', style: AnbessaType.body2.copyWith(color: c.text2)),
                          const SizedBox(height: 6),
                          StatusPill(vehicleStatusLabel(l, v.status), tone: _vehicleTone(v.status)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              if (v.reviewNote != null) Padding(padding: const EdgeInsets.only(top: 12), child: Notice(l.reviewNote(v.reviewNote!), tone: NoticeTone.warning)),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(child: Text(l.vehicleDocuments, style: AnbessaType.title.copyWith(color: c.text))),
                  Text(l.checklistProgress(done, req.length), style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ),
              const SizedBox(height: 10),
              _ChecklistGroup(items: cl.items, onOpen: () => context.push(Routes.driverDocuments('VEHICLE', v.id)).then((_) => setState(() => _data = _load()))),
              const SizedBox(height: 16),
              if (v.status == VehicleStatus.draft || v.status == VehicleStatus.rejected) ...[
                if (!cl.readyToSubmit) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(l.missingDocs(cl.missingForSubmit.map((k) => documentKindLabel(l, k)).join(', ')), style: AnbessaType.caption.copyWith(color: c.muted))),
                Problem(_error, describe: (e) => describeError(l, e)),
                PrimaryButton(label: l.submitForReview, icon: Icons.send_rounded, busy: _busy, onPressed: !cl.readyToSubmit ? null : () => _submit(v)),
              ],
            ],
          );
        },
      ),
    );
  }
}
