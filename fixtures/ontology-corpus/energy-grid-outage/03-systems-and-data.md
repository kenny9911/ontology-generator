# Grid Operations — Systems of Record & Data Reference

**Document ID:** REF-GRID-SYS-003
**Owner:** Enterprise Architecture / Grid Data Platform
**Version:** 2.4
**Effective Date:** 2026-01-15
**Classification:** Internal — Architecture Controlled

**Related documents:** `Grid Outage SOP` (SOP-GRID-OPS-014), `Business Rules & Compliance Policy` (POL-GRID-COMP-009).

---

## 1. Purpose

This reference defines the systems of record at NorthGrid Electric, the key data entities (对象) and attributes they own, the integrations between systems, and the events (事件) exchanged across system boundaries. Entity and system names are consistent with the SOP and the Business Rules policy.

---

## 2. Systems of Record

| System | Role | Owns (master) |
|---|---|---|
| **GIS** (Geographic Information System) | Network connectivity model. | `Substation`, `Feeder`, `ServicePoint` topology |
| **Maximo** (Enterprise Asset Management) | Asset, work, inspection, and workforce master. | `Asset`, `MaintenanceWorkOrder`, `Inspection`, `Crew` |
| **OMS** (Outage Management System) | Outage lifecycle and prediction engine. | `OutageEvent` |
| **AMI Head-End** (Advanced Metering Infrastructure) | Meter telemetry (last-gasp, power-restored). | Meter signals per `ServicePoint` |
| **CIS** (Customer Information System) | Customer accounts and notification flags. | `Customer` |
| **RegFiling Portal** | PUC submission gateway. | `RegulatoryReport` |

---

## 3. Data Entities & Attributes (对象与属性)

### 3.1 `Substation` — owner: GIS
| Attribute | Type | Key / Notes |
|---|---|---|
| `substationId` | string | **Primary key** |
| `name` | string | |
| `voltageClassKV` | integer | e.g., 12, 69, 138 |
| `region` | string | |

### 3.2 `Feeder` — owner: GIS
| Attribute | Type | Key / Notes |
|---|---|---|
| `feederId` | string | **Primary key** |
| `substationId` | string | **Foreign key** → `Substation` |
| `voltageClass` | enum {distribution, high-voltage} | drives Rules R-11, R-12 |
| `vegetationCycleMonths` | integer | clearance cycle |
| `lastClearanceDate` | date | |
| `wildfireRiskZone` | boolean | drives Rule R-12 |

### 3.3 `ServicePoint` — owner: GIS (telemetry via AMI)
| Attribute | Type | Key / Notes |
|---|---|---|
| `servicePointId` | string | **Primary key** |
| `feederId` | string | **Foreign key** → `Feeder` (exactly one, Rule R-18) |
| `customerId` | string | **Foreign key** → `Customer` (exactly one, Rule R-18) |
| `meterId` | string | AMI device identifier |
| `criticalInfrastructure` | boolean | drives Rule R-15 |

### 3.4 `Customer` — owner: CIS
| Attribute | Type | Key / Notes |
|---|---|---|
| `customerId` | string | **Primary key** |
| `accountName` | string | |
| `lifeSupportFlag` | boolean | drives Rules R-14, R-19 |
| `notificationContact` | string | phone/email |

### 3.5 `Asset` — owner: Maximo
| Attribute | Type | Key / Notes |
|---|---|---|
| `assetTag` | string | **Primary key** |
| `assetClass` | enum {transmission, distribution} | drives Rules R-01, R-03 |
| `safetyClassified` | boolean | drives Rule R-05 |
| `conditionScore` | integer (0–100) | drives Rule R-04 |
| `inspectionIntervalMonths` | integer | rated interval |
| `lastInspectionDate` | date | |
| `feederId` | string | **Foreign key** → `Feeder` (where applicable) |

### 3.6 `Inspection` — owner: Maximo
| Attribute | Type | Key / Notes |
|---|---|---|
| `inspectionId` | string | **Primary key** |
| `assetTag` | string | **Foreign key** → `Asset` |
| `dueDate` | date | |
| `completedDate` | date | nullable until done |
| `result` | enum {pass, fail} | drives Rule R-02 |

### 3.7 `MaintenanceWorkOrder` — owner: Maximo
| Attribute | Type | Key / Notes |
|---|---|---|
| `workOrderId` | string | **Primary key** |
| `assetTag` | string | **Foreign key** → `Asset` |
| `outageEventId` | string | **Foreign key** → `OutageEvent` (nullable, Rule R-17) |
| `priority` | enum {emergency, high, normal} | |
| `estimatedCost` | decimal | drives Rule R-06 |
| `status` | enum {raised, approved, in-progress, closed} | |
| `secondEngineerApproval` | boolean | drives Rule R-05 |

### 3.8 `Crew` — owner: Maximo (Workforce)
| Attribute | Type | Key / Notes |
|---|---|---|
| `crewId` | string | **Primary key** |
| `qualification` | enum {line, substation, vegetation} | |
| `availability` | enum {available, dispatched, off-shift} | |

### 3.9 `OutageEvent` — owner: OMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `outageEventId` | string | **Primary key** |
| `feederId` | string | **Foreign key** → `Feeder` |
| `detectionTimestamp` | datetime | starts reporting clock, Rule R-07 |
| `restorationTimestamp` | datetime | nullable |
| `affectedServicePointCount` | integer | drives Rules R-07, R-09 |
| `causeCode` | string | required before close, Rule R-20 |
| `state` | enum {Detected, Confirmed, RepairInProgress, Restored, Closed} | |

### 3.10 `RegulatoryReport` — owner: RegFiling Portal
| Attribute | Type | Key / Notes |
|---|---|---|
| `reportId` | string | **Primary key** |
| `outageEventId` | string | **Foreign key** → `OutageEvent` |
| `filingDeadline` | datetime | computed from `detectionTimestamp`, Rule R-07 |
| `submittedTimestamp` | datetime | nullable |
| `directorApproval` | boolean | drives Rule R-09 |
| `portalConfirmationId` | string | set on acceptance |

---

## 4. System Integrations

| # | Source → Target | Mechanism | Payload (objects) |
|---|---|---|---|
| I1 | AMI Head-End → OMS | Streaming (Kafka topic `ami.meter.events`) | meter signals per `ServicePoint` |
| I2 | GIS → OMS | Nightly topology sync + on-change webhook | `Substation`, `Feeder`, `ServicePoint` |
| I3 | OMS → Maximo | REST (work-order creation API) | emergency `MaintenanceWorkOrder` |
| I4 | Maximo → OMS | REST (work-order status callback) | `MaintenanceWorkOrder` status |
| I5 | CIS → OMS | Batch sync + lookup API | `Customer` flags (life-support, critical) |
| I6 | OMS → RegFiling Portal | HTTPS form submission | `RegulatoryReport` |
| I7 | Maximo PM scheduler → Maximo | Internal timer | `Inspection` schedule |

---

## 5. Events Exchanged Between Systems (事件)

| Event | Emitted by | Consumed by | Carries |
|---|---|---|---|
| `MeterLastGaspReceived` | AMI Head-End | OMS | `servicePointId`, timestamp |
| `OutageDetected` | OMS | OMS prediction, DOC console | `outageEventId`, `feederId` |
| `OutageConfirmed` | OMS | Maximo, OMS Compliance | `affectedServicePointCount` |
| `RegulatoryClockStarted` | OMS Compliance | RegFiling workflow | `outageEventId`, `filingDeadline` |
| `CrewDispatched` | Maximo Workforce | OMS, DOC console | `crewId`, `outageEventId` |
| `AssetDefectIdentified` | Maximo / OMS | Maximo PM | `assetTag` |
| `SupplyRestored` | OMS (via AMI confirm) | CIS, DOC console | `servicePointId` |
| `OutageClosed` | OMS | Maximo, analytics | `outageEventId`, duration |
| `InspectionCompleted` | Maximo | Maximo PM, analytics | `inspectionId`, `result` |
| `MaintenanceWorkOrderRaised` | Maximo | DOC console, planning | `workOrderId`, `priority` |
| `RegulatoryReportSubmitted` | RegFiling Portal | OMS Compliance | `reportId`, `portalConfirmationId` |
| `RegulatoryDeadlineBreached` | OMS Compliance | Director of Compliance | `outageEventId` |

---

## 6. Data Governance Notes

- The **affected-customer count** in any `RegulatoryReport` is derived strictly by traversing `OutageEvent` → `Feeder` → `ServicePoint` → `Customer`; OMS may not invent counts outside this path.
- `ServicePoint` cardinality (exactly one `Feeder`, exactly one `Customer`) is enforced at the GIS sync boundary per Rule R-18.
- All timestamps are stored in UTC; the regulatory clock (Rule R-07) is evaluated in UTC and rendered in the utility's operating timezone for display.
