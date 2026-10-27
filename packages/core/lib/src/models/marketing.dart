// notification-service marketing preferences (`campaigns/routes.ts`): whether the person gets
// campaign messages by push and by SMS. Trip and safety messages don't depend on these.

import 'package:meta/meta.dart';
import 'json.dart';

/// GET / PUT /api/notifications/me/marketing
@immutable
class MarketingPrefs {
  const MarketingPrefs({required this.push, required this.sms});
  final bool push;
  final bool sms;
  factory MarketingPrefs.fromJson(Json j) => MarketingPrefs(push: readBool(j, 'push', true), sms: readBool(j, 'sms', true));
  MarketingPrefs copyWith({bool? push, bool? sms}) => MarketingPrefs(push: push ?? this.push, sms: sms ?? this.sms);
}
