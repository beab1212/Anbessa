// Local notifications: a trip offer while the app is in the background (high importance, with
// sound). Initialised once at boot on Android/iOS; a no-op elsewhere.

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';

abstract class LocalNotifications {
  Future<void> init();
  Future<bool> requestPermission();
  Future<void> offer(TripOffer o);
  Future<void> cancelOffer();
  Future<void> show(int id, String title, String body, {String? payload});
  /// Payload of the notification the app was opened from, if any.
  Future<String?> launchPayload();
}

class NoLocalNotifications implements LocalNotifications {
  @override
  Future<void> init() async {}
  @override
  Future<bool> requestPermission() async => true;
  @override
  Future<void> offer(TripOffer o) async {}
  @override
  Future<void> cancelOffer() async {}
  @override
  Future<void> show(int id, String title, String body, {String? payload}) async {}
  @override
  Future<String?> launchPayload() async => null;
}

class PlatformLocalNotifications implements LocalNotifications {
  final _plugin = FlutterLocalNotificationsPlugin();
  static const _offerId = 1;
  static const offersChannel = AndroidNotificationChannel('offers', 'Trip offers', description: 'A rider is waiting for an answer', importance: Importance.max, playSound: true);
  static const generalChannel = AndroidNotificationChannel('general', 'Anbessa', description: 'Payments, balance and trip updates', importance: Importance.defaultImportance);
  void Function(String payload)? onTap;

  @override
  Future<void> init() async {
    await _plugin.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher'), iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false)),
      onDidReceiveNotificationResponse: (r) {
        if (r.payload != null) onTap?.call(r.payload!);
      },
    );
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(offersChannel);
    await android?.createNotificationChannel(generalChannel);
  }

  @override
  Future<bool> requestPermission() async {
    if (defaultTargetPlatform == TargetPlatform.android) {
      return await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission() ?? true;
    }
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      return await _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, sound: true, badge: true) ?? true;
    }
    return true;
  }

  @override
  Future<void> offer(TripOffer o) => _plugin.show(
        id: _offerId,
        title: 'New trip',
        body: '${o.pickup.address ?? 'Pickup'} → ${o.dropoff.address ?? 'Drop-off'} · ${birr(o.fareEstimateMinor)}',
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(offersChannel.id, offersChannel.name, channelDescription: offersChannel.description, importance: Importance.max, priority: Priority.max, fullScreenIntent: true, category: AndroidNotificationCategory.call, timeoutAfter: 16000),
          iOS: const DarwinNotificationDetails(interruptionLevel: InterruptionLevel.timeSensitive),
        ),
        payload: 'offer:${o.tripId}',
      );

  @override
  Future<void> cancelOffer() => _plugin.cancel(id: _offerId);

  @override
  Future<void> show(int id, String title, String body, {String? payload}) => _plugin.show(
        id: id,
        title: title,
        body: body,
        notificationDetails: NotificationDetails(android: AndroidNotificationDetails(generalChannel.id, generalChannel.name, channelDescription: generalChannel.description)),
        payload: payload,
      );

  @override
  Future<String?> launchPayload() async => (await _plugin.getNotificationAppLaunchDetails())?.notificationResponse?.payload;
}

final localNotificationsProvider = Provider<LocalNotifications>((ref) =>
    !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS) ? PlatformLocalNotifications() : NoLocalNotifications());
