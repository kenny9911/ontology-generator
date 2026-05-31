# Grid Outage Detection, Restoration & Inspection — Standard Operating Procedure

**Document ID:** SOP-GRID-OPS-014
**Owner:** Distribution Operations Center (DOC) / Asset Management
**Version:** 4.2
**Effective Date:** 2026-01-15
**Classification:** Internal — Operations Controlled
**Supersedes:** SOP-GRID-OPS-014 v4.1

**Related documents:** `Business Rules & Compliance Policy` (POL-GRID-COMP-009), `Systems & Data Reference` (REF-GRID-SYS-003), `Vegetation Management Standard` (STD-VEG-021), `Outage Reporting Requirements (PUC)` (REG-PUC-2024-7).

---

## 1. Purpose & Scope

This Standard Operating Procedure governs the end-to-end handling of distribution and transmission grid events at NorthGrid Electric, from the moment an `OutageEvent` is detected through to confirmed restoration, regulatory reporting, and the routine inspection cycle that keeps `Asset` health current. It defines the responsible **actors** (人员/系统), the **business objects (对象)** touched at each step, the **system actions (动作)** taken, and the **events (事件)** that trigger or result from each step.

Three operational processes (流程) are documented here:

- **P1 — Detect to Restore (检测到复电):** from outage detection to verified restoration.
- **P2 — Outage Regulatory Reporting (停电监管报告):** from reportability determination to accepted PUC filing.
- **P3 — Inspect to Maintain (巡检到维护):** from scheduled `Inspection` to closed `MaintenanceWorkOrder`.

A fourth process, **P4 — Vegetation Cycle Management (植被周期管理)**, governs scheduled clearance on high-voltage feeders and is summarized in §7.

Systems of record referenced throughout: **OMS** (Outage Management System), **GIS** (Geographic Information System / network model), **Maximo** (Enterprise Asset Management), **AMI Head-End** (Advanced Metering Infrastructure telemetry), and the **RegFiling Portal** (PUC submission gateway).

---

## 2. Business Objects in Scope (对象)

| Object | Description | System of Record |
|---|---|---|
| `Asset` | Any physical grid component (transformer, breaker, conductor span, recloser) with a unique Asset Tag. | Maximo |
| `Feeder` | A distribution circuit energized from a `Substation`, serving many `ServicePoint`s. | GIS |
| `Substation` | A facility that transforms and switches voltage; parent of one or more `Feeder`s. | GIS |
| `ServicePoint` | A metered delivery point mapped to one `Customer` and one `Feeder`. | GIS / AMI |
| `Customer` | The billed account associated with a `ServicePoint`. | CIS (Customer Information System) |
| `OutageEvent` | A recorded loss of supply affecting one or more `ServicePoint`s, with a detection timestamp and lifecycle state. | OMS |
| `MaintenanceWorkOrder` | A unit of corrective or preventive field work against an `Asset`. | Maximo |
| `Inspection` | A scheduled or ad-hoc condition assessment of an `Asset`, producing a pass/fail result. | Maximo |
| `Crew` | A field workforce unit assigned to restore outages or execute work orders. | Maximo (Workforce) |
| `RegulatoryReport` | A filing submitted to the PUC for a reportable `OutageEvent`. | RegFiling Portal |

---

## 3. Process P1 — Detect to Restore (检测到复电)

### Step 1.1 — Detect loss of supply
- **Actor / system:** AMI Head-End (automated) and field SCADA.
- **Objects touched:** `ServicePoint`, `Feeder`.
- **Action (动作):** `DetectOutage` — consumes last-gasp meter signals and SCADA breaker-open telemetry; produces a candidate `OutageEvent` record in OMS with state `Detected` and a `detectionTimestamp`.
- **Triggering event:** `MeterLastGaspReceived` (from AMI) or `BreakerTripped` (from SCADA).
- **Resulting event:** `OutageDetected` emitted by OMS.

### Step 1.2 — Confirm and scope the outage
- **Actor / system:** OMS prediction engine; DOC Operator reviews.
- **Objects touched:** `OutageEvent`, `Feeder`, `Substation`, `ServicePoint`.
- **Action (动作):** `ScopeOutage` — consumes the network topology from GIS (Substation → Feeder → ServicePoint) and the set of dark meters; produces the predicted upstream device and the **affected `ServicePoint` count**, then advances the `OutageEvent` to state `Confirmed`.
- **Triggering event:** `OutageDetected`.
- **Resulting event:** `OutageConfirmed`, carrying `affectedServicePointCount`.

### Step 1.3 — Determine reportability (handoff to P2)
- **Actor / system:** OMS Compliance module (automated).
- **Objects touched:** `OutageEvent`.
- **Action (动作):** `EvaluateReportability` — consumes `affectedServicePointCount` and `detectionTimestamp`; applies the regulatory threshold (see POL-GRID-COMP-009, Rule R-07); produces a `reportable` flag and a **reporting clock** start time when the threshold is met.
- **Triggering event:** `OutageConfirmed`.
- **Resulting event:** `ReportabilityDetermined`; if reportable, also emits `RegulatoryClockStarted` which initiates Process P2 (§4).

### Step 1.4 — Dispatch crew
- **Actor / system:** DOC Dispatcher (human) via Maximo Workforce.
- **Objects touched:** `OutageEvent`, `Crew`, `MaintenanceWorkOrder`.
- **Action (动作):** `DispatchCrew` — consumes the confirmed outage scope and crew availability; produces a `Crew` assignment and, where field repair is needed, an emergency `MaintenanceWorkOrder` linked to the `OutageEvent` and the suspected `Asset`.
- **Triggering event:** `OutageConfirmed`.
- **Resulting event:** `CrewDispatched`.

### Step 1.5 — Field assessment and repair
- **Actor / system:** Field `Crew` (human) reporting through the Maximo mobile client.
- **Objects touched:** `MaintenanceWorkOrder`, `Asset`, `OutageEvent`.
- **Action (动作):** `LogFieldFinding` — consumes the crew's on-site assessment; produces an updated `MaintenanceWorkOrder` with diagnosed cause and the confirmed faulted `Asset`, and advances the `OutageEvent` to state `RepairInProgress`.
- **Triggering event:** `CrewDispatched` plus crew arrival.
- **Resulting event:** `FieldFindingLogged`; if a previously unknown defective asset is found, also emits `AssetDefectIdentified`.

### Step 1.6 — Restore supply
- **Actor / system:** Field `Crew` executes switching; OMS confirms via AMI.
- **Objects touched:** `OutageEvent`, `Feeder`, `ServicePoint`.
- **Action (动作):** `RestoreSupply` — consumes the completed switching/repair; produces re-energization, an `OutageEvent` state of `Restored`, a `restorationTimestamp`, and a computed outage duration.
- **Triggering event:** `FieldFindingLogged` and switching complete.
- **Resulting event:** `SupplyRestored` (per `ServicePoint`) and `OutageRestored` (for the event).

### Step 1.7 — Verify and close
- **Actor / system:** OMS (automated verification via AMI power-up signals) and DOC Operator (manual confirmation).
- **Objects touched:** `OutageEvent`, `ServicePoint`, `MaintenanceWorkOrder`.
- **Action (动作):** `CloseOutage` — consumes AMI "power restored" confirmations for all affected `ServicePoint`s; produces a closed `OutageEvent` (state `Closed`) and triggers finalization of the linked `MaintenanceWorkOrder`.
- **Triggering event:** `OutageRestored` plus all `ServicePoint`s confirmed live.
- **Resulting event:** `OutageClosed`.

---

## 4. Process P2 — Outage Regulatory Reporting (停电监管报告)

### Step 2.1 — Open regulatory case
- **Actor / system:** OMS Compliance module; Regulatory Analyst on call (human).
- **Objects touched:** `OutageEvent`, `RegulatoryReport`.
- **Action (动作):** `OpenRegulatoryReport` — consumes the reportable `OutageEvent` and its scope; produces a draft `RegulatoryReport` with the **filing deadline** computed from `RegulatoryClockStarted` (see Rule R-07: within 1 hour of detection for events over 50,000 `ServicePoint`s).
- **Triggering event:** `RegulatoryClockStarted`.
- **Resulting event:** `RegulatoryReportOpened`.

### Step 2.2 — Compile and validate filing
- **Actor / system:** Regulatory Analyst (human) using OMS-supplied data.
- **Objects touched:** `RegulatoryReport`, `OutageEvent`, `Customer`, `ServicePoint`.
- **Action (动作):** `CompileRegulatoryReport` — consumes affected-customer counts (ServicePoint → Customer), cause code, and estimated restoration time; produces a validated `RegulatoryReport` ready for submission.
- **Triggering event:** `RegulatoryReportOpened`.
- **Resulting event:** `RegulatoryReportCompiled`.

### Step 2.3 — Submit to PUC
- **Actor / system:** Regulatory Analyst (human) via RegFiling Portal; Director of Compliance approves filings for major events.
- **Objects touched:** `RegulatoryReport`.
- **Action (动作):** `SubmitRegulatoryReport` — consumes the validated report; produces a submitted `RegulatoryReport` with a portal confirmation ID, stopping the reporting clock.
- **Triggering event:** `RegulatoryReportCompiled` (and, per Rule R-09, Director approval for major events).
- **Resulting event:** `RegulatoryReportSubmitted`; on portal acceptance, `RegulatoryReportAccepted`.

> **Note:** If the filing deadline passes without a `RegulatoryReportSubmitted` event, OMS emits `RegulatoryDeadlineBreached` and escalates to the Director of Compliance (see Rule R-08).

---

## 5. Process P3 — Inspect to Maintain (巡检到维护)

### Step 3.1 — Schedule inspection
- **Actor / system:** Maximo PM (Preventive Maintenance) scheduler (automated).
- **Objects touched:** `Asset`, `Inspection`.
- **Action (动作):** `ScheduleInspection` — consumes each `Asset`'s rated inspection interval and last completed date; produces a scheduled `Inspection` record with a due date.
- **Triggering event:** `InspectionIntervalElapsed` (timer) or asset commissioning.
- **Resulting event:** `InspectionScheduled`.

### Step 3.2 — Execute inspection
- **Actor / system:** Field `Crew` / Inspector (human) via Maximo mobile.
- **Objects touched:** `Inspection`, `Asset`.
- **Action (动作):** `RecordInspectionResult` — consumes the inspector's condition assessment; produces a completed `Inspection` with a pass/fail result and a recorded completion date against the `Asset`.
- **Triggering event:** `InspectionScheduled` plus inspector arrival.
- **Resulting event:** `InspectionCompleted`; if the result is fail, also emits `AssetDefectIdentified`.

### Step 3.3 — Raise corrective work order
- **Actor / system:** Maximo (automated rule) and Maintenance Planner (human review).
- **Objects touched:** `Inspection`, `Asset`, `MaintenanceWorkOrder`.
- **Action (动作):** `RaiseMaintenanceWorkOrder` — consumes a failed `Inspection` or a missed inspection interval; produces a `MaintenanceWorkOrder` with a priority derived from asset class (transmission assets auto-raise priority per Rule R-01).
- **Triggering event:** `AssetDefectIdentified` or `InspectionIntervalMissed`.
- **Resulting event:** `MaintenanceWorkOrderRaised`.

### Step 3.4 — Plan, approve, and assign
- **Actor / system:** Maintenance Planner (human); Asset Manager approves high-cost or safety-classified work (Rule R-05).
- **Objects touched:** `MaintenanceWorkOrder`, `Crew`, `Asset`.
- **Action (动作):** `ApproveMaintenanceWorkOrder` — consumes the raised work order; produces an approved, scheduled, and crew-assigned `MaintenanceWorkOrder`.
- **Triggering event:** `MaintenanceWorkOrderRaised`.
- **Resulting event:** `MaintenanceWorkOrderApproved`.

### Step 3.5 — Execute and close
- **Actor / system:** Field `Crew` (human) via Maximo mobile.
- **Objects touched:** `MaintenanceWorkOrder`, `Asset`.
- **Action (动作):** `CompleteMaintenanceWorkOrder` — consumes the completed field repair; produces a closed `MaintenanceWorkOrder`, updates the `Asset` condition record, and resets the inspection clock if the work cleared the defect.
- **Triggering event:** `MaintenanceWorkOrderApproved` plus work performed.
- **Resulting event:** `MaintenanceWorkOrderClosed`.

---

## 6. Cross-Process Handoffs

- An `OutageEvent` that exposes a defective `Asset` during P1 (Step 1.5, `AssetDefectIdentified`) feeds Step 3.3 of P3, raising a follow-up `MaintenanceWorkOrder` even after supply is restored.
- A reportable `OutageEvent` confirmed in P1 (Step 1.3) launches P2 via `RegulatoryClockStarted`; P1 restoration and P2 reporting proceed in parallel.
- A failed `Inspection` in P3 may itself reveal a condition that, if it later causes a trip, originates a new `OutageEvent` in P1 — closing the loop.

---

## 7. Process P4 — Vegetation Cycle Management (植被周期管理) [Summary]

The vegetation program schedules clearance on each high-voltage `Feeder` on a fixed cycle. The action `ScheduleVegetationClearance` consumes the feeder's clearance cycle and last-completed date and produces a vegetation `MaintenanceWorkOrder`. A cycle that lapses without completion or a documented variance emits `VegetationCycleLapsed` and is governed by Rules R-11 and R-12. Detailed steps are maintained in STD-VEG-021.

---

## 8. Revision History

| Version | Date | Summary |
|---|---|---|
| 4.0 | 2025-06-01 | Added AMI-based auto-verification of restoration (Step 1.7). |
| 4.1 | 2025-10-12 | Aligned reporting clock with REG-PUC-2024-7. |
| 4.2 | 2026-01-15 | Added Director approval gate for major-event filings (Step 2.3). |
