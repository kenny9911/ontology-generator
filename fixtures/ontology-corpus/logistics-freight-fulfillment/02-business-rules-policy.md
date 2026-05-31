# Freight Operations Policy — Business Rules / 货运操作政策 — 业务规则

**Document ID:** POL-OPS-2026
**Version:** 3.0
**Owner:** Director, Trade Compliance & Carrier Management
**Effective Date:** 2026-01-15
**Classification:** Internal — Operations & Compliance
**Related documents:** `Carrier Service Agreement.pdf` (CSA), `Customs & Trade Compliance Guide.pdf` (CTCG), `Warehouse Operations SOP.docx` (= `01-process-sop.md`, SOP-OPS-014), `03-systems-and-data.md`

---

## 1. Purpose

This document states the explicit, atomic business rules governing the **Order to Delivery** and **Exception to Resolution** processes. Each rule is written as a single extractable statement. Objects referenced (`Shipment`, `Consignment`, `Carrier`, `Lane`, `SLA`, `CustomsDeclaration`, `ProofOfDelivery`, `Exception`, `ServiceFailureClaim`, `Order`, `Stop`) are defined in `03-systems-and-data.md`.

## 2. Conventions

Rules use **must**, **shall**, **may not**, **is required to**, and **may** with their ordinary obligation/permission meanings. Thresholds and time limits are expressed in concrete units. Each rule carries a source citation.

---

## 3. Rules

**R1.** An `Order` must be assigned to at least one `Consignment` before a `Shipment` may be planned. — *cited to SOP-OPS-014 §4.1–4.2.*

**R2.** A `Shipment` must be tendered to a `Carrier` that is qualified for the Shipment's `Lane`; a Carrier not listed on the Lane's approved-carrier roster may not be tendered freight on that Lane. — *cited to CSA §2.1.*

**R3.** A `Shipment` on a guaranteed `Lane` that misses its committed delivery window is required to qualify for a service-failure credit from the `Carrier`. — *cited to `Carrier Service Agreement.pdf` §7.3.*

**R4.** The service-failure credit on a guaranteed `Lane` shall equal 25% of the linehaul charge when delivery is late by up to 24 hours, and 100% of the linehaul charge when delivery is late by more than 24 hours. — *cited to CSA §7.4 (Credit Schedule).*

**R5.** A `ServiceFailureClaim` must be submitted to the `Carrier` within 30 calendar days of the `ShipmentDelivered` event, or the claim is waived. — *cited to CSA §7.6.*

**R6.** An international `Consignment` may not depart the origin facility until its `CustomsDeclaration` status is `Accepted` and duties are assigned. — *cited to `Customs & Trade Compliance Guide.pdf` §3.2.*

**R7.** A `CustomsDeclaration` is required to be filed at least 24 hours before the scheduled departure for any ocean `Consignment` and at least 4 hours before for any air `Consignment`. — *cited to CTCG §3.4.*

**R8.** Any `Consignment` with a declared customs value at or above USD 2,500 must include a formal entry with a licensed customs broker; below USD 2,500 an informal entry may be used. — *cited to CTCG §4.1.*

**R9.** A `Consignment` whose contents include controlled or dual-use commodities shall not be released for departure without a recorded export-license reference on its `CustomsDeclaration`. — *cited to CTCG §5.2.*

**R10.** A `Shipment` may not be marked `In Transit` until the pickup `Stop` is confirmed and the first `TrackingEvent` is recorded. — *cited to SOP-OPS-014 §4.6.*

**R11.** A `Shipment` may not be marked `Delivered` without a captured `ProofOfDelivery`. — *cited to `Warehouse Operations SOP.docx` §4.8.*

**R12.** A `ProofOfDelivery` must include a delivery timestamp and a recipient signature; a delivery left without signature is required to capture a geotagged photo in lieu of signature. — *cited to SOP-OPS-014 §4.8.*

**R13.** An `Exception` must be opened automatically within 15 minutes of an `SLABreached` or `CustomsHeld` event. — *cited to SOP-OPS-014 §5.1.*

**R14.** An `Exception` classified as `liability = CARRIER` on a guaranteed `Lane` is required to generate a `ServiceFailureClaim`; an `Exception` classified as `FORCE_MAJEURE` may not generate a claim. — *cited to CSA §7.5.*

**R15.** A `ServiceFailureClaim` exceeding USD 10,000 in credit value must receive Operations Director approval before submission to the Carrier. — *cited to POL-OPS-2026 §6 (Approval Matrix).*

**R16.** A `Carrier` whose rolling 30-day on-time delivery rate falls below 95% on a guaranteed `Lane` shall be placed on a performance-review hold and may not be tendered new guaranteed-Lane freight until reinstated. — *cited to CSA §8.2.*

**R17.** A detention charge may be claimed by the `Carrier` only when dwell at a `Stop` exceeds 2 hours beyond the scheduled appointment window. — *cited to CSA §6.1.*

**R18.** A damaged or lost `Consignment` claim must be filed by the customer within 9 months of the delivery date or the date delivery should have occurred, per the Carmack Amendment. — *cited to CSA §9.1.*

**R19.** A high-value `Shipment` with declared cargo value exceeding USD 100,000 must be tendered only to a `Carrier` carrying cargo insurance of at least the declared value and shall require a team-driver or in-transit-visibility commitment. — *cited to CSA §5.3.*

**R20.** An `Exception` may not be closed until its linked `ServiceFailureClaim`, if any, is in a terminal state (`Settled`, `Credited`, or `WrittenOff`). — *cited to SOP-OPS-014 §5.4.*

---

## 4. Exceptions to the Rules

- **E1.** Rule R6 does not apply to in-bond movements transiting to a bonded facility, which depart under a separate in-bond authorization. — *cited to CTCG §3.7.*
- **E2.** Rule R11 may be temporarily satisfied by a Carrier-system electronic POD when the WMS POD capture is unavailable, provided the electronic POD is reconciled within 24 hours. — *cited to SOP-OPS-014 §4.8 note.*

## 5. Object Lifecycle Status Values (referenced by rules)

- `Order`: `Received` → `Accepted` / `Rejected`.
- `Shipment`: `Planned` → `Tendered` → `In Transit` → `Delivered` / `Cancelled`.
- `Consignment`: `Created` → `Staged` → `Departed` → `Delivered`.
- `CustomsDeclaration`: `Draft` → `Filed` → `Accepted` / `Held` / `Rejected`.
- `Exception`: `Open` → `Classified` → `Resolved` / `Closed`.
- `ServiceFailureClaim`: `Draft` → `Submitted` → `Settled` / `Credited` / `Contested` / `WrittenOff`.

## 6. Approval Matrix

| Decision | Threshold | Approval level |
|---|---|---|
| Submit service-failure claim | ≤ USD 10,000 | Exception Coordinator |
| Submit service-failure claim | > USD 10,000 | Operations Director (R15) |
| Reinstate held Carrier | n/a | Director, Carrier Management (R16) |
| Tender high-value Shipment | > USD 100,000 cargo value | Trade Compliance review (R19) |
