// fleet-service, the driver's side (workflows 02 and 04): the application and its document
// checklist, vehicles, document uploads, and the driving session (being online).

import 'package:meta/meta.dart';
import 'json.dart';

/// Driver application status (fleet-service driver_profile.status).
enum DriverStatus { applied, pendingReview, changesRequested, active, suspended, unknown }

String driverStatusToApi(DriverStatus s) => snakeOf(s.name).toUpperCase();

enum VehicleStatus { draft, pendingReview, verified, rejected, suspended, retired, unknown }

String vehicleStatusToApi(VehicleStatus s) => snakeOf(s.name).toUpperCase();

enum DocumentStatus { pending, approved, rejected, expired, unknown }

/// Document kinds per subject (fleet-service rules.ts DOCUMENT_KINDS).
enum DocumentKind { license, nationalId, photo, registration, insurance, inspection, businessLicense, tinCertificate, unknown }

String documentKindToApi(DocumentKind k) => snakeOf(k.name).toUpperCase();

DocumentKind documentKindFromApi(String? v) => enumFrom(DocumentKind.values, v, DocumentKind.unknown, apiName: documentKindToApi);

@immutable
class DocumentView {
  const DocumentView({required this.id, required this.kind, required this.status, this.expiresAt, required this.expiringSoon, this.rejectReason, required this.createdAt});
  final String id;
  final DocumentKind kind;
  final DocumentStatus status;
  /// YYYY-MM-DD
  final String? expiresAt;
  final bool expiringSoon;
  final String? rejectReason;
  final DateTime createdAt;
  factory DocumentView.fromJson(Json j) => DocumentView(
        id: str(j, 'id'), kind: documentKindFromApi(strOrNull(j, 'kind')),
        status: enumFrom(DocumentStatus.values, strOrNull(j, 'status'), DocumentStatus.unknown, apiName: (s) => s.name.toUpperCase()),
        expiresAt: strOrNull(j, 'expiresAt'), expiringSoon: readBool(j, 'expiringSoon'), rejectReason: strOrNull(j, 'rejectReason'), createdAt: readDate(j, 'createdAt'),
      );
}

/// One line of the checklist: a kind the subject needs and what's uploaded for it.
@immutable
class ChecklistItem {
  const ChecklistItem({required this.kind, required this.required, required this.expires, this.document});
  final DocumentKind kind;
  final bool required;
  /// needs an expiry date when uploaded (LICENSE, INSURANCE, INSPECTION)
  final bool expires;
  final DocumentView? document;
  factory ChecklistItem.fromJson(Json j) => ChecklistItem(
        kind: documentKindFromApi(strOrNull(j, 'kind')), required: readBool(j, 'required', true), expires: readBool(j, 'expires'),
        document: j['document'] is Map ? DocumentView.fromJson(asJson(j['document'])) : null,
      );
  bool get needsUpload => document == null || document!.status == DocumentStatus.rejected || document!.status == DocumentStatus.expired;
}

@immutable
class Checklist {
  const Checklist({required this.items, required this.missingForSubmit, required this.missingForApproval});
  final List<ChecklistItem> items;
  final List<DocumentKind> missingForSubmit;
  final List<DocumentKind> missingForApproval;
  factory Checklist.fromJson(Json j) => Checklist(
        items: asJsonList(j['documents']).map(ChecklistItem.fromJson).toList(growable: false),
        missingForSubmit: strList(j, 'missingForSubmit').map(documentKindFromApi).toList(growable: false),
        missingForApproval: strList(j, 'missingForApproval').map(documentKindFromApi).toList(growable: false),
      );
  static const empty = Checklist(items: [], missingForSubmit: [], missingForApproval: []);
  bool get readyToSubmit => missingForSubmit.isEmpty;
}

@immutable
class DriverProfile {
  const DriverProfile({required this.userId, required this.status, this.statusReason, this.reviewNote, required this.fullName, required this.licenseNumber, required this.cityId, this.submittedAt, this.activatedAt, required this.checklist});
  final String userId;
  final DriverStatus status;
  final String? statusReason;
  final String? reviewNote;
  final String fullName;
  final String licenseNumber;
  final String cityId;
  final DateTime? submittedAt;
  final DateTime? activatedAt;
  final Checklist checklist;
  factory DriverProfile.fromJson(Json j) => DriverProfile(
        userId: str(j, 'userId'), status: enumFrom(DriverStatus.values, strOrNull(j, 'status'), DriverStatus.unknown, apiName: driverStatusToApi),
        statusReason: strOrNull(j, 'statusReason'), reviewNote: strOrNull(j, 'reviewNote'), fullName: str(j, 'fullName'), licenseNumber: str(j, 'licenseNumber'),
        cityId: str(j, 'cityId'), submittedAt: dateOrNull(j, 'submittedAt'), activatedAt: dateOrNull(j, 'activatedAt'), checklist: Checklist.fromJson(j),
      );
  bool get isActive => status == DriverStatus.active;
}

@immutable
class Vehicle {
  const Vehicle({required this.id, required this.plateNumber, required this.ownerType, this.ownerOrgId, required this.vehicleType, required this.make, required this.model, required this.year, required this.color, required this.seats, required this.status, this.statusReason, this.reviewNote, required this.cityId, this.authorizationValidUntil, this.canDrive, this.denial, this.denialMessage});
  final String id;
  final String plateNumber;
  /// INDIVIDUAL | ORGANIZATION
  final String ownerType;
  final String? ownerOrgId;
  final String vehicleType;
  final String make;
  final String model;
  final int year;
  final String color;
  final int seats;
  final VehicleStatus status;
  final String? statusReason;
  final String? reviewNote;
  final String cityId;
  /// fleet cars: how long the driver may use it
  final DateTime? authorizationValidUntil;
  /// GET /drivers/me/vehicles adds whether the driver may go online with it now
  final bool? canDrive;
  final String? denial;
  final String? denialMessage;
  factory Vehicle.fromJson(Json j) => Vehicle(
        id: str(j, 'id'), plateNumber: str(j, 'plateNumber'), ownerType: str(j, 'ownerType', 'INDIVIDUAL'), ownerOrgId: strOrNull(j, 'ownerOrgId'),
        vehicleType: str(j, 'vehicleType'), make: str(j, 'make'), model: str(j, 'model'), year: readInt(j, 'year'), color: str(j, 'color'), seats: readInt(j, 'seats'),
        status: enumFrom(VehicleStatus.values, strOrNull(j, 'status'), VehicleStatus.unknown, apiName: vehicleStatusToApi),
        statusReason: strOrNull(j, 'statusReason'), reviewNote: strOrNull(j, 'reviewNote'), cityId: str(j, 'cityId'),
        authorizationValidUntil: dateOrNull(asJson(j['authorization']), 'validUntil'),
        canDrive: j['canDrive'] is bool ? j['canDrive'] as bool : null, denial: strOrNull(j, 'denial'), denialMessage: strOrNull(j, 'message'),
      );
  String get label => [color, make, model].where((s) => s.isNotEmpty).join(' ');
  bool get isFleet => ownerType == 'ORGANIZATION';
}

@immutable
class DrivingSession {
  const DrivingSession({required this.id, required this.vehicleId, required this.startedAt, this.endedAt, this.endReason});
  final String id;
  final String vehicleId;
  final DateTime startedAt;
  final DateTime? endedAt;
  /// DRIVER | CONNECTION_LOST | BALANCE_BLOCKED | SUSPENDED | VEHICLE_UNAVAILABLE | FLEET_SUSPENDED
  final String? endReason;
  factory DrivingSession.fromJson(Json j) => DrivingSession(id: str(j, 'id'), vehicleId: str(j, 'vehicleId'), startedAt: readDate(j, 'startedAt'), endedAt: dateOrNull(j, 'endedAt'), endReason: strOrNull(j, 'endReason'));
  bool get isOpen => endedAt == null;
}

/// GET /api/fleet/drivers/me
@immutable
class DriverHome {
  const DriverHome({this.driver, required this.vehicles, required this.fleetVehicles, this.session});
  final DriverProfile? driver;
  final List<Vehicle> vehicles;
  final List<Vehicle> fleetVehicles;
  final DrivingSession? session;
  factory DriverHome.fromJson(Json j) => DriverHome(
        driver: j['driver'] is Map ? DriverProfile.fromJson(asJson(j['driver'])) : null,
        vehicles: asJsonList(j['vehicles']).map(Vehicle.fromJson).toList(growable: false),
        fleetVehicles: asJsonList(j['fleetVehicles']).map(Vehicle.fromJson).toList(growable: false),
        session: j['session'] is Map ? DrivingSession.fromJson(asJson(j['session'])) : null,
      );
  List<Vehicle> get allVehicles => [...vehicles, ...fleetVehicles];
  static const empty = DriverHome(vehicles: [], fleetVehicles: []);
}

/// POST /api/fleet/documents/upload-url
@immutable
class UploadTicket {
  const UploadTicket({required this.uploadUrl, required this.headers, required this.ticket, required this.expiresIn});
  final String uploadUrl;
  final Map<String, String> headers;
  final String ticket;
  final int expiresIn;
  factory UploadTicket.fromJson(Json j) => UploadTicket(
        uploadUrl: str(j, 'uploadUrl'), headers: {for (final e in asJson(j['headers']).entries) e.key: e.value.toString()}, ticket: str(j, 'ticket'), expiresIn: readInt(j, 'expiresIn', 300),
      );
}
