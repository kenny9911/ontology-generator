# Standard Operating Procedure — Care Pathway & Revenue Cycle (诊疗路径与收入周期)

**Document ID:** SOP-RCM-014
**Version:** 4.2
**Effective Date:** 2026-01-01
**Owner:** Revenue Cycle Operations & Clinical Informatics, Mercy Lakeside Health System
**Classification:** Internal — Operational
**Supersedes:** SOP-RCM-014 v4.1

---

## 1. Purpose & Scope

This Standard Operating Procedure documents the end-to-end operational flow from patient
registration through clinical care delivery, charge capture, claim submission, and remittance
posting. It governs two intertwined processes:

- **流程 A — Admission to Discharge (入院到出院):** the clinical pathway from scheduling/registration
  through triage, ordering, treatment, documentation, and discharge.
- **流程 B — Charge Capture to Claim (计费到理赔提交):** the financial pathway from charge generation
  through coding, claim assembly, scrubbing, submission, and remittance.

Two supporting processes are also defined here:

- **流程 C — Prior Authorization (事前授权):** obtaining payer approval for designated services.
- **流程 D — Denial Management & Appeal (拒付管理与申诉):** reworking and appealing rejected claims.

This SOP applies to all inpatient and outpatient **Encounters** at acute-care facilities. It does
not cover home-health or pharmacy-benefit billing, which are governed by separate procedures.

**Related documents:** `02-business-rules-policy.md` (Business Rules & Policy), `03-systems-and-data.md`
(Systems of Record & Data Entities), `Sepsis Care Pathway.pdf` (clinical protocol, referenced in §4.4).

---

## 2. Definitions

| Term | 中文 | Definition |
|------|------|------------|
| **Patient** | 患者 | A person who receives or is scheduled to receive care; uniquely identified by `MRN`. |
| **Encounter** | 就诊 | A single contact between a Patient and the health system; identified by `EncounterID`. |
| **Coverage** | 保险覆盖 | An active insurance benefit linking a Patient to a payer plan; identified by `CoverageID`. |
| **Order** | 医嘱 | A clinician instruction for a Procedure, medication, or test; identified by `OrderID`. |
| **Procedure** | 诊疗操作 | A billable clinical service, coded with CPT/HCPCS; identified by `ProcedureID`. |
| **Diagnosis** | 诊断 | A coded condition (ICD-10-CM) documented for an Encounter; identified by `DiagnosisID`. |
| **PriorAuthorization** | 事前授权 | A payer approval required before delivering a designated Procedure; identified by `AuthID`. |
| **Charge** | 费用项 | A financial line item generated from a documented Procedure; identified by `ChargeID`. |
| **Claim** | 理赔单 | A billing submission to a payer covering one Encounter's Charges; identified by `ClaimID`. |
| **Denial** | 拒付 | A payer rejection of a Claim or line, carrying a CARC/RARC reason; identified by `DenialID`. |

---

## 3. Roles & Responsible Systems

| Role / System | 中文 | Responsibility |
|---------------|------|----------------|
| Patient Access Representative | 接诊登记员 | Registration, eligibility verification, Coverage capture. |
| Triage Nurse | 分诊护士 | Triage assessment, vital capture, severity scoring. |
| Ordering Clinician | 开单医师 | Placing Orders, documenting Diagnoses, signing notes. |
| Utilization Management (UM) Coordinator | 授权管理协调员 | Submitting and tracking PriorAuthorization requests. |
| Coding Specialist | 编码专员 | Assigning final ICD-10/CPT codes; coding review. |
| Charge Integrity Analyst | 费用稽核分析师 | Reconciling charges, resolving charge-router errors. |
| Billing Specialist | 计费专员 | Claim assembly, scrubbing, submission, follow-up. |
| Denials Analyst | 拒付处理专员 | Working denials, drafting and submitting appeals. |
| **Epic EHR** | 电子病历系统 | System of record for clinical Encounters, Orders, Diagnoses. |
| **Epic Clarity** | 数据仓库 | Reporting warehouse; nightly extract of all clinical entities. |
| **CDM (Charge Master)** | 收费主数据 | Authoritative price/code reference for billable items. |
| **Revenue Cycle System (RCS / "Resolute")** | 收入周期系统 | Charge router, claim engine, remittance posting. |
| **Clearinghouse (Waystar)** | 清算网关 | EDI exchange (270/271, 278, 837, 835) with payers. |

---

## 4. Process A — Admission to Discharge (入院到出院)

### Step 4.1 — Registration & Identity Resolution
- **Actor / System:** Patient Access Representative → **Epic EHR**.
- **Objects touched:** `Patient`, `Encounter`.
- **Action:** **RegisterEncounter** — consumes patient demographics and scheduling data; produces a
  new `Encounter` record linked to the `Patient` (`MRN`).
- **Triggering event:** `PatientArrived` (kiosk check-in or scheduled-arrival signal).
- **Emitted event:** `EncounterCreated` — broadcast to RCS and Clarity.
- **Reference:** Rule R-01 (every Encounter must resolve to a single MRN).

### Step 4.2 — Eligibility & Coverage Verification
- **Actor / System:** Patient Access Representative → **Epic EHR** → **Clearinghouse**.
- **Objects touched:** `Coverage`, `Encounter`.
- **Action:** **VerifyEligibility** — consumes the `Coverage` on file; sends an EDI **270** eligibility
  inquiry; produces an eligibility result from the **271** response and stamps `Coverage.status`.
- **Triggering event:** `EncounterCreated`.
- **Emitted event:** `EligibilityVerified` (or `EligibilityFailed`).
- **Reference:** Rule R-02 (active Coverage must be verified before any non-emergency service).

### Step 4.3 — Triage & Severity Assessment
- **Actor / System:** Triage Nurse → **Epic EHR**.
- **Objects touched:** `Encounter`, `Diagnosis` (provisional).
- **Action:** **RecordTriage** — consumes vitals and chief complaint; produces a triage timestamp,
  an acuity level, and (when criteria met) sets the `Encounter.emergencyFlag`.
- **Triggering event:** `PatientArrived`.
- **Emitted event:** `TriageCompleted`; conditionally `SepsisSuspected` when SIRS criteria fire.
- **Reference:** Rule R-08 (sepsis bundle clock starts at the triage timestamp).

### Step 4.4 — Order Placement
- **Actor / System:** Ordering Clinician → **Epic EHR**.
- **Objects touched:** `Order`, `Procedure`, `Encounter`.
- **Action:** **PlaceOrder** — consumes the clinician's selection; produces one or more `Order`
  records, each referencing a catalog `Procedure`. For a designated high-cost imaging Procedure, the
  system checks for an approved `PriorAuthorization` and routes per Process C if none exists.
- **Triggering event:** `TriageCompleted` (or clinician initiative during the Encounter).
- **Emitted event:** `OrderPlaced`; conditionally `AuthorizationRequired` for designated Procedures.
- **Reference:** Rule R-04, Rule R-05. For sepsis, the `Sepsis Care Pathway.pdf` bundle order set
  must include a lactate draw (see Rule R-08).

### Step 4.5 — Service Delivery & Procedure Documentation
- **Actor / System:** Ordering Clinician → **Epic EHR**.
- **Objects touched:** `Procedure`, `Diagnosis`, `Encounter`.
- **Action:** **DocumentProcedure** — consumes the completed clinical work; produces a documented
  `Procedure` with start/stop times, links it to at least one supporting `Diagnosis`, and signs the
  clinical note.
- **Triggering event:** `OrderPlaced` and physical completion of the service.
- **Emitted event:** `ProcedureDocumented`.
- **Reference:** Rule R-09 (every billable Procedure links to a documented Diagnosis).

### Step 4.6 — Discharge & Encounter Closure
- **Actor / System:** Ordering Clinician → **Epic EHR**.
- **Objects touched:** `Encounter`.
- **Action:** **DischargeEncounter** — consumes the discharge order and final documentation;
  produces a closed `Encounter` (`status = Discharged`) and a discharge timestamp.
- **Triggering event:** Discharge order signed.
- **Emitted event:** `EncounterDischarged` — this is the trigger that opens Process B.
- **Reference:** Rule R-10 (Encounter must be coding-complete within 4 calendar days of discharge).

---

## 5. Process C — Prior Authorization (事前授权)

### Step 5.1 — Authorization Request Assembly
- **Actor / System:** UM Coordinator → **Epic EHR**.
- **Objects touched:** `PriorAuthorization`, `Procedure`, `Coverage`, `Encounter`.
- **Action:** **RequestAuthorization** — consumes the ordered `Procedure`, the `Coverage`, and
  supporting clinical documentation; produces a `PriorAuthorization` record in `Requested` state and
  transmits an EDI **278** request to the payer via the Clearinghouse.
- **Triggering event:** `AuthorizationRequired` (emitted in Step 4.4).
- **Emitted event:** `AuthorizationRequested`.
- **Reference:** Rule R-04, Rule R-06 (urgent request SLA).

### Step 5.2 — Authorization Adjudication & Posting
- **Actor / System:** **Clearinghouse** → **Epic EHR** (UM Coordinator reviews).
- **Objects touched:** `PriorAuthorization`.
- **Action:** **PostAuthorizationResponse** — consumes the payer's **278** response; updates the
  `PriorAuthorization` to `Approved`, `Denied`, or `Pended`, and records the approval number,
  approved units, and validity window.
- **Triggering event:** Payer 278 response received.
- **Emitted event:** `AuthorizationApproved` (releases the Order for scheduling) or
  `AuthorizationDenied` (returns the Order to the clinician).
- **Reference:** Rule R-05, Rule R-07 (authorization must be valid on the date of service).

---

## 6. Process B — Charge Capture to Claim (计费到理赔提交)

### Step 6.1 — Charge Generation (Charge Capture)
- **Actor / System:** **RCS Charge Router** (automated) ← **Epic EHR**.
- **Objects touched:** `Charge`, `Procedure`, `Encounter`.
- **Action:** **GenerateCharge** — consumes each `ProcedureDocumented` event; looks up the matching
  CDM line; produces one `Charge` per billable Procedure with price, revenue code, and units.
- **Triggering event:** `ProcedureDocumented`.
- **Emitted event:** `ChargeCaptured`; conditionally `ChargeRouterError` when no CDM match exists.
- **Reference:** Rule R-11 (every Charge maps to an active CDM line), Rule R-12 (late-charge window).

### Step 6.2 — Coding & Code Validation
- **Actor / System:** Coding Specialist → **Epic EHR** / **RCS**.
- **Objects touched:** `Diagnosis`, `Procedure`, `Charge`, `Encounter`.
- **Action:** **AssignCodes** — consumes the clinical documentation; produces final ICD-10-CM and
  CPT/HCPCS codes; runs the NCCI edit set and medical-necessity (LCD/NCD) checks against the
  Diagnosis–Procedure pairing.
- **Triggering event:** `EncounterDischarged` (coding work queue).
- **Emitted event:** `CodingCompleted`; conditionally `CodingEditFailed`.
- **Reference:** Rule R-09, Rule R-13 (medical-necessity linkage), Rule R-14 (no unbundling).

### Step 6.3 — Claim Assembly & Scrubbing
- **Actor / System:** **RCS Claim Engine** (automated) + Billing Specialist (review).
- **Objects touched:** `Claim`, `Charge`, `Coverage`, `Diagnosis`, `Procedure`, `PriorAuthorization`.
- **Action:** **AssembleClaim** — consumes all `ChargeCaptured` + `CodingCompleted` items for the
  Encounter; produces a draft `Claim`; runs the claim scrubber (eligibility re-check, auth presence,
  field completeness) and assigns `Claim.status = Ready` or `Held`.
- **Triggering event:** `CodingCompleted`.
- **Emitted event:** `ClaimAssembled`; conditionally `ClaimScrubFailed` (routes to a billing edit
  work queue).
- **Reference:** Rule R-03 (claim filing deadline), Rule R-05 (auth must be present on the Claim),
  Rule R-15 (scrub-clean before submission).

### Step 6.4 — Claim Submission
- **Actor / System:** **RCS** → **Clearinghouse** → payer.
- **Objects touched:** `Claim`.
- **Action:** **SubmitClaim** — consumes a `Ready` Claim; produces an EDI **837** transaction;
  transitions `Claim.status = Submitted`.
- **Triggering event:** `ClaimAssembled` with `status = Ready`.
- **Emitted event:** `ClaimSubmitted`; the Clearinghouse returns a **999/277CA** acknowledgment that
  raises `ClaimAccepted` or `ClaimRejected`.
- **Reference:** Rule R-03, Rule R-16 (no resubmission of an already-accepted Claim).

### Step 6.5 — Remittance Posting
- **Actor / System:** **RCS** (automated) ← **Clearinghouse**.
- **Objects touched:** `Claim`, `Charge`, `Denial`.
- **Action:** **PostRemittance** — consumes the payer's EDI **835** remittance; produces posted
  payments and adjustments at the Charge level; for any denied line, creates a `Denial` with its
  CARC/RARC code.
- **Triggering event:** `RemittanceReceived` (835 file lands).
- **Emitted event:** `PaymentPosted` and/or `ClaimDenied`.
- **Reference:** Rule R-17 (denial work-queue routing SLA).

---

## 7. Process D — Denial Management & Appeal (拒付管理与申诉)

### Step 7.1 — Denial Triage
- **Actor / System:** Denials Analyst → **RCS**.
- **Objects touched:** `Denial`, `Claim`, `Charge`.
- **Action:** **TriageDenial** — consumes a new `Denial`; classifies it (clinical, coding,
  authorization, eligibility, technical); routes it to rework or write-off.
- **Triggering event:** `ClaimDenied`.
- **Emitted event:** `DenialAssigned`.
- **Reference:** Rule R-17, Rule R-18 (appeal filing deadline).

### Step 7.2 — Appeal Submission
- **Actor / System:** Denials Analyst → **RCS** → **Clearinghouse**.
- **Objects touched:** `Denial`, `Claim`.
- **Action:** **SubmitAppeal** — consumes the corrected documentation/codes; produces a corrected
  `Claim` (frequency code 7) or a formal appeal packet; resubmits via the Clearinghouse.
- **Triggering event:** `DenialAssigned` with disposition = appeal.
- **Emitted event:** `AppealSubmitted` (re-enters the remittance loop at Step 6.5).
- **Reference:** Rule R-16, Rule R-18, Rule R-19 (write-off approval authority).

---

## 8. Process Summary (流程一览)

| Process | 中文 | Entry Event | Exit Event |
|---------|------|-------------|------------|
| A — Admission to Discharge | 入院到出院 | `PatientArrived` | `EncounterDischarged` |
| B — Charge Capture to Claim | 计费到理赔提交 | `ProcedureDocumented` | `PaymentPosted` |
| C — Prior Authorization | 事前授权 | `AuthorizationRequired` | `AuthorizationApproved` |
| D — Denial Management & Appeal | 拒付管理与申诉 | `ClaimDenied` | `AppealSubmitted` |

---

## 9. Revision History

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 4.0 | 2025-06-01 | RCM Ops | Split charge capture from claim assembly into discrete steps. |
| 4.1 | 2025-10-15 | Clinical Informatics | Added sepsis bundle reference (Step 4.4). |
| 4.2 | 2026-01-01 | RCM Ops | Added Denial Management process D; aligned events with RCS v9. |
