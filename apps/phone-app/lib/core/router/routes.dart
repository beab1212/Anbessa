// Every path in the app, in one place. Deep links (anbessa://, https://app.anbessa.et) use the
// same paths; `/trip/:id` and `/pay/:tripId` are resolved to the current mode by the router.

abstract final class Routes {
  static const splash = '/splash';
  static const intro = '/intro';
  static const updateRequired = '/update-required';
  static const welcome = '/welcome';
  static const signIn = '/sign-in';
  static const verify = '/sign-in/verify';
  static const mode = '/mode';

  static const rider = '/rider';
  static const riderHome = '/rider/home';
  static const riderPickup = '/rider/book/pickup';
  static const riderDropoff = '/rider/book/dropoff';
  static const riderRoute = '/rider/book/route';
  static const riderQuote = '/rider/book/quote';
  static String riderTrip(String id) => '/rider/trip/$id';
  static String riderPay(String id) => '/rider/trip/$id/pay';
  static String riderRate(String id) => '/rider/trip/$id/rate';
  static const riderActivity = '/rider/activity';
  static String riderReceipt(String id) => '/rider/activity/$id';
  static const riderAccount = '/rider/account';

  static const driver = '/driver';
  static const driverOnboarding = '/driver/onboarding';
  static const driverApply = '/driver/onboarding/apply';
  static String driverDocuments(String subjectType, String subjectId) => '/driver/onboarding/documents/$subjectType/$subjectId';
  static const driverVehicleNew = '/driver/onboarding/vehicle/new';
  static String driverVehicle(String id) => '/driver/onboarding/vehicle/$id';
  static const driverHome = '/driver/home';
  static String driverTrip(String id) => '/driver/trip/$id';
  static const driverEarnings = '/driver/earnings';
  static const driverTopUp = '/driver/earnings/top-up';
  static const driverPayoutMethod = '/driver/earnings/payout-method';
  static const driverStatement = '/driver/earnings/statement';
  static const driverTopUps = '/driver/earnings/top-ups';
  static const driverActivity = '/driver/activity';
  static String driverReceipt(String id) => '/driver/activity/$id';
  static const driverAccount = '/driver/account';
  static const driverVehicles = '/driver/vehicles';

  static const profile = '/account/profile';
  static const language = '/account/language';
  static const sessions = '/account/sessions';
  static const paymentPrefs = '/account/payments';
  static const savedPlaces = '/account/places';
  static const appearance = '/account/appearance';
  static const notifications = '/account/notifications';
  static const safety = '/account/safety';
  static const organizations = '/account/organizations';
  static const navigationPrefs = '/account/navigation';
  static const deleteAccount = '/account/delete';

  static const scheduled = '/scheduled';
  static const scheduledNew = '/scheduled/new';
  static const sos = '/sos';
  static const support = '/support';
  static const supportNew = '/support/new';
  static const promos = '/promos';
  static const promosRedeem = '/promos/redeem';
}
