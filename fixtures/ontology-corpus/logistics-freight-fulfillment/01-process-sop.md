# Warehouse & Freight Operations SOP — Order to Delivery / 仓储与货运操作标准作业程序

**Document ID:** SOP-OPS-014
**Version:** 4.2
**Owner:** VP, Transportation & Warehouse Operations (3PL Fulfillment Division)
**Effective Date:** 2026-01-15
**Supersedes:** SOP-OPS-014 v4.1
**Classification:** Internal — Operations
**Related documents:** `Carrier Service Agreement.pdf` (CSA), `Customs & Trade Compliance Guide.pdf` (CTCG), `02-business-rules-policy.md` (Freight Operations Policy, POL-OPS-2026), `03-systems-and-data.md` (Systems & Data Reference)

---

## 1. Purpose & Scope

This Standard Operating Procedure (SOP) defines the end-to-end **Order to Delivery** (下单到送达) process by which the Fulfillment Division receives a client order, plans freight, tenders it to a Carrier, executes warehouse outbound, clears international **Consignments** through customs, tracks the **Shipment** in transit, and closes it on captured **Proof of Delivery**. It also defines the **Exception to Resolution** (异常到结案) process triggered when a Shipment breaches its committed **SLA** or is held in customs.

Scope covers all domestic and international shipments executed out of the company's North American distribution centers (DCs). It does not cover returns/reverse logistics (see SOP-OPS-021) or inventory replenishment (see SOP-WHS-008).

The authoritative systems referenced throughout are the **Transportation Management System (TMS)**, the **Warehouse Management System (WMS)**, the **EDI Integration Gateway (EDI Gateway)**, and the **Customs Broker Portal (CBP-Link)**. Field-level definitions are in `03-systems-and-data.md`.

## 2. Roles & Actors

| Actor | Responsibility |
|---|---|
| **Order Management Specialist (OMS)** | Validates and accepts inbound client orders. |
| **Transportation Planner** | Builds Shipments, selects Lane and Carrier, tenders freight. |
| **Warehouse Operator** | Picks, packs, and stages outbound Consignments. |
| **Dock Supervisor** | Confirms loading and authorizes departure. |
| **Customs Compliance Analyst** | Prepares and submits CustomsDeclarations for international Consignments. |
| **Exception Coordinator** | Owns SLA breaches, customs holds, and service-failure claims. |
| **TMS** (system) | System of record for Shipment, Lane, Carrier, SLA, Tracking. |
| **WMS** (system) | System of record for Consignment picking, packing, ProofOfDelivery capture. |
| **EDI Gateway** (system) | Exchanges tender, status (214), and freight-invoice (210/990) messages with Carriers. |
| **CBP-Link** (system) | Interface to the customs broker for CustomsDeclaration filing and disposition. |

## 3. Business Objects Touched

This process reads and writes the following Objects (对象): `Order`, `Shipment`, `Consignment`, `Stop`, `Carrier`, `Lane`, `SLA`, `CustomsDeclaration`, `TrackingEvent`, `ProofOfDelivery`, `Exception`, `ServiceFailureClaim`. Each is defined in `03-systems-and-data.md`.

---

## 4. Procedure — Order to Delivery (下单到送达)

### Step 4.1 — Receive and validate the Order
- **Actor / system:** Order Management Specialist, working in TMS.
- **Objects touched:** `Order` (created/validated), `Consignment` (created).
- **Action — `ValidateOrder`:** Consumes the inbound `Order` (received from the client via EDI 940 Warehouse Shipping Order, normalized by the EDI Gateway). Produces a validated `Order` with status `Accepted` and one or more `Consignment` records, each representing the goods destined for a single ship-to party.
- **Events:** Triggered by **`OrderReceived`** (emitted by the EDI Gateway when an inbound 940 lands). On success, emits **`OrderAccepted`**. If validation fails (missing ship-to, unservicedable destination), emits **`OrderRejected`** and the step terminates.

### Step 4.2 — Plan the Shipment and select Lane
- **Actor / system:** Transportation Planner, working in TMS.
- **Objects touched:** `Shipment` (created), `Consignment` (assigned), `Lane` (referenced), `Stop` (created), `SLA` (resolved).
- **Action — `PlanShipment`:** Consumes one or more accepted `Consignment` records and groups them into a `Shipment` along an eligible `Lane`. The system resolves the applicable `SLA` from the Lane (guaranteed vs. standard) and computes the committed delivery window. Produces a `Shipment` in status `Planned`, ordered `Stop` records (pickup → delivery), and an attached `SLA`.
- **Events:** Triggered by **`OrderAccepted`**. Emits **`ShipmentPlanned`**.

### Step 4.3 — Tender to Carrier
- **Actor / system:** Transportation Planner initiates; TMS and EDI Gateway execute.
- **Objects touched:** `Shipment` (updated), `Carrier` (selected).
- **Action — `TenderShipment`:** Consumes a `Planned` `Shipment` and selects a `Carrier` qualified for the `Lane`. The EDI Gateway transmits an EDI 204 (Motor Carrier Load Tender) to the Carrier and awaits an EDI 990 (Response to a Load Tender). On Carrier acceptance, produces a `Shipment` in status `Tendered` with the booked `Carrier` and a Carrier confirmation (PRO/booking) number.
- **Events:** Triggered by **`ShipmentPlanned`**. On EDI 990 acceptance, emits **`ShipmentTendered`**. If the Carrier declines (990 decline) or the tender times out, emits **`TenderRejected`**, and the Planner re-tenders to the next-ranked Carrier on the Lane.

### Step 4.4 — Prepare customs (international Consignments only)
- **Actor / system:** Customs Compliance Analyst, working in CBP-Link.
- **Objects touched:** `Consignment` (updated), `CustomsDeclaration` (created).
- **Action — `FileCustomsDeclaration`:** For any international `Consignment`, consumes the Consignment commercial data (HS codes, declared value, country of origin) and produces a `CustomsDeclaration` filed to the broker via CBP-Link. The broker returns a disposition. Duties and taxes are assigned on acceptance.
- **Events:** Triggered by **`ShipmentTendered`** when the Shipment contains an international Consignment. On broker acceptance, emits **`CustomsCleared`**. On a hold or document request, emits **`CustomsHeld`**, which opens the Exception to Resolution process (§5).

### Step 4.5 — Pick, pack, and stage
- **Actor / system:** Warehouse Operator, working in WMS.
- **Objects touched:** `Consignment` (updated), `ProofOfDelivery` (initialized — packing manifest).
- **Action — `PickAndPack`:** Consumes the `Consignment` line items and a WMS pick task; produces packed cartons/pallets, a packing manifest, and updates the Consignment status to `Staged`. Weights and dimensions are written back to the `Shipment` in TMS.
- **Events:** Triggered by **`ShipmentTendered`** (and, for international, **`CustomsCleared`**). Emits **`ConsignmentStaged`**.

### Step 4.6 — Load and depart
- **Actor / system:** Dock Supervisor authorizes; Warehouse Operator loads; WMS and TMS record.
- **Objects touched:** `Shipment` (updated), `Stop` (pickup completed), `TrackingEvent` (created).
- **Action — `ConfirmDeparture`:** Consumes a `Staged` Consignment and a Carrier check-in; produces a `Shipment` in status `In Transit`, a completed pickup `Stop`, and the first `TrackingEvent`. The EDI Gateway emits an EDI 214 with status code `AF` (Carrier Departed Pickup Location) upstream to the client.
- **Events:** Triggered by **`ConsignmentStaged`**. Emits **`ShipmentDeparted`**.

### Step 4.7 — Track in transit
- **Actor / system:** EDI Gateway (automated); Exception Coordinator monitors.
- **Objects touched:** `TrackingEvent` (appended), `Shipment` (status updated), `SLA` (evaluated).
- **Action — `IngestTrackingEvent`:** Consumes inbound EDI 214 status messages from the Carrier and appends `TrackingEvent` records to the Shipment, mapping cryptic status codes (e.g., `X3`, `AG`, `D1`) to canonical lifecycle states. On each event the system re-evaluates the `SLA` against the committed delivery window.
- **Events:** Triggered by **`TrackingEventReceived`** (per inbound 214). If projected or actual delivery exceeds the committed window, emits **`SLABreached`**, opening the Exception to Resolution process (§5).

### Step 4.8 — Deliver and capture Proof of Delivery
- **Actor / system:** Carrier delivers; WMS/driver app records; TMS closes.
- **Objects touched:** `Stop` (delivery completed), `ProofOfDelivery` (captured), `Shipment` (closed).
- **Action — `CaptureProofOfDelivery`:** Consumes the delivery `Stop` and a captured `ProofOfDelivery` artifact (signature, timestamp, optional photo). Produces a `Shipment` in status `Delivered`. A Shipment may not be set to `Delivered` without a captured POD (see POL-OPS-2026 Rule 11).
- **Events:** Triggered by an inbound EDI 214 status `D1` (Completed Unloading) and the POD capture, surfaced as **`PODCaptured`**. Emits **`ShipmentDelivered`**, which closes the Order to Delivery process and triggers freight-invoice reconciliation (EDI 210).

---

## 5. Procedure — Exception to Resolution (异常到结案)

### Step 5.1 — Open the Exception
- **Actor / system:** TMS (automated) creates; Exception Coordinator owns.
- **Objects touched:** `Exception` (created), `Shipment` / `Consignment` (linked).
- **Action — `OpenException`:** Consumes the triggering event and the affected `Shipment` or `Consignment`; produces an `Exception` record classified by type (`SLA_BREACH`, `CUSTOMS_HOLD`, `DAMAGE`, `LOST`) with a severity and an assigned owner.
- **Events:** Triggered by **`SLABreached`** (Step 4.7) or **`CustomsHeld`** (Step 4.4). Emits **`ExceptionOpened`**.

### Step 5.2 — Classify against SLA and determine liability
- **Actor / system:** Exception Coordinator, working in TMS, referencing the CSA.
- **Objects touched:** `Exception` (updated), `SLA` (referenced), `Carrier` (referenced), `Lane` (referenced).
- **Action — `ClassifyException`:** Consumes the `Exception`, the attached `SLA`, and the `Lane` commitment tier; determines whether the breach is Carrier-attributable on a guaranteed Lane and therefore eligible for a service-failure credit. Produces an `Exception` with `liability` set (`CARRIER`, `CUSTOMER`, `INTERNAL`, `FORCE_MAJEURE`) and a `creditEligible` flag.
- **Events:** Triggered by **`ExceptionOpened`**. Emits **`ExceptionClassified`**.

### Step 5.3 — Draft and submit the service-failure claim
- **Actor / system:** Exception Coordinator initiates; TMS and EDI Gateway transmit.
- **Objects touched:** `ServiceFailureClaim` (created), `Carrier` (counterparty), `Exception` (linked).
- **Action — `RaiseServiceFailureClaim`:** For a `creditEligible` Exception on a guaranteed Lane, consumes the `Exception` and the CSA credit schedule; produces a `ServiceFailureClaim` with the calculated credit amount and the cited CSA clause attached. Submits the claim to the Carrier.
- **Events:** Triggered by **`ExceptionClassified`** with `creditEligible = true`. Emits **`ClaimSubmitted`**.

### Step 5.4 — Resolve and close
- **Actor / system:** Exception Coordinator, working in TMS.
- **Objects touched:** `Exception` (closed), `ServiceFailureClaim` (settled), `Shipment` (annotated).
- **Action — `ResolveException`:** Consumes the Carrier's claim disposition (accepted/credited or contested) and any corrective action; produces a closed `Exception` with resolution notes and a settled or written-off `ServiceFailureClaim`.
- **Events:** Triggered by Carrier claim disposition (surfaced as **`ClaimSettled`** or **`ClaimContested`**). Emits **`ExceptionResolved`**.

---

## 6. Sub-process — Customs Clearance (报关清关), invoked from Step 4.4

When a `Shipment` contains an international `Consignment`, the customs sub-process runs to completion before §4.5:
1. `FileCustomsDeclaration` (Customs Compliance Analyst / CBP-Link) — submit declaration; on hold, emits `CustomsHeld`.
2. Broker assesses duties and returns disposition; on acceptance the system assigns duties and emits `CustomsCleared`.
3. An international Consignment may not depart until its CustomsDeclaration is `Accepted` and duties are assigned (POL-OPS-2026 Rule 6).

## 7. Control Points & References

- Departure control (§4.6) and POD control (§4.8) are mandatory gates; bypassing either is an audit-reportable deviation.
- SLA evaluation (§4.7) and exception classification (§5.2) are governed by `02-business-rules-policy.md` and the `Carrier Service Agreement.pdf`.
- All customs steps are governed by the `Customs & Trade Compliance Guide.pdf`.

## 8. Process Summary

| Process (流程) | Trigger event | Terminal event | Key Objects |
|---|---|---|---|
| **Order to Delivery** (下单到送达) | `OrderReceived` | `ShipmentDelivered` | Order, Shipment, Consignment, Stop, Carrier, Lane, SLA, ProofOfDelivery |
| **Customs Clearance** (报关清关) | `ShipmentTendered` (international) | `CustomsCleared` | Consignment, CustomsDeclaration |
| **Exception to Resolution** (异常到结案) | `SLABreached` / `CustomsHeld` | `ExceptionResolved` | Exception, SLA, ServiceFailureClaim, Carrier |
