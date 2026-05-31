# Standard Operating Procedure — Engineering Change to Effectivity & Build to Inspection
## SOP-MFG-204 · Discrete Manufacturing — Bill-of-Materials & Quality / 物料清单与质量

| Field | Value |
|---|---|
| Document ID | SOP-MFG-204 |
| Revision | E (effective 2026-04-01) |
| Owner | Director of Manufacturing Engineering & Quality |
| Applies to | Plant 17 (Discrete Assembly), Engineering, Quality, Supply Chain |
| Systems of record | SAP ECC (PLM/ERP), Jira ECR project, Quality Data Mart |
| Related documents | `Quality Manual ISO9001.pdf`, `Engineering Change Procedure.docx`, `Work Instruction WI-204.pdf` |
| Standards | ISO 9001:2015 §8.3, §8.5, §8.7; IATF 16949 |

---

## 1. Purpose & Scope

This SOP defines two interlocking end-to-end **Processes** (流程):

- **Process P1 — Engineering Change to Effectivity (工程变更到生效):** how a proposed change to product structure moves from request through review, approval, and **revision effectivity** so the shop floor builds only to the currently effective specification.
- **Process P2 — Build to Inspection (生产到检验):** how a `WorkOrder` is released against an effective `BillOfMaterials`, built, inspected via an `InspectionLot`, and either released to stock/ship or routed into a `NonConformance`.

Two supporting **Processes** are referenced and partially executed here:

- **Process P3 — Supplier Qualification & Incoming Inspection (供应商资格与来料检验):** how a `Supplier`-provided `Part` lot is received and inspected before consumption.
- **Process P4 — Nonconformance Disposition & CAPA (不合格品处置与纠正措施):** how a `NonConformance` is investigated, dispositioned, and closed.

The canonical business **Objects** (对象) governed by this SOP are: `Part`, `BillOfMaterials`, `EngineeringChange`, `WorkOrder`, `Supplier`, `InspectionLot`, `NonConformance`, `Inspection`, `Disposition`, `CorrectiveAction`. Their identifiers and attributes are defined in `03-systems-and-data.md`.

The business **Rules** (规则) referenced as `[R-nn]` throughout this document are defined authoritatively in `02-business-rules-policy.md`.

---

## 2. Roles & Actors

| Actor / System | Responsibility |
|---|---|
| **Requestor** (any engineer) | Raises an `EngineeringChange` request. |
| **Change Coordinator** | Triages and routes the `EngineeringChange` through the Change Control Board. |
| **Change Control Board (CCB)** | Reviews and approves/rejects each `EngineeringChange`. |
| **Manufacturing Engineer** | Maintains the `BillOfMaterials` and `WorkOrder` routings in SAP ECC. |
| **Production Supervisor** | Releases and reports against `WorkOrder` operations on the shop floor. |
| **Quality Inspector** | Executes the `Inspection` and records `InspectionLot` results. |
| **Quality Engineer** | Dispositions `NonConformance` records and owns `CorrectiveAction`. |
| **Receiving Clerk** | Posts `Supplier` goods receipts and opens incoming `InspectionLot` records. |
| **SAP ECC** (system) | System of record for `Part`, `BillOfMaterials`, `WorkOrder`, `InspectionLot`. |
| **Jira ECR** (system) | System of record for the `EngineeringChange` request and its workflow. |
| **Quality Data Mart** (system) | System of record for `Inspection` results, SPC, and `NonConformance` analytics. |

---

## 3. Process P1 — Engineering Change to Effectivity (工程变更到生效)

### Step 3.1 — Raise the engineering change request
- **Actor / system:** Requestor → **Jira ECR**.
- **Objects touched:** `EngineeringChange` (created), `Part` (referenced as affected item(s)), `BillOfMaterials` (referenced).
- **Action (动作): `RaiseEngineeringChange`** — consumes the proposed change description and the list of affected `Part` numbers; produces a new `EngineeringChange` record in status `Draft` with a unique `ecr_id`.
- **Triggering event (事件):** `ChangeNeedIdentified` (a defect trend, customer request, or cost reduction surfaces).
- **Emitted event (事件):** `EngineeringChangeRaised`.

### Step 3.2 — Classify and screen for safety impact
- **Actor / system:** Change Coordinator → **Jira ECR**.
- **Objects touched:** `EngineeringChange` (updated with `safety_classified` flag), `Part` (its `safety_class` attribute is read).
- **Action (动作): `ClassifyEngineeringChange`** — consumes the affected `Part` master data; produces the change `category` (Minor / Major / Safety) and sets `requires_second_approval` per **[R-03]** when any affected `Part.safety_class = Critical`.
- **Triggering event (事件):** `EngineeringChangeRaised`.
- **Emitted event (事件):** `EngineeringChangeClassified`.

### Step 3.3 — Review and approve at the Change Control Board
- **Actor / system:** Change Control Board (CCB) → **Jira ECR**.
- **Objects touched:** `EngineeringChange` (status → `Approved` or `Rejected`), `BillOfMaterials` (proposed new revision attached).
- **Action (动作): `ApproveEngineeringChange`** — consumes the `EngineeringChange` package and CCB votes; produces an approval decision. Per **[R-03]**, a Safety-classified change requires a **second engineer's approval** before it may be released; per **[R-05]** the CCB quorum is at least three voting members.
- **Triggering event (事件):** `EngineeringChangeClassified`.
- **Emitted event (事件):** `EngineeringChangeApproved` (or `EngineeringChangeRejected`).

### Step 3.4 — Set revision and effectivity date in SAP ECC
- **Actor / system:** Manufacturing Engineer → **SAP ECC** (Engineering Change Management module).
- **Objects touched:** `Part` (`revision` incremented), `BillOfMaterials` (new `bom_revision` with `effective_from` date), `EngineeringChange` (status → `Released`).
- **Action (动作): `SetRevisionEffectivity`** — consumes the approved `EngineeringChange`; produces a new effective `BillOfMaterials` revision and bumps each affected `Part.revision`. Per **[R-06]** the `effective_from` date must be at least the configured lead time (default 5 business days) in the future unless an emergency change is flagged.
- **Triggering event (事件):** `EngineeringChangeApproved`.
- **Emitted event (事件):** `RevisionBecameEffective` (fires on the `effective_from` date) and the integration event `BomRevisionPublished` to downstream systems.

### Step 3.5 — Refresh work instructions and notify the shop floor
- **Actor / system:** Manufacturing Engineer → **SAP ECC** + Document Control.
- **Objects touched:** `WorkOrder` (open orders evaluated), `BillOfMaterials` (new revision).
- **Action (动作): `RevalidateOpenWorkOrders`** — consumes all open `WorkOrder` records that reference an affected `Part`; produces a hold flag on any `WorkOrder` still pointing at a superseded revision per **[R-01]**.
- **Triggering event (事件):** `RevisionBecameEffective`.
- **Emitted event (事件):** `WorkOrderRevalidationRequired` for each affected open `WorkOrder`.

> **Process P1 outputs** the canonical effective `BillOfMaterials` that Process P2 consumes.

---

## 4. Process P2 — Build to Inspection (生产到检验)

### Step 4.1 — Create and release the work order
- **Actor / system:** Production Supervisor → **SAP ECC** (Production Planning).
- **Objects touched:** `WorkOrder` (created → released), `BillOfMaterials` (read), `Part` (component availability checked).
- **Action (动作): `ReleaseWorkOrder`** — consumes the demand (planned order) and the **currently effective** `BillOfMaterials`; produces a released `WorkOrder` with reserved components. Per **[R-01]**, a `WorkOrder` **may not be released** unless every component `Part` in its `BillOfMaterials` is at the currently effective `revision`. Per **[R-02]**, release is blocked if any component `Part` carries an open `NonConformance` with disposition `Quarantine`.
- **Triggering event (事件):** `ProductionDemandConfirmed`.
- **Emitted event (事件):** `WorkOrderReleased` (or `WorkOrderReleaseBlocked` if a rule fails).

### Step 4.2 — Issue components and build
- **Actor / system:** Production Supervisor / operators → **SAP ECC** (goods issue) per `Work Instruction WI-204.pdf`.
- **Objects touched:** `WorkOrder` (operations confirmed), `Part` (component stock issued, finished `Part` produced).
- **Action (动作): `ConfirmProductionOperation`** — consumes issued component `Part` quantities; produces confirmed operation yield and, at the final operation, a finished `Part` lot pending inspection. Per **[R-09]** every goods issue must be backflushed against the released `WorkOrder` BOM revision, not the latest revision.
- **Triggering event (事件):** `WorkOrderReleased`.
- **Emitted event (事件):** `ProductionOperationConfirmed`; on final operation, `FinishedLotProduced`.

### Step 4.3 — Trigger the inspection lot
- **Actor / system:** **SAP ECC** Quality Management (automatic) → Quality Inspector.
- **Objects touched:** `InspectionLot` (created), `WorkOrder` (linked), `Part` (finished lot).
- **Action (动作): `OpenInspectionLot`** — consumes the `FinishedLotProduced` event and the inspection plan for that `Part`; produces a new `InspectionLot` in status `Open` with a sampling plan. Per **[R-07]** an `InspectionLot` is mandatory for any finished lot of a `Part` whose `inspection_required` flag is true.
- **Triggering event (事件):** `FinishedLotProduced`.
- **Emitted event (事件):** `InspectionLotOpened`.

### Step 4.4 — Perform inspection and record results
- **Actor / system:** Quality Inspector → **Quality Data Mart** (results) + **SAP ECC** (usage decision).
- **Objects touched:** `Inspection` (created), `InspectionLot` (results recorded), `Part`.
- **Action (动作): `RecordInspection`** — consumes the sampling plan and measured characteristics; produces an `Inspection` record with pass/fail per characteristic and an aggregate result. Per **[R-08]** the lot is `Accepted` only if the number of defects is at or below the AQL acceptance number for the sample size; otherwise it is `Rejected`.
- **Triggering event (事件):** `InspectionLotOpened`.
- **Emitted event (事件):** `InspectionRecorded`.

### Step 4.5 — Post the usage decision
- **Actor / system:** Quality Inspector → **SAP ECC** Quality Management.
- **Objects touched:** `InspectionLot` (status → `Accepted` / `Rejected`), `Part` (stock posting), `NonConformance` (conditionally created).
- **Action (动作): `PostUsageDecision`** — consumes the `Inspection` result; on `Accepted`, posts the lot to unrestricted stock and clears it to ship per **[R-04]**; on `Rejected`, **automatically opens a `NonConformance`** per **[R-04]** and posts the lot to blocked stock.
- **Triggering event (事件):** `InspectionRecorded`.
- **Emitted event (事件):** `InspectionLotAccepted` **or** `InspectionLotRejected` (the latter also emits `NonConformanceOpened`).

### Step 4.6 — Release to ship
- **Actor / system:** Production Supervisor → **SAP ECC** (Delivery).
- **Objects touched:** `WorkOrder` (closed), `Part` (finished lot), `InspectionLot` (must be `Accepted`).
- **Action (动作): `ReleaseLotToShip`** — consumes the accepted finished lot; produces a delivery-eligible lot. Per **[R-04]** a finished lot **may not ship** until its `InspectionLot` is `Accepted`.
- **Triggering event (事件):** `InspectionLotAccepted`.
- **Emitted event (事件):** `FinishedLotShippable`.

---

## 5. Process P3 — Supplier Qualification & Incoming Inspection (供应商资格与来料检验)

### Step 5.1 — Post goods receipt
- **Actor / system:** Receiving Clerk → **SAP ECC** (Inventory Management).
- **Objects touched:** `Supplier`, `Part` (received component), `InspectionLot` (incoming).
- **Action (动作): `PostGoodsReceipt`** — consumes the inbound delivery against a purchase order; produces a received `Part` lot in quality-inspection stock and, for inspection-required parts, an incoming `InspectionLot`. Per **[R-10]** goods may be received only from a `Supplier` whose `qualification_status = Approved`.
- **Triggering event (事件):** `SupplierDeliveryArrived`.
- **Emitted event (事件):** `GoodsReceiptPosted`; for inspection-required parts, `InspectionLotOpened`.

### Step 5.2 — Inspect incoming material
- **Actor / system:** Quality Inspector → **Quality Data Mart** + **SAP ECC**.
- **Objects touched:** `InspectionLot` (incoming), `Inspection`, `Part`, `NonConformance` (conditional).
- **Action (动作): `RecordInspection`** (same action type as 4.4, incoming variant) — consumes the incoming sampling plan; produces an `Inspection` result. A rejection triggers `PostUsageDecision` → `NonConformanceOpened` against the `Supplier`. Per **[R-11]** a `Supplier` exceeding the rejection-rate threshold of 2% over a rolling 90 days is auto-flagged for re-qualification.
- **Triggering event (事件):** `InspectionLotOpened`.
- **Emitted event (事件):** `InspectionRecorded`; conditionally `NonConformanceOpened`.

---

## 6. Process P4 — Nonconformance Disposition & CAPA (不合格品处置与纠正措施)

### Step 6.1 — Triage and assign the nonconformance
- **Actor / system:** Quality Engineer → **Quality Data Mart**.
- **Objects touched:** `NonConformance` (assigned), `InspectionLot` (linked), `Part`, `Supplier` (if incoming).
- **Action (动作): `TriageNonConformance`** — consumes the auto-opened `NonConformance`; produces an owner assignment and severity. Per **[R-12]** a `NonConformance` must be assigned an owner within 24 hours of opening; per **[R-15]** a safety-classified `Part` nonconformance must be escalated to the Quality Manager within 4 hours.
- **Triggering event (事件):** `NonConformanceOpened`.
- **Emitted event (事件):** `NonConformanceAssigned`.

### Step 6.2 — Disposition the material
- **Actor / system:** Quality Engineer / Material Review Board → **Quality Data Mart** + **SAP ECC**.
- **Objects touched:** `Disposition` (created), `NonConformance`, `Part` (stock moved per disposition).
- **Action (动作): `DispositionNonConformance`** — consumes the investigation findings; produces a `Disposition` of `UseAsIs`, `Rework`, `ReturnToSupplier`, `Quarantine`, or `Scrap`. Per **[R-13]** a `UseAsIs` or `Rework` disposition on a safety-classified `Part` requires Quality Manager sign-off; per **[R-02]** a `Quarantine` disposition blocks the affected `Part` from new `WorkOrder` release.
- **Triggering event (事件):** `NonConformanceAssigned`.
- **Emitted event (事件):** `NonConformanceDispositioned`.

### Step 6.3 — Open and close corrective action
- **Actor / system:** Quality Engineer → **Quality Data Mart**.
- **Objects touched:** `CorrectiveAction` (created → closed), `NonConformance` (closed), `EngineeringChange` (optionally raised).
- **Action (动作): `OpenCorrectiveAction`** — consumes the `Disposition` and root-cause analysis; produces a `CorrectiveAction` with a due date. Per **[R-14]** any `NonConformance` recurring three or more times within 90 days for the same `Part` requires a formal `CorrectiveAction` (CAPA). If the fix changes product structure, a new `EngineeringChange` is raised (re-entering Process P1).
- **Triggering event (事件):** `NonConformanceDispositioned`.
- **Emitted event (事件):** `CorrectiveActionOpened`; on verification, `CorrectiveActionClosed` and `NonConformanceClosed`.

---

## 7. Cross-Process Event Summary

| Event (事件) | Emitted by step | Consumed by |
|---|---|---|
| `EngineeringChangeRaised` | 3.1 | 3.2 |
| `EngineeringChangeClassified` | 3.2 | 3.3 |
| `EngineeringChangeApproved` | 3.3 | 3.4 |
| `RevisionBecameEffective` | 3.4 | 3.5, 4.1 |
| `WorkOrderReleased` | 4.1 | 4.2 |
| `FinishedLotProduced` | 4.2 | 4.3 |
| `InspectionLotOpened` | 4.3, 5.1 | 4.4, 5.2 |
| `InspectionRecorded` | 4.4, 5.2 | 4.5 |
| `InspectionLotAccepted` | 4.5 | 4.6 |
| `InspectionLotRejected` / `NonConformanceOpened` | 4.5, 5.2 | 6.1 |
| `NonConformanceDispositioned` | 6.2 | 6.3 |
| `CorrectiveActionClosed` | 6.3 | (process end / new ECR) |

## 8. References

- `02-business-rules-policy.md` — authoritative rule set `[R-01]`…`[R-16]`.
- `03-systems-and-data.md` — Objects, attributes, identifiers, and system integrations.
- `Quality Manual ISO9001.pdf §8.7` — Control of nonconforming outputs.
- `Engineering Change Procedure.docx` — CCB and revision effectivity rules.
- `Work Instruction WI-204.pdf` — shop-floor build instructions.
