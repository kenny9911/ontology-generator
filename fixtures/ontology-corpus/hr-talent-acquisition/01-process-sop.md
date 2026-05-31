# Standard Operating Procedure — Talent Acquisition: Requisition to Hire
## 招聘标准作业流程 — 需求到入职

**Document ID:** TA-SOP-001
**Version:** 4.2
**Owner:** Talent Acquisition Operations (TA Ops)
**Effective Date:** 2026-01-15
**Review Cycle:** Annual
**Applies to:** All regular full-time and fixed-term requisitions in North America and EMEA.
**Related documents:** `02-business-rules-policy.md` (TA-POL-002), `03-systems-and-data.md` (TA-SYS-003), Compensation Guidelines (COMP-GL-2026), Interview & Hiring Policy (IHP-2026).

---

## 1. Purpose and Scope

This SOP defines the end-to-end Talent Acquisition process from the moment a hiring need is identified through to a signed Offer and the handoff to Onboarding. It names, for every step, the responsible **Actor or system**, the business **Objects (对象)** touched, the **Action (动作)** taken (with what it consumes and produces), and the **Event(s) (事件)** that trigger or result from the step.

The canonical systems of record are **Workday** (positions, headcount, approval chains, employee records), **Greenhouse ATS** (Requisition, Candidate, Application, Stage, Scorecard, Offer), **HackerRank** (technical Assessment), **Checkr** (BackgroundCheck), and **DocuSign** (Offer signature). Their data contracts are defined in `03-systems-and-data.md`.

This process is decomposed into five sub-processes (流程):

- **P1 — Requisition Intake & Approval (需求受理与审批)**
- **P2 — Sourcing & Application (寻源与投递)**
- **P3 — Screening to Offer (筛选到录用)**
- **P4 — Offer Approval (录用审批)**
- **P5 — Offer to Onboarding (录用到入职)**

---

## 2. Roles and Systems (Actors)

| Actor / System | Responsibility |
|---|---|
| Hiring Manager (HM) | Opens the Requisition, defines criteria, scores interviews, recommends the Offer. |
| HR Business Partner (HRBP) | Validates headcount and approval chain in Workday. |
| Recruiter | Owns the Application funnel, screens Candidates, schedules the InterviewPanel, drafts the Offer. |
| Sourcer | Identifies and contacts passive Candidates. |
| Interviewer | Member of the InterviewPanel; submits a Scorecard per InterviewStage. |
| Compensation Analyst (Comp) | Validates the proposed salary against the SalaryBand. |
| VP / Department Head | Approves above-band Offers and over-budget Requisitions. |
| Workday | System of record for Position, headcount, and Approval chain. |
| Greenhouse ATS | System of record for Requisition, Candidate, Application, Stage, Scorecard, Offer. |
| HackerRank | Technical Assessment provider. |
| Checkr | BackgroundCheck provider. |
| DocuSign | Offer signature provider. |

---

## 3. Process Steps

### P1 — Requisition Intake & Approval (需求受理与审批)

**Step 1.1 — Identify hiring need and create a Position request.**
- **Actor:** Hiring Manager.
- **Objects:** `Position` (Workday), `Requisition` (draft).
- **Action:** `CreateRequisition` — consumes the Hiring Manager's role definition, the target `SalaryBand`, and the `Position` ID from Workday; produces a `Requisition` record in `Draft` status in Greenhouse, linked to the Workday `Position`.
- **Trigger event:** `HiringNeedIdentified`.
- **Emitted event:** `RequisitionCreated`.

**Step 1.2 — Validate headcount and budget.**
- **Actor:** HR Business Partner; **System:** Workday.
- **Objects:** `Requisition`, `Position`, `Approval`.
- **Action:** `ValidateHeadcount` — consumes the `Requisition` and the approved `Position` headcount and budget in Workday; produces a `headcountValidated` flag and an open `Approval` task routed to the approval chain. A `Requisition` with no funded `Position` is returned to the Hiring Manager.
- **Trigger event:** `RequisitionCreated`.
- **Emitted event:** `RequisitionSubmittedForApproval`.

**Step 1.3 — Approve or reject the Requisition.**
- **Actor:** Approval chain (HM's manager, then Finance; VP if over budget).
- **Objects:** `Requisition`, `Approval`.
- **Action:** `ApproveRequisition` — consumes the open `Approval` task and the budget check; produces an `Approval` record with decision, approver, level, and timestamp, and transitions the `Requisition` to `Approved` or `Rejected`.
- **Trigger event:** `RequisitionSubmittedForApproval`.
- **Emitted event:** `RequisitionApproved` (or `RequisitionRejected`).
- **Reference:** Approval levels and the over-budget VP rule are defined in TA-POL-002 §R3 and §R4.

**Step 1.4 — Publish the Requisition as a Job.**
- **Actor:** Recruiter; **System:** Greenhouse ATS.
- **Objects:** `Requisition`, `Job Post`.
- **Action:** `PublishJob` — consumes the `Approved` `Requisition`; produces one or more public/internal `Job Post` records and opens the Application funnel.
- **Trigger event:** `RequisitionApproved`.
- **Emitted event:** `JobPublished`.

### P2 — Sourcing & Application (寻源与投递)

**Step 2.1 — Source passive Candidates.**
- **Actor:** Sourcer.
- **Objects:** `Candidate`.
- **Action:** `SourceCandidate` — consumes search criteria from the `Requisition`; produces or updates a `Candidate` record (deduplicated by email).
- **Trigger event:** `JobPublished`.
- **Emitted event:** `CandidateSourced`.

**Step 2.2 — Receive an Application.**
- **Actor:** Candidate (self-apply) or Recruiter (on behalf); **System:** Greenhouse ATS.
- **Objects:** `Candidate`, `Application`, `Requisition`.
- **Action:** `CreateApplication` — consumes the `Candidate` and the published `Requisition`; produces an `Application` record in stage `Application Review`, linking exactly one `Candidate` to one `Requisition`.
- **Trigger event:** `JobPublished` / `CandidateSourced`.
- **Emitted event:** `ApplicationReceived`.

### P3 — Screening to Offer (筛选到录用)

**Step 3.1 — Screen the Application.**
- **Actor:** Recruiter.
- **Objects:** `Application`, `Candidate`.
- **Action:** `ScreenApplication` — consumes the `Application` and the `Requisition` criteria; produces an updated `Application` stage of either `Recruiter Screen` (advance) or `Rejected`. Records a screening disposition reason.
- **Trigger event:** `ApplicationReceived`.
- **Emitted event:** `ApplicationAdvanced` (or `ApplicationRejected`).

**Step 3.2 — Administer the technical Assessment (if required by the role).**
- **Actor:** Recruiter; **System:** HackerRank.
- **Objects:** `Application`, `Assessment`.
- **Action:** `RequestAssessment` — consumes the `Application`; produces an `Assessment` invitation and, on completion, an `Assessment` score written back to the `Application`.
- **Trigger event:** `ApplicationAdvanced`.
- **Emitted event:** `AssessmentCompleted`.
- **Reference:** Pass threshold defined in TA-POL-002 §R7.

**Step 3.3 — Schedule the structured InterviewPanel.**
- **Actor:** Recruiter; **System:** Greenhouse ATS + calendar integration.
- **Objects:** `Application`, `InterviewStage`, `InterviewPanel`, `Interviewer`.
- **Action:** `ScheduleInterview` — consumes the `Application` and a roster of available `Interviewer`s; produces one `InterviewPanel` of at least three `Interviewer`s bound to one `InterviewStage`, and advances the `Application` to stage `Onsite`.
- **Trigger event:** `AssessmentCompleted` (or `ApplicationAdvanced` if no Assessment).
- **Emitted event:** `InterviewScheduled`.
- **Reference:** Minimum panel size defined in TA-POL-002 §R5.

**Step 3.4 — Conduct interviews and submit Scorecards.**
- **Actor:** Interviewer(s).
- **Objects:** `InterviewStage`, `Scorecard`, `Application`.
- **Action:** `SubmitScorecard` — consumes the structured interview kit for the `InterviewStage`; produces one `Scorecard` per `Interviewer` with a recommendation (Strong Yes / Yes / No / Strong No).
- **Trigger event:** `InterviewScheduled`.
- **Emitted event:** `ScorecardSubmitted`; when all panel scorecards are in, `InterviewCompleted`.

**Step 3.5 — Make the hiring decision (debrief).**
- **Actor:** Hiring Manager + InterviewPanel.
- **Objects:** `Application`, `Scorecard`.
- **Action:** `RecordHiringDecision` — consumes all `Scorecard`s for the `Application`; produces a decision of `Advance to Offer` or `Reject` on the `Application`. Requires a complete panel per TA-POL-002 §R5 and §R6.
- **Trigger event:** `InterviewCompleted`.
- **Emitted event:** `HiringDecisionRecorded` → `OfferRequested` (on advance) or `ApplicationRejected`.

### P4 — Offer Approval (录用审批)

**Step 4.1 — Draft the Offer.**
- **Actor:** Recruiter.
- **Objects:** `Offer`, `Application`, `Requisition`, `SalaryBand`.
- **Action:** `DraftOffer` — consumes the `Application`, the `Requisition`, and the role's `SalaryBand`; produces an `Offer` record in `Draft` with base salary, bonus target, equity, and start date.
- **Trigger event:** `OfferRequested`.
- **Emitted event:** `OfferDrafted`.

**Step 4.2 — Validate the Offer against the SalaryBand.**
- **Actor:** Compensation Analyst; **System:** Workday + Greenhouse.
- **Objects:** `Offer`, `SalaryBand`, `Requisition`.
- **Action:** `ValidateOfferBand` — consumes the `Offer`'s proposed salary and the published `SalaryBand` for the role and location; produces an `inBand` / `aboveBand` determination on the `Offer`. An `Offer` is blocked if the `Requisition` is not `Approved` (TA-POL-002 §R1).
- **Trigger event:** `OfferDrafted`.
- **Emitted event:** `OfferValidated`.

**Step 4.3 — Route the Offer for approval.**
- **Actor:** Approval chain; **System:** Workday.
- **Objects:** `Offer`, `Approval`, `Requisition`.
- **Action:** `ApproveOffer` — consumes the validated `Offer`; produces an `Approval` record. In-band offers require Hiring Manager + HRBP approval; above-band offers additionally require VP approval recorded against the `Requisition` (TA-POL-002 §R2).
- **Trigger event:** `OfferValidated`.
- **Emitted event:** `OfferApproved` (or `OfferReturnedForRevision`).

### P5 — Offer to Onboarding (录用到入职)

**Step 5.1 — Extend the Offer to the Candidate.**
- **Actor:** Recruiter; **System:** DocuSign.
- **Objects:** `Offer`, `Candidate`.
- **Action:** `ExtendOffer` — consumes the `Approved` `Offer`; produces a DocuSign envelope sent to the `Candidate` and transitions the `Offer` to `Extended`.
- **Trigger event:** `OfferApproved`.
- **Emitted event:** `OfferExtended`.

**Step 5.2 — Candidate accepts or declines.**
- **Actor:** Candidate; **System:** DocuSign.
- **Objects:** `Offer`, `Candidate`.
- **Action:** `RecordOfferResponse` — consumes the DocuSign signature event; produces an `Offer` status of `Accepted` or `Declined`.
- **Trigger event:** `OfferExtended`.
- **Emitted event:** `OfferAccepted` (or `OfferDeclined`).
- **Reference:** Offer expiry window defined in TA-POL-002 §R9.

**Step 5.3 — Run the BackgroundCheck.**
- **Actor:** Recruiter; **System:** Checkr.
- **Objects:** `Candidate`, `BackgroundCheck`, `Offer`.
- **Action:** `InitiateBackgroundCheck` — consumes the accepted `Offer` and `Candidate` consent; produces a `BackgroundCheck` record with status `Clear` / `Consider` / `Suspended`.
- **Trigger event:** `OfferAccepted`.
- **Emitted event:** `BackgroundCheckCompleted`.
- **Reference:** Contingency rule defined in TA-POL-002 §R10.

**Step 5.4 — Convert to Hire and hand off to Onboarding.**
- **Actor:** Recruiter / HRBP; **System:** Workday.
- **Objects:** `Offer`, `Candidate`, `Position`, `Requisition`.
- **Action:** `ConvertToHire` — consumes the accepted `Offer` and `Clear` `BackgroundCheck`; produces a `Worker` record in Workday, closes the `Requisition` as `Filled`, and decrements the `Position` headcount.
- **Trigger event:** `BackgroundCheckCompleted`.
- **Emitted event:** `CandidateHired` → `RequisitionClosed`.

---

## 4. Exceptions and Escalations

- A `Requisition` that exceeds the funded `Position` budget is escalated to VP approval before P1 can complete (see TA-POL-002 §R4).
- An `Application` that has not cleared a complete `InterviewPanel` of at least three `Interviewer`s may not reach P4 (see TA-POL-002 §R5).
- An above-band `Offer` may not be `Extended` without VP approval against the `Requisition` (see TA-POL-002 §R2).
- A `BackgroundCheck` returning `Consider` suspends `ConvertToHire` pending adjudication (see TA-POL-002 §R10).

---

## 5. Process Summary (流程一览)

| Process | Entry event | Exit event | Key Objects |
|---|---|---|---|
| P1 Requisition Intake & Approval | `HiringNeedIdentified` | `JobPublished` | Requisition, Position, Approval |
| P2 Sourcing & Application | `JobPublished` | `ApplicationReceived` | Candidate, Application |
| P3 Screening to Offer | `ApplicationReceived` | `OfferRequested` | Application, InterviewStage, Scorecard, Assessment |
| P4 Offer Approval | `OfferRequested` | `OfferApproved` | Offer, SalaryBand, Approval |
| P5 Offer to Onboarding | `OfferApproved` | `RequisitionClosed` | Offer, BackgroundCheck, Candidate, Position |
