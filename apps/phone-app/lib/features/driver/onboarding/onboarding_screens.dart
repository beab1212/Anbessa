// Driver onboarding (workflow 02): apply, upload the driver's documents, register a car and its
// documents, submit for review, wait. Uploads: sha256 → upload-url ticket → PUT bytes → confirm.

import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';
import '../shift/shift_controller.dart';

Tone _docTone(DocumentStatus? s) => switch (s) { DocumentStatus.approved => Tone.green, DocumentStatus.pending => Tone.amber, DocumentStatus.rejected || DocumentStatus.expired => Tone.red, _ => Tone.grey };

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
    return Scaffold(
      appBar: AppBar(title: Text(l.onboardingTitle), actions: [IconButton(onPressed: () => ref.read(driverHomeProvider.notifier).refresh(), icon: const Icon(Icons.refresh), tooltip: l.refresh)]),
      body: RefreshIndicator(
        onRefresh: () async {
          await ref.read(driverHomeProvider.notifier).refresh();
          await ref.read(sessionProvider.notifier).refreshClaims();
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (homeAsync.hasError) Problem(homeAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(driverHomeProvider.notifier).refresh(), retryLabel: l.retry),
            if (home == null && !homeAsync.hasError) const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator())),
            if (home != null && d == null) ...[
              Text(l.onboardingLede, style: TextStyle(color: c.text2, fontSize: 15)),
              const SizedBox(height: 16),
              PrimaryButton(label: l.apply, icon: Icons.badge_outlined, onPressed: () => context.push(Routes.driverApply)),
            ],
            if (d != null) ...[
              SectionCard(
                title: d.fullName,
                trailing: StatusPill(driverStatusLabel(l, d.status), tone: switch (d.status) { DriverStatus.active => Tone.green, DriverStatus.pendingReview => Tone.amber, DriverStatus.suspended || DriverStatus.changesRequested => Tone.red, _ => Tone.grey }),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (d.reviewNote != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Notice(l.reviewNote(d.reviewNote!), tone: NoticeTone.warning)),
                    if (d.status == DriverStatus.pendingReview) Text(l.waitingForReviewLede, style: TextStyle(color: c.text2)),
                    if (d.status == DriverStatus.active && session?.canDrive == false) Text(l.waitingForReviewLede, style: TextStyle(color: c.text2)),
                    if (d.status == DriverStatus.active && session?.canDrive == true) TextButton.icon(onPressed: () => context.go(Routes.driverHome), icon: const Icon(Icons.power_settings_new), label: Text(l.goOnline)),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              _ChecklistCard(title: l.driverDocuments, items: d.checklist.items, onOpen: () => context.push(Routes.driverDocuments('DRIVER', d.userId))),
              const SizedBox(height: 12),
              SectionCard(
                title: l.vehiclesTitle,
                trailing: TextButton.icon(onPressed: () => context.push(Routes.driverVehicleNew), icon: const Icon(Icons.add), label: Text(l.addVehicle)),
                child: Column(
                  children: [
                    if (home!.allVehicles.isEmpty) Text(l.noVehicles, style: TextStyle(color: c.muted)),
                    for (final v in home.allVehicles)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.directions_car),
                        title: Text('${v.plateNumber} · ${v.label}'),
                        subtitle: Text(v.isFleet ? l.fleetCar : vehicleStatusLabel(l, v.status)),
                        trailing: StatusPill(vehicleStatusLabel(l, v.status), tone: switch (v.status) { VehicleStatus.verified => Tone.green, VehicleStatus.pendingReview => Tone.amber, VehicleStatus.rejected || VehicleStatus.suspended => Tone.red, _ => Tone.grey }),
                        onTap: v.isFleet ? null : () => context.push(Routes.driverVehicle(v.id)),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              if (d.status == DriverStatus.applied || d.status == DriverStatus.changesRequested) _SubmitButton(ready: d.checklist.readyToSubmit, missing: d.checklist.missingForSubmit),
            ],
          ],
        ),
      ),
    );
  }
}

class _ChecklistCard extends StatelessWidget {
  const _ChecklistCard({required this.title, required this.items, required this.onOpen});
  final String title;
  final List<ChecklistItem> items;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return SectionCard(
      title: title,
      trailing: TextButton(onPressed: onOpen, child: Text(l.upload)),
      child: Column(
        children: [
          for (final i in items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: Icon(i.document?.status == DocumentStatus.approved ? Icons.check_circle : i.document == null ? Icons.radio_button_unchecked : Icons.pending_outlined),
              title: Text(documentKindLabel(l, i.kind)),
              trailing: i.document == null ? null : StatusPill(_docLabel(l, i.document!), tone: _docTone(i.document!.status)),
              onTap: onOpen,
            ),
        ],
      ),
    );
  }
}

String _docLabel(AppLocalizations l, DocumentView d) => switch (d.status) {
      DocumentStatus.approved => d.expiringSoon ? l.expiringSoon : l.docApproved,
      DocumentStatus.pending => l.docPending,
      DocumentStatus.rejected => l.vehicleRejected,
      DocumentStatus.expired => l.docExpired.split(':').first,
      DocumentStatus.unknown => '—',
    };

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
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!widget.ready) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(l.missingDocs(widget.missing.map((k) => documentKindLabel(l, k)).join(', ')), style: TextStyle(color: c.muted))),
        Problem(_error, describe: (e) => describeError(l, e)),
        PrimaryButton(
          label: l.submitForReview,
          busy: _busy,
          onPressed: !widget.ready
              ? null
              : () async {
                  final messenger = ScaffoldMessenger.of(context);
                  setState(() {
                    _busy = true;
                    _error = null;
                  });
                  try {
                    await ref.read(apisProvider).fleet.submit();
                    await ref.read(driverHomeProvider.notifier).refresh();
                    messenger.showSnackBar(SnackBar(content: Text(l.submittedForReview)));
                  } catch (e) {
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
      if (mounted) context.pop();
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final cfg = ref.watch(configProvider);
    final city = _city ?? ref.watch(currentCityProvider).id;
    return Scaffold(
      appBar: AppBar(title: Text(l.applyTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: InputDecoration(labelText: l.fullName), onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          TextField(controller: _licence, textCapitalization: TextCapitalization.characters, decoration: InputDecoration(labelText: l.licenseNumber), onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: city,
            decoration: InputDecoration(labelText: l.cityLabel),
            items: [for (final c in cfg.cities) DropdownMenuItem(value: c.id, child: Text(c.name))],
            onChanged: (v) => setState(() => _city = v),
          ),
          const SizedBox(height: 12),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          PrimaryButton(label: l.apply, busy: _busy, onPressed: _name.text.trim().length < 3 || _licence.text.trim().length < 4 ? null : _apply),
        ],
      ),
    );
  }
}

/// Upload the documents of a driver or a car: one row per kind, camera / gallery / PDF, expiry date.
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
  Object? _error;

  Future<List<ChecklistItem>> _load() => ref.read(apisProvider).fleet.documents(subjectType: widget.subjectType, subjectId: widget.subjectId);

  Future<void> _pick(ChecklistItem item) async {
    final l = context.l10n;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(leading: const Icon(Icons.photo_camera_outlined), title: Text(l.takePhoto), onTap: () => Navigator.pop(ctx, 'camera')),
            ListTile(leading: const Icon(Icons.photo_library_outlined), title: Text(l.chooseFromGallery), onTap: () => Navigator.pop(ctx, 'gallery')),
          ],
        ),
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
      _error = null;
    });
    try {
      final fleet = ref.read(apisProvider).fleet;
      final hash = sha256.convert(bytes).toString();
      final ticket = await fleet.uploadUrl(subjectType: widget.subjectType, subjectId: widget.subjectId, kind: kind, contentType: contentType, sizeBytes: bytes.length, sha256Hex: hash);
      await fleet.putFile(ticket, bytes);
      await fleet.confirmDocument(ticket.ticket, expiresAt: expiresAt);
      setState(() => _items = _load());
      ref.read(driverHomeProvider.notifier).refresh();
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _uploading = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(widget.subjectType == 'DRIVER' ? l.driverDocuments : l.vehicleDocuments)),
      body: FutureBuilder(
        future: _items,
        builder: (context, snap) {
          if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e), onRetry: () => setState(() => _items = _load()), retryLabel: l.retry));
          final items = snap.data;
          if (items == null) return const Center(child: CircularProgressIndicator());
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Problem(_error, describe: (e) => describeError(l, e)),
              for (final i in items)
                Card(
                  margin: const EdgeInsets.only(bottom: 10),
                  child: ListTile(
                    contentPadding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                    title: Text(documentKindLabel(l, i.kind), style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: i.document == null
                        ? Text(i.expires ? l.expiryRequired : '', style: TextStyle(color: c.muted, fontSize: 12))
                        : Text(
                            i.document!.status == DocumentStatus.rejected ? l.docRejected(i.document!.rejectReason ?? '') : '${_docLabel(l, i.document!)}${i.document!.expiresAt != null ? ' · ${l.expiresOn} ${i.document!.expiresAt}' : ''}',
                            style: TextStyle(color: i.document!.status == DocumentStatus.rejected ? c.danger : c.muted, fontSize: 12),
                          ),
                    trailing: _uploading == i.kind
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : TextButton.icon(onPressed: _uploading != null ? null : () => _pick(i), icon: const Icon(Icons.upload_file, size: 18), label: Text(i.needsUpload ? l.upload : l.replace)),
                  ),
                ),
            ],
          );
        },
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
            plateNumber: _plate.text.trim(), vehicleType: _type ?? 'economy', make: _make.text.trim(), model: _model.text.trim(),
            year: int.tryParse(_year.text) ?? 2018, color: _color.text.trim(), seats: _seats,
          );
      await ref.read(driverHomeProvider.notifier).refresh();
      if (mounted) context.pushReplacement(Routes.driverVehicle(v.id));
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final cfg = ref.watch(configProvider);
    final ok = _plate.text.trim().length >= 4 && _make.text.trim().isNotEmpty && _model.text.trim().isNotEmpty && _color.text.trim().isNotEmpty;
    return Scaffold(
      appBar: AppBar(title: Text(l.addVehicle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(controller: _plate, textCapitalization: TextCapitalization.characters, decoration: InputDecoration(labelText: l.plateNumber, hintText: '3-A40402'), onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _type ?? cfg.vehicleTypes.firstOrNull?.code,
            decoration: InputDecoration(labelText: l.vehicleType),
            items: [for (final t in cfg.vehicleTypes) DropdownMenuItem(value: t.code, child: Text(t.name))],
            onChanged: (v) => setState(() => _type = v),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: TextField(controller: _make, decoration: InputDecoration(labelText: l.make), onChanged: (_) => setState(() {}))),
            const SizedBox(width: 10),
            Expanded(child: TextField(controller: _model, decoration: InputDecoration(labelText: l.model), onChanged: (_) => setState(() {}))),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: TextField(controller: _year, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: l.year))),
            const SizedBox(width: 10),
            Expanded(child: TextField(controller: _color, decoration: InputDecoration(labelText: l.color), onChanged: (_) => setState(() {}))),
          ]),
          const SizedBox(height: 12),
          DropdownButtonFormField<int>(initialValue: _seats, decoration: InputDecoration(labelText: l.seats), items: [for (var s = 2; s <= 8; s++) DropdownMenuItem(value: s, child: Text('$s'))], onChanged: (v) => setState(() => _seats = v ?? 4)),
          const SizedBox(height: 16),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          PrimaryButton(label: l.registerVehicle, busy: _busy, onPressed: ok ? _save : null),
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

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(l.vehicleLabel)),
      body: FutureBuilder(
        future: _data,
        builder: (context, snap) {
          if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e)));
          final d = snap.data;
          if (d == null) return const Center(child: CircularProgressIndicator());
          final (v, cl) = d;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SectionCard(
                title: '${v.plateNumber} · ${v.label}',
                trailing: StatusPill(vehicleStatusLabel(l, v.status), tone: switch (v.status) { VehicleStatus.verified => Tone.green, VehicleStatus.pendingReview => Tone.amber, VehicleStatus.rejected || VehicleStatus.suspended => Tone.red, _ => Tone.grey }),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${v.vehicleType} · ${v.year} · ${v.seats} ${l.seats.toLowerCase()}', style: TextStyle(color: c.text2)),
                    if (v.reviewNote != null) Padding(padding: const EdgeInsets.only(top: 8), child: Notice(l.reviewNote(v.reviewNote!), tone: NoticeTone.warning)),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              _ChecklistCard(title: l.vehicleDocuments, items: cl.items, onOpen: () => context.push(Routes.driverDocuments('VEHICLE', v.id)).then((_) => setState(() => _data = _load()))),
              const SizedBox(height: 16),
              if (v.status == VehicleStatus.draft || v.status == VehicleStatus.rejected) ...[
                if (!cl.readyToSubmit) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(l.missingDocs(cl.missingForSubmit.map((k) => documentKindLabel(l, k)).join(', ')), style: TextStyle(color: c.muted))),
                Problem(_error, describe: (e) => describeError(l, e)),
                PrimaryButton(
                  label: l.submitForReview,
                  busy: _busy,
                  onPressed: !cl.readyToSubmit
                      ? null
                      : () async {
                          setState(() {
                            _busy = true;
                            _error = null;
                          });
                          try {
                            await ref.read(apisProvider).fleet.submitVehicle(v.id);
                            await ref.read(driverHomeProvider.notifier).refresh();
                            setState(() => _data = _load());
                          } catch (e) {
                            setState(() => _error = e);
                          } finally {
                            if (mounted) setState(() => _busy = false);
                          }
                        },
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}
