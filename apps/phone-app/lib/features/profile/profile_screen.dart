// Name and photo. The photo is resized on the phone to 256 px and sent as a small JPEG data
// URL (the server refuses anything over 48 KB).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/session/session_controller.dart';

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});
  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  late final _name = TextEditingController(text: ref.read(currentSessionProvider)?.profile.name ?? '');
  bool _busy = false;
  bool _photoBusy = false;
  Object? _error;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final p = await ref.read(authApiProvider).updateProfile(name: _name.text.trim());
      await ref.read(sessionProvider.notifier).updateProfile(p);
      Haptics.success();
      if (mounted) showToast(context, context.l10n.nameSaved, tone: NoticeTone.ok);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changePhoto() async {
    final l = context.l10n;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(leading: const Icon(Icons.photo_camera_outlined), title: Text(l.takePhotoOption), onTap: () => Navigator.pop(ctx, 'camera')),
            ListTile(leading: const Icon(Icons.photo_library_outlined), title: Text(l.chooseFromGalleryOption), onTap: () => Navigator.pop(ctx, 'gallery')),
            if (ref.read(currentSessionProvider)?.profile.image != null) ListTile(leading: Icon(Icons.delete_outline, color: context.colors.danger), title: Text(l.removePhoto), onTap: () => Navigator.pop(ctx, 'remove')),
          ],
        ),
      ),
    );
    if (choice == null) return;
    setState(() {
      _photoBusy = true;
      _error = null;
    });
    try {
      String image = '';
      if (choice != 'remove') {
        final file = await ImagePicker().pickImage(source: choice == 'camera' ? ImageSource.camera : ImageSource.gallery, maxWidth: 256, maxHeight: 256, imageQuality: 70, requestFullMetadata: false);
        if (file == null) return;
        final bytes = await file.readAsBytes();
        image = 'data:image/jpeg;base64,${base64Encode(bytes)}';
        if (image.length > 48 * 1024) {
          // very dense photos: try harder
          final smaller = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 160, maxHeight: 160, imageQuality: 50, requestFullMetadata: false);
          if (smaller == null) return;
          image = 'data:image/jpeg;base64,${base64Encode(await smaller.readAsBytes())}';
        }
      }
      final p = await ref.read(authApiProvider).updateProfile(image: image);
      await ref.read(sessionProvider.notifier).updateProfile(p);
      Haptics.success();
      if (mounted) showToast(context, l.photoSaved, tone: NoticeTone.ok);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _photoBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final s = ref.watch(currentSessionProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l.profile)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Center(
            child: Stack(
              children: [
                AvatarImage(src: s?.profile.image, name: s?.displayName ?? '', size: 112, ring: true),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Material(
                    color: c.primaryFill,
                    shape: const CircleBorder(),
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      onTap: _photoBusy ? null : _changePhoto,
                      child: Padding(padding: const EdgeInsets.all(9), child: _photoBusy ? SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: c.onAccent)) : Icon(Icons.photo_camera, size: 18, color: c.onAccent)),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Center(child: TextButton(onPressed: _photoBusy ? null : _changePhoto, child: Text(l.changePhoto))),
          const SizedBox(height: 16),
          TextField(controller: _name, decoration: InputDecoration(labelText: l.nameLabel, prefixIcon: const Icon(Icons.person_outline)), textCapitalization: TextCapitalization.words, onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          SectionGroup(
            margin: EdgeInsets.zero,
            children: [SettingsValueTile(icon: Icons.phone_outlined, title: l.phoneLabelShort, value: formatPhone(s?.profile.phone))],
          ),
          const SizedBox(height: 12),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 12),
          PrimaryButton(label: l.save, busy: _busy, onPressed: _name.text.trim().length < 2 || _name.text.trim() == s?.profile.name ? null : _save),
        ],
      ),
    );
  }
}
