# Standard Operating Procedure — Permitting & Benefits Eligibility (受理到裁定 / 裁定到申诉)

**Document ID:** SOP-PBE-014
**Owning unit:** Office of Permitting & Benefits Administration (OPBA)
**Version:** 4.2 (effective 2026-01-01)
**Supersedes:** SOP-PBE-013 (v3.7)
**Classification:** Internal — Procedural
**Related documents:** `02-business-rules-policy.md` (Administrative Rules Chapter 7), `03-systems-and-data.md` (Systems of Record), `Program Eligibility Manual.pdf`

---

## 1. Purpose & Scope

This SOP defines the end-to-end procedures by which the Office of Permitting & Benefits Administration receives, verifies, adjudicates, issues, inspects, and (where applicable) hears appeals on two related work streams handled by a single case-management platform:

- **Benefits eligibility** — income-tested assistance programs administered against household-size income thresholds.
- **Operating / occupancy permits** — discretionary permits requiring document verification and, in some classes, a physical inspection.

The procedures span four named **Processes** (流程):

1. **Intake to Determination** (受理到裁定) — §4
2. **Permit Issuance to Inspection** (核发到验收) — §5
3. **Determination to Appeal** (裁定到申诉) — §6
4. **Renewal & Recertification** (续期复核) — §7

All steps reference the business **Objects** (对象), **Actions** (动作), and **Events** (事件) cataloged in §3 and detailed in `03-systems-and-data.md`. Business **Rules** (规则) cited as `[BR-nn]` are defined in `02-business-rules-policy.md`.

## 2. Roles & Systems

| Role / System | Responsibility |
|---|---|
| **Applicant** (申请人) | Submits the Application and supporting Documents. |
| **Intake Clerk** | Performs completeness screening and Document logging. |
| **Caseworker** | Verifies Documents, evaluates EligibilityCriteria, records the Determination. |
| **Supervisor** | Approves high-value or override Determinations above caseworker authority. |
| **Inspector** | Conducts the physical Inspection for permit classes that require one. |
| **Appeals Officer** | Adjudicates Appeals and issues the Appeal decision. |
| **PBE-CMS** | Case-Management System — system of record for Case, Application, Determination, Appeal. |
| **DMS** | Document-Management System — stores submitted Documents and verification status. |
| **PORTAL** | Public self-service portal — entry point for Applications and Appeals. |
| **NOTIFY** | Notification service — issues correspondence (notices, decisions) to Applicants. |
| **PAY** | Payment gateway — collects permit fees. |

## 3. Object / Action / Event Catalog (referenced by all steps)

**Objects (对象):** `Applicant`, `Household`, `Application`, `Case`, `EligibilityCriterion`, `Document`, `Determination`, `Appeal`, `Permit`, `Inspection`, `Payment`.

**Actions (动作)** and their inputs → outputs, with triggering and emitted Events:

| Action | Consumes (input) | Produces (output) | Triggered by (event) | Emits (event) |
|---|---|---|---|---|
| `SubmitApplication` | Applicant, draft Application, Document set | Application (status `Submitted`), Case | Applicant action in PORTAL | `ApplicationSubmitted` |
| `ScreenCompleteness` | Application, Document set | Application (status `Accepted` or `ReturnedIncomplete`) | `ApplicationSubmitted` | `ApplicationAccepted` / `ApplicationReturned` |
| `VerifyDocument` | Document | Document (status `Verified` / `Rejected`) | `ApplicationAccepted` | `DocumentVerified` / `DocumentRejected` |
| `EvaluateEligibility` | Application, Household, verified Documents, EligibilityCriterion set | Determination (draft) | `DocumentVerified` (all required) | `EligibilityEvaluated` |
| `RecordDetermination` | draft Determination | Determination (status `Approved` / `Denied`) | `EligibilityEvaluated` | `DeterminationRecorded` |
| `EscalateForApproval` | Determination | Determination (status `PendingApproval`) | threshold breach `[BR-07]` | `ApprovalRequested` |
| `IssuePermit` | approved Determination, Payment | Permit (status `Active`) | `DeterminationRecorded` (Approved) + `PaymentCleared` | `PermitIssued` |
| `ScheduleInspection` | Permit | Inspection (status `Scheduled`) | `PermitIssued` (inspectable class) | `InspectionScheduled` |
| `RecordInspectionResult` | Inspection | Inspection (status `Passed` / `Failed`) | `InspectionScheduled` | `InspectionPassed` / `InspectionFailed` |
| `FileAppeal` | Determination, Appeal request | Appeal (status `Filed`) | Applicant action `[BR-11]` | `AppealFiled` |
| `DecideAppeal` | Appeal, Case record | Appeal (status `Upheld` / `Overturned`) | `AppealFiled` | `AppealDecided` |
| `CollectPayment` | Permit fee schedule, Applicant | Payment (status `Cleared`) | `DeterminationRecorded` (permit, Approved) | `PaymentCleared` / `PaymentFailed` |

---

## 4. Process — Intake to Determination (受理到裁定)

### Step 4.1 — Submit Application
- **Actor / system:** Applicant via **PORTAL** → **PBE-CMS**.
- **Objects touched:** `Applicant`, `Household`, `Application`, `Document`.
- **Action:** `SubmitApplication` consumes the Applicant profile, the draft Application, and the uploaded Document set; produces an Application in status `Submitted` and opens a new `Case`.
- **Events:** triggered by the Applicant's portal submission; emits **`ApplicationSubmitted`**, which starts the statutory processing clock referenced in `[BR-03]`.

### Step 4.2 — Screen for Completeness
- **Actor / system:** Intake Clerk in **PBE-CMS** (Document inventory pulled from **DMS**).
- **Objects touched:** `Application`, `Document`.
- **Action:** `ScreenCompleteness` checks the submitted Document set against the program's required-Document list. If any required Document is missing, the Application is set to `ReturnedIncomplete`; otherwise to `Accepted`.
- **Events:** triggered by `ApplicationSubmitted`; emits **`ApplicationAccepted`** or **`ApplicationReturned`**. A return suspends the clock per `[BR-04]`.

### Step 4.3 — Verify Documents
- **Actor / system:** Caseworker in **PBE-CMS**, reading Document content from **DMS**.
- **Objects touched:** `Document`, `Case`.
- **Action:** `VerifyDocument` is performed per Document; each is marked `Verified` or `Rejected` with a reason code. Per `[BR-01]`, the Case may not advance to Determination until **every required Document is `Verified`**.
- **Events:** triggered by `ApplicationAccepted`; emits **`DocumentVerified`** (or **`DocumentRejected`**, which loops back to a Document request).

### Step 4.4 — Evaluate Eligibility
- **Actor / system:** Caseworker in **PBE-CMS** (eligibility engine applies `EligibilityCriterion` rules).
- **Objects touched:** `Application`, `Household`, `EligibilityCriterion`, `Determination`.
- **Action:** `EvaluateEligibility` consumes the verified Application, the Household composition (size), and the income figures, then tests them against the active `EligibilityCriterion` set (income threshold by household size per `[BR-05]`, residency per `[BR-06]`). It produces a **draft** `Determination` with the decisive criterion attached.
- **Events:** triggered when all required `DocumentVerified` events are present; emits **`EligibilityEvaluated`**.

### Step 4.5 — Record (or Escalate) the Determination
- **Actor / system:** Caseworker; **Supervisor** if escalation is required.
- **Objects touched:** `Determination`, `Case`.
- **Action:** `RecordDetermination` finalizes the draft as `Approved` or `Denied`. If the case value or override exceeds caseworker authority `[BR-07]`, `EscalateForApproval` first routes the Determination to a Supervisor (status `PendingApproval`). Per `[BR-08]`, a `Denied` Determination must carry the specific `EligibilityCriterion` and rule citation.
- **Events:** emits **`DeterminationRecorded`**; an escalation emits **`ApprovalRequested`** then `DeterminationRecorded` on Supervisor sign-off.

### Step 4.6 — Notify the Applicant
- **Actor / system:** **NOTIFY**, triggered by **PBE-CMS**.
- **Objects touched:** `Determination`, `Applicant`.
- **Action:** the recorded Determination is rendered into a decision notice and sent to the Applicant. The notice text includes appeal rights and the deadline under `[BR-11]`.
- **Events:** triggered by `DeterminationRecorded`; emits **`DeterminationNotified`**.

> For benefit programs, the process ends here. For permit applications with an `Approved` Determination, continue to §5.

---

## 5. Process — Permit Issuance to Inspection (核发到验收)

### Step 5.1 — Collect Permit Fee
- **Actor / system:** Applicant via **PORTAL** → **PAY**.
- **Objects touched:** `Payment`, `Permit` (pending), `Applicant`.
- **Action:** `CollectPayment` consumes the fee schedule and Applicant payment instrument; produces a `Payment` in status `Cleared`. Per `[BR-09]`, a Permit may not be issued until its associated Payment is `Cleared`.
- **Events:** triggered by `DeterminationRecorded` (Approved, permit type); emits **`PaymentCleared`** or **`PaymentFailed`**.

### Step 5.2 — Issue Permit
- **Actor / system:** **PBE-CMS**.
- **Objects touched:** `Permit`, `Determination`, `Payment`.
- **Action:** `IssuePermit` consumes the approved Determination and the cleared Payment; produces a `Permit` in status `Active` with an issue date and expiry per `[BR-13]`.
- **Events:** triggered by `DeterminationRecorded` (Approved) **and** `PaymentCleared`; emits **`PermitIssued`**.

### Step 5.3 — Schedule Inspection (inspectable classes only)
- **Actor / system:** **PBE-CMS** → Inspector.
- **Objects touched:** `Permit`, `Inspection`.
- **Action:** `ScheduleInspection` creates an `Inspection` in status `Scheduled` for permit classes that require a physical check per `[BR-10]`.
- **Events:** triggered by `PermitIssued` for inspectable classes; emits **`InspectionScheduled`**.

### Step 5.4 — Conduct & Record Inspection
- **Actor / system:** Inspector in the field, syncing to **PBE-CMS**.
- **Objects touched:** `Inspection`, `Permit`.
- **Action:** `RecordInspectionResult` records `Passed` or `Failed` with findings. A `Failed` result moves the Permit to `ConditionalHold` and requires re-inspection within the window in `[BR-14]`.
- **Events:** triggered by `InspectionScheduled`; emits **`InspectionPassed`** or **`InspectionFailed`**.

---

## 6. Process — Determination to Appeal (裁定到申诉)

### Step 6.1 — File Appeal
- **Actor / system:** Applicant via **PORTAL** → **PBE-CMS**.
- **Objects touched:** `Appeal`, `Determination`, `Case`.
- **Action:** `FileAppeal` consumes the contested `Determination` and the Applicant's stated grounds; produces an `Appeal` in status `Filed`. Per `[BR-11]`, the Appeal must be filed within **30 calendar days** of `DeterminationNotified`.
- **Events:** triggered by the Applicant action; emits **`AppealFiled`**, which pauses any benefit reduction per `[BR-12]`.

### Step 6.2 — Assign & Review
- **Actor / system:** Appeals Officer in **PBE-CMS**.
- **Objects touched:** `Appeal`, `Case`, `Determination`, `Document`.
- **Action:** the Officer reviews the original Case record, the cited `EligibilityCriterion`, and the rule version in force on the determination date (versioned per `[BR-15]`).
- **Events:** triggered by `AppealFiled`; emits **`AppealUnderReview`**.

### Step 6.3 — Decide Appeal
- **Actor / system:** Appeals Officer.
- **Objects touched:** `Appeal`, `Determination`.
- **Action:** `DecideAppeal` records the outcome as `Upheld` (original Determination stands) or `Overturned` (Determination is revised). An overturn re-opens the `Case` and revises the `Determination` in place, preserving the prior version. The decision must issue within **45 calendar days** of `AppealFiled` per `[BR-16]`.
- **Events:** triggered by `AppealUnderReview`; emits **`AppealDecided`**, then **`DeterminationNotified`** for the revised decision.

---

## 7. Process — Renewal & Recertification (续期复核)

### Step 7.1 — Trigger Recertification
- **Actor / system:** **PBE-CMS** scheduler.
- **Objects touched:** `Case`, `Determination`, `Permit`.
- **Action:** at the recertification interval `[BR-17]`, the system generates a recertification task and notifies the Applicant.
- **Events:** emits **`RecertificationDue`**.

### Step 7.2 — Recertify
- **Actor / system:** Applicant + Caseworker, re-running §4.3–§4.5 on refreshed Documents.
- **Objects touched:** `Application`, `Document`, `Household`, `Determination`, `Permit`.
- **Action:** a recertification Application reuses `VerifyDocument`, `EvaluateEligibility`, and `RecordDetermination`. A lapsed recertification suspends benefits or moves the Permit to `Expired` per `[BR-18]`.
- **Events:** triggered by `RecertificationDue`; emits `DeterminationRecorded` (renewed) or **`CaseSuspended`**.

---

## 8. References

- Administrative Rules Chapter 7 — see `02-business-rules-policy.md`.
- Systems of Record, data entities & integration events — see `03-systems-and-data.md`.
- `Program Eligibility Manual.pdf` (income thresholds by household size).
- `Permit Application Procedure.docx` (required-Document lists by permit class).
