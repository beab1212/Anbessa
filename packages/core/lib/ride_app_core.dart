/// Contracts and pure logic for the Anbessa phone app: models mirrored from `libs/shared-types`
/// and the services' views, the typed API client, realtime event parsing, money/time/phone
/// helpers, and the design system. No Riverpod, no platform plugins (see the app for those).
library;

export 'src/api/api_client.dart';
export 'src/api/app_error.dart';
export 'src/api/auth_api.dart';
export 'src/api/service_apis.dart';
export 'src/domain/domain.dart';
export 'src/models/balance.dart';
export 'src/models/client_config.dart';
export 'src/models/fleet.dart';
export 'src/models/json.dart';
export 'src/models/payment.dart';
export 'src/models/place.dart';
export 'src/models/quote.dart';
export 'src/models/session.dart';
export 'src/models/trip.dart';
export 'src/models/trip_offer.dart';
export 'src/realtime/realtime_event.dart';
export 'src/ui/theme/anbessa_theme.dart';
export 'src/ui/widgets/widgets.dart';
