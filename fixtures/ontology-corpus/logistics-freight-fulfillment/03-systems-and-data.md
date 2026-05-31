# Systems & Data Reference — Freight & Fulfillment / 系统与数据参考 — 货运与履约

**Document ID:** ARCH-DATA-007
**Version:** 2.6
**Owner:** Enterprise Architecture — Supply Chain Systems
**Effective Date:** 2026-01-15
**Classification:** Internal — Engineering & Operations
**Related documents:** `01-process-sop.md` (SOP-OPS-014), `02-business-rules-policy.md` (POL-OPS-2026)

---

## 1. Purpose

This reference catalogs the systems of record, their key data entities and attributes (with types and keys), the integrations between them, and the events exchanged. Entity and system names match `01-process-sop.md` and `02-business-rules-policy.md` exactly so that extraction can link rules and process steps to concrete data.

## 2. Systems of Record

| System | Code | Vendor / Type | Owns (primary entities) |
|---|---|---|---|
| Transportation Management System | **TMS** | Oracle OTM (cloud) | `Shipment`, `Stop`, `Carrier`, `Lane`, `SLA`, `TrackingEvent`, `Exception`, `ServiceFailureClaim` |
| Warehouse Management System | **WMS** | Manhattan Active WM | `Consignment`, `ProofOfDelivery`, pick/pack tasks |
| EDI Integration Gateway | **EDI Gateway** | Cleo Integration Cloud | Inbound/outbound EDI transactions; no master data |
| Customs Broker Portal | **CBP-Link** | Descartes (broker interface) | `CustomsDeclaration` |
| Order intake | **TMS (Order module)** | Oracle OTM | `Order` |

---

## 3. Key Entities & Attributes

### 3.1 `Order` (订单) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `orderId` | string (ORD-#########) | **Primary key** |
| `clientId` | string | FK → client master |
| `status` | enum {Received, Accepted, Rejected} | |
| `requestedShipDate` | date | |
| `shipToParty` | string | |
| `sourceTransaction` | enum {EDI940, API, Manual} | provenance of intake |

### 3.2 `Consignment` (货件/委托) — WMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `consignmentId` | string (CON-#########) | **Primary key** |
| `orderId` | string | **FK** → `Order.orderId` |
| `shipmentId` | string | **FK** → `Shipment.shipmentId` (nullable until planned) |
| `isInternational` | boolean | drives customs sub-process |
| `declaredValueUSD` | decimal | used by Rule R8, R19 |
| `weightKg` | decimal | |
| `status` | enum {Created, Staged, Departed, Delivered} | |
| `hsCodes` | array<string> | Harmonized System codes |

### 3.3 `Shipment` (运单) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `shipmentId` | string (SHP-#########) | **Primary key** |
| `laneId` | string | **FK** → `Lane.laneId` |
| `carrierId` | string | **FK** → `Carrier.carrierId` (set at tender) |
| `slaId` | string | **FK** → `SLA.slaId` |
| `status` | enum {Planned, Tendered, In Transit, Delivered, Cancelled} | |
| `committedDeliveryWindow` | timestamp range | derived from SLA |
| `linehaulChargeUSD` | decimal | basis for credit (Rule R4) |
| `proNumber` | string | Carrier confirmation number |

### 3.4 `Stop` (站点) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `stopId` | string | **Primary key** |
| `shipmentId` | string | **FK** → `Shipment.shipmentId` |
| `sequence` | integer | pickup=1, delivery=last |
| `type` | enum {Pickup, Delivery} | |
| `appointmentWindow` | timestamp range | dwell measured against this (Rule R17) |
| `actualArrival` | timestamp | |

### 3.5 `Carrier` (承运商) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `carrierId` | string (SCAC) | **Primary key** (Standard Carrier Alpha Code) |
| `name` | string | |
| `onTimeRate30d` | decimal (0–1) | governs performance hold (Rule R16) |
| `cargoInsuranceUSD` | decimal | governs high-value tender (Rule R19) |
| `status` | enum {Active, PerformanceHold, Suspended} | |

### 3.6 `Lane` (运线) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `laneId` | string (LN-####) | **Primary key** |
| `originRegion` | string | |
| `destinationRegion` | string | |
| `commitmentTier` | enum {Guaranteed, Standard} | drives credit eligibility (Rule R3) |
| `approvedCarrierIds` | array<string> | FK → `Carrier.carrierId` (Rule R2) |

### 3.7 `SLA` (服务等级协议) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `slaId` | string | **Primary key** |
| `laneId` | string | **FK** → `Lane.laneId` |
| `transitHours` | integer | committed transit time |
| `creditScheduleRef` | string | → CSA §7.4 |

### 3.8 `CustomsDeclaration` (报关单) — CBP-Link
| Attribute | Type | Key / Notes |
|---|---|---|
| `declarationId` | string (CD-#########) | **Primary key** |
| `consignmentId` | string | **FK** → `Consignment.consignmentId` |
| `entryType` | enum {Formal, Informal, InBond} | Rule R8, E1 |
| `status` | enum {Draft, Filed, Accepted, Held, Rejected} | |
| `dutiesAssignedUSD` | decimal | set on acceptance |
| `exportLicenseRef` | string (nullable) | required for controlled goods (Rule R9) |
| `brokerReference` | string | |

### 3.9 `TrackingEvent` (轨迹事件) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `eventId` | string | **Primary key** |
| `shipmentId` | string | **FK** → `Shipment.shipmentId` |
| `ediStatusCode` | string (e.g., AF, X3, AG, D1) | raw EDI 214 code |
| `canonicalStatus` | enum {Departed, InTransit, ArrivedDelivery, Delivered, Exception} | mapped value |
| `eventTimestamp` | timestamp | |

### 3.10 `ProofOfDelivery` (签收凭证) — WMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `podId` | string (POD-#########) | **Primary key** |
| `shipmentId` | string | **FK** → `Shipment.shipmentId` |
| `deliveryTimestamp` | timestamp | required (Rule R12) |
| `signatureName` | string (nullable) | |
| `photoUri` | string (nullable) | required if no signature (Rule R12) |

### 3.11 `Exception` (异常) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `exceptionId` | string (EXC-#########) | **Primary key** |
| `shipmentId` | string | **FK** → `Shipment.shipmentId` (nullable) |
| `consignmentId` | string | **FK** → `Consignment.consignmentId` (nullable) |
| `type` | enum {SLA_BREACH, CUSTOMS_HOLD, DAMAGE, LOST} | |
| `liability` | enum {CARRIER, CUSTOMER, INTERNAL, FORCE_MAJEURE} | set at classification |
| `creditEligible` | boolean | drives claim (Rule R14) |
| `status` | enum {Open, Classified, Resolved, Closed} | |

### 3.12 `ServiceFailureClaim` (服务失败索赔) — TMS
| Attribute | Type | Key / Notes |
|---|---|---|
| `claimId` | string (CLM-#########) | **Primary key** |
| `exceptionId` | string | **FK** → `Exception.exceptionId` |
| `carrierId` | string | **FK** → `Carrier.carrierId` |
| `creditAmountUSD` | decimal | per credit schedule (Rule R4) |
| `citedClause` | string | e.g., "CSA §7.3" |
| `status` | enum {Draft, Submitted, Settled, Credited, Contested, WrittenOff} | |

---

## 4. Integrations

| Integration | Direction | Transport | Payload | Triggered by |
|---|---|---|---|---|
| Client → EDI Gateway | inbound | EDI 940 | Warehouse Shipping Order | client transmission |
| EDI Gateway → TMS | inbound | normalized JSON | new `Order` | EDI 940 receipt |
| TMS → EDI Gateway → Carrier | outbound | EDI 204 | Load Tender | `ShipmentPlanned` |
| Carrier → EDI Gateway → TMS | inbound | EDI 990 | Tender response (accept/decline) | Carrier action |
| Carrier → EDI Gateway → TMS | inbound | EDI 214 | Shipment status | Carrier scan event |
| TMS ↔ WMS | bidirectional | REST API | Consignment status, dims/weights, POD | departure & POD events |
| TMS → CBP-Link | outbound | REST API | `CustomsDeclaration` filing | `ShipmentTendered` (international) |
| CBP-Link → TMS | inbound | webhook | customs disposition + duties | broker decision |
| Carrier → EDI Gateway → TMS | inbound | EDI 210 | Freight invoice | `ShipmentDelivered` |

## 5. Events Exchanged Between Systems

| Event | Emitting system | Consuming system(s) | Carries |
|---|---|---|---|
| **`OrderReceived`** | EDI Gateway | TMS | orderId, client, ship-to |
| **`OrderAccepted`** | TMS | WMS | orderId, consignmentIds |
| **`ShipmentPlanned`** | TMS | EDI Gateway | shipmentId, laneId, slaId |
| **`ShipmentTendered`** | TMS | WMS, CBP-Link | shipmentId, carrierId, proNumber |
| **`TenderRejected`** | TMS | (planner) | shipmentId, carrierId, reason |
| **`CustomsCleared`** | CBP-Link | TMS, WMS | declarationId, dutiesAssignedUSD |
| **`CustomsHeld`** | CBP-Link | TMS | declarationId, holdReason |
| **`ConsignmentStaged`** | WMS | TMS | consignmentId, dims/weights |
| **`ShipmentDeparted`** | TMS | EDI Gateway, client | shipmentId, departure timestamp |
| **`TrackingEventReceived`** | EDI Gateway | TMS | shipmentId, ediStatusCode |
| **`SLABreached`** | TMS | TMS (Exception module) | shipmentId, slaId, delta |
| **`PODCaptured`** | WMS | TMS | podId, shipmentId, timestamp |
| **`ShipmentDelivered`** | TMS | EDI Gateway, client, finance | shipmentId, podId |
| **`ExceptionOpened`** | TMS | (coordinator) | exceptionId, type |
| **`ClaimSubmitted`** | TMS | EDI Gateway → Carrier | claimId, creditAmountUSD, citedClause |
| **`ExceptionResolved`** | TMS | finance | exceptionId, claimId, disposition |

## 6. Cross-Document Consistency Notes

- Every Object in §3 appears with the same name in `01-process-sop.md` (process steps) and `02-business-rules-policy.md` (rules R1–R20).
- Status enums in §3 match the lifecycle table in `02-business-rules-policy.md` §5.
- Events in §5 match the `Events` lines of the SOP steps and the trigger/terminal events of each Process.
