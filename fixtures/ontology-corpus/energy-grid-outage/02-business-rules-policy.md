# Grid Operations Business Rules & Compliance Policy

**Document ID:** POL-GRID-COMP-009
**Owner:** Regulatory Compliance & Asset Management
**Version:** 3.1
**Effective Date:** 2026-01-15
**Classification:** Internal — Compliance Controlled

**Related documents:** `Grid Outage SOP` (SOP-GRID-OPS-014), `Systems & Data Reference` (REF-GRID-SYS-003), `Vegetation Management Standard` (STD-VEG-021), `Outage Reporting Requirements (PUC)` (REG-PUC-2024-7), `Asset Inspection Procedure` (PROC-ASSET-INSP-002).

---

## 1. Scope

This policy states the explicit, atomic business rules (规则) that govern grid `Asset` inspection, `OutageEvent` handling, `MaintenanceWorkOrder` lifecycle, and `RegulatoryReport` filing at NorthGrid Electric. Each rule is written as a single enforceable clause. Object names match the SOP and the Systems & Data Reference.

---

## 2. Inspection & Asset Rules (巡检与资产)

**R-01.** A transmission-class `Asset` must have a completed `Inspection` within its rated inspection interval, and a missed interval shall automatically raise a priority `MaintenanceWorkOrder`. *(cited: PROC-ASSET-INSP-002 §3.1)*

**R-02.** An `Inspection` that returns a fail result is required to generate a corrective `MaintenanceWorkOrder` within 24 hours of the inspection completion timestamp. *(cited: PROC-ASSET-INSP-002 §3.4)*

**R-03.** A distribution-class `Asset` must be inspected at least once every 36 months, and a transmission-class `Asset` at least once every 12 months. *(cited: PROC-ASSET-INSP-002 §2.2)*

**R-04.** An `Asset` whose condition score falls below 40 on the 0–100 health scale shall not remain in service beyond 30 days without an approved `MaintenanceWorkOrder` on file.

## 3. Maintenance Work Order Rules (维护工单)

**R-05.** A `MaintenanceWorkOrder` against a safety-classified `Asset` may not be closed without a second qualified engineer's approval recorded in Maximo. *(cited: PROC-ASSET-INSP-002 §5.2)*

**R-06.** A `MaintenanceWorkOrder` with an estimated cost above $250,000 is required to obtain Asset Manager approval before crew assignment.

## 4. Outage Reporting Rules (停电报告)

**R-07.** An `OutageEvent` affecting more than 50,000 `ServicePoint`s must be reported to the regulator within 1 hour of its detection timestamp. *(cited: REG-PUC-2024-7 §4.1)*

**R-08.** A `RegulatoryReport` that is not submitted before its computed filing deadline shall escalate automatically to the Director of Compliance.

**R-09.** A `RegulatoryReport` for a major event affecting more than 100,000 `ServicePoint`s may not be submitted without the Director of Compliance's recorded approval. *(cited: REG-PUC-2024-7 §4.3)*

**R-10.** An `OutageEvent` with a restoration duration exceeding 24 hours is required to include a root-cause narrative in its `RegulatoryReport`. *(cited: REG-PUC-2024-7 §5.2)*

## 5. Vegetation Management Rules (植被管理)

**R-11.** Vegetation clearance on a high-voltage `Feeder` may not lapse beyond its assigned clearance cycle without a documented variance approved by the Asset Manager. *(cited: STD-VEG-021 §6)*

**R-12.** A high-voltage `Feeder` must be cleared on a cycle no longer than 48 months, and a `Feeder` traversing a designated wildfire-risk zone must be cleared on a cycle no longer than 24 months. *(cited: STD-VEG-021 §3.2)*

## 6. Outage Lifecycle & Dispatch Rules (停电生命周期与派工)

**R-13.** An `OutageEvent` may not be advanced to the `Closed` state until every affected `ServicePoint` has returned an AMI power-restored confirmation. *(cited: SOP-GRID-OPS-014 §3, Step 1.7)*

**R-14.** A `Crew` must be dispatched to any confirmed `OutageEvent` affecting a critical-care `Customer` within 2 hours of the outage confirmation timestamp.

**R-15.** An `OutageEvent` affecting a critical-infrastructure `ServicePoint` (hospital, water plant, emergency services) shall be assigned the highest restoration priority regardless of the affected `ServicePoint` count.

**R-16.** A `Crew` may not perform switching on a `Feeder` until the upstream `Substation` device state is confirmed open in SCADA.

**R-17.** An emergency `MaintenanceWorkOrder` created from an active `OutageEvent` must reference both the parent `OutageEvent` and the faulted `Asset`.

## 7. Data & Customer Notification Rules (数据与客户通知)

**R-18.** Every `ServicePoint` must be mapped to exactly one `Feeder` and exactly one `Customer` in the network model. *(cited: REF-GRID-SYS-003 §3)*

**R-19.** A `Customer` flagged as life-support-dependent shall be notified of any planned `OutageEvent` affecting their `ServicePoint` at least 48 hours in advance.

**R-20.** An `OutageEvent` cause code is required to be recorded before the `OutageEvent` may transition from `Restored` to `Closed`. *(cited: SOP-GRID-OPS-014 §3, Step 1.7)*

---

## 8. Exceptions & Variances

- A documented variance under Rule R-11 must specify the affected `Feeder`, the reason, and an expiry date, and may not exceed 90 days.
- Emergency switching under Rule R-16 may be waived by the Shift Supervisor only when public safety requires immediate de-energization, with the waiver logged against the `OutageEvent`.
