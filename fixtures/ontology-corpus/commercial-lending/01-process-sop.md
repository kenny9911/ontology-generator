# Commercial Lending — Standard Operating Procedure
## Origination to Funding & Covenant Monitoring (受理到放款 / 季度契约监测)

| | |
|---|---|
| **Document ID** | SOP-CL-014 |
| **Version** | v7.2 |
| **Owner** | Commercial Credit & Risk Operations |
| **Effective Date** | 2026-01-15 |
| **Classification** | Internal — Restricted |
| **Supersedes** | SOP-CL-014 v7.1 |
| **Related Documents** | `Commercial Credit Policy v11.pdf`, `Covenant Compliance Manual.docx`, `Loan Servicing Procedures.pdf`, `02-business-rules-policy.md`, `03-systems-and-data.md` |

---

## 1. Purpose & Scope

This Standard Operating Procedure (SOP) defines the end-to-end handling of secured commercial loan facilities (商业信贷额度) from application intake through funding, ongoing servicing, and quarterly covenant monitoring. It applies to all term loans, revolving credit facilities, and committed lines originated through the **nCino Loan Origination System** and booked into the **Oracle FLEXCUBE core banking system**.

The product vocabulary used throughout this corpus is: business **Objects** (对象 — entities such as `Borrower`, `LoanFacility`), **Rules** (规则), **Actions** (动作 — the system operations a step performs), **Events** (事件 — triggers and results), and **Processes** (流程 — the named end-to-end flows).

Four named **Processes** are documented here:

- **P1 — Origination to Funding** (受理到放款): §3
- **P2 — Drawdown Servicing** (放款支用): §4
- **P3 — Quarterly Covenant Monitoring** (季度契约监测): §5
- **P4 — Risk Rating Review** (风险评级复核): §6

---

## 2. Systems & Roles Referenced

| System (system of record) | Role in this SOP |
|---|---|
| **nCino** (on Salesforce) | Loan pipeline, application capture, credit-memo workflow |
| **Sageworks Spreading** | Financial statement spreading, ratio analysis |
| **Oracle FLEXCUBE** | Core banking; books `LoanFacility`, `Drawdown`, `RepaymentSchedule` |
| **CovenantWatch** | Covenant test scheduling, breach detection |
| **iManage** | Document of record (loan agreements, waivers, memos) |

| Actor / Role | Responsibility |
|---|---|
| Relationship Manager (RM) | Front-office origination, borrower contact |
| Credit Analyst | Spreading, risk rating, credit memo authoring |
| Credit Officer | First-line approval within delegated authority |
| Credit Committee | Approval above delegated authority |
| Loan Operations (Loan Ops) | Booking, disbursement, servicing |
| Covenant Monitoring Analyst | Quarterly testing, breach escalation |

---

## 3. Process P1 — Origination to Funding (受理到放款)

### Step 3.1 — Capture Application
- **Actor / System:** Relationship Manager via **nCino**.
- **Objects touched:** creates `Borrower`, creates `LoanFacility` (status `Applied`).
- **Action:** `CaptureApplication` — consumes the borrower's signed application package; produces a new `LoanFacility` record linked to the `Borrower`.
- **Events:** triggered by `ApplicationSubmitted`; emits `FacilityCreated`.
- **Reference:** Commercial Credit Policy v11.pdf §1.

### Step 3.2 — Spread Financials & Compute Ratios
- **Actor / System:** Credit Analyst via **Sageworks Spreading**.
- **Objects touched:** reads `Borrower` financial statements; produces a `RiskRating` candidate value and the leverage / debt-service-coverage ratios on the `LoanFacility`.
- **Action:** `SpreadFinancials` — consumes the borrower's last three fiscal years of statements; produces computed ratios written back to nCino and an initial `RiskRating`.
- **Events:** triggered by `FacilityCreated`; emits `FinancialsSpread`.
- **Reference:** Commercial Credit Policy v11.pdf §4.2.

### Step 3.3 — Assign Risk Rating
- **Actor / System:** Credit Analyst via **nCino**, scored by the rating model.
- **Objects touched:** creates `RiskRating` (scale 1–10) attached to the `Borrower`.
- **Action:** `AssignRiskRating` — consumes the spread ratios and qualitative factors; produces a `RiskRating` with a `next_review_date`.
- **Events:** triggered by `FinancialsSpread`; emits `RiskRatingAssigned`.
- **Reference:** Commercial Credit Policy v11.pdf §5; see Rule R-07.

### Step 3.4 — Identify & Value Collateral
- **Actor / System:** Credit Analyst with external appraiser; recorded in **nCino**.
- **Objects touched:** creates one or more `Collateral` records linked to the `LoanFacility`; computes loan-to-value (LTV).
- **Action:** `ValueCollateral` — consumes the appraisal report; produces `Collateral.fair_value` and the facility LTV.
- **Events:** emits `CollateralValued`.
- **Reference:** Loan Agreement.pdf §6 (security); see Rule R-09.

### Step 3.5 — Author Credit Memo & Define Covenants
- **Actor / System:** Credit Analyst via **nCino**; memo stored in **iManage**.
- **Objects touched:** creates `CreditMemo`; creates one or more `Covenant` records (e.g., DSCR ≥ 1.25x, max leverage ≤ 3.5x) bound to the `LoanFacility`.
- **Action:** `DraftCreditMemo` — consumes the `RiskRating`, `Collateral`, and proposed structure; produces a `CreditMemo` with attached `Covenant` definitions and recommended terms.
- **Events:** triggered by `RiskRatingAssigned`; emits `CreditMemoSubmitted`.
- **Reference:** Covenant Compliance Manual.docx §1; see Rules R-03, R-12.

### Step 3.6 — Credit Decision (Approve / Decline)
- **Actor / System:** Credit Officer or Credit Committee via **nCino** approval workflow.
- **Objects touched:** updates `CreditMemo.decision`; on approval sets `LoanFacility.status = Approved`.
- **Action:** `RenderCreditDecision` — consumes the `CreditMemo`; produces an approval record at the correct authority level (see Rules R-01, R-02).
- **Events:** triggered by `CreditMemoSubmitted`; emits `FacilityApproved` or `FacilityDeclined`.
- **Reference:** Commercial Credit Policy v11.pdf §7 (delegated authority).

### Step 3.7 — Book Facility & Generate Repayment Schedule
- **Actor / System:** Loan Operations via **Oracle FLEXCUBE** (synced from nCino).
- **Objects touched:** creates the canonical `LoanFacility` in FLEXCUBE; generates the `RepaymentSchedule`.
- **Action:** `BookFacility` — consumes the approved terms from the `CreditMemo`; produces a booked `LoanFacility` (status `Active`) and an amortizing `RepaymentSchedule`.
- **Events:** triggered by `FacilityApproved`; emits `FacilityBooked`.
- **Reference:** Loan Servicing Procedures.pdf §2.

### Step 3.8 — Perfect Security & Confirm Conditions Precedent
- **Actor / System:** Loan Operations with Legal; recorded in **iManage** and **FLEXCUBE**.
- **Objects touched:** updates `Collateral.perfection_status`; updates `LoanFacility.conditions_met`.
- **Action:** `PerfectSecurity` — consumes the executed security agreements; produces perfected `Collateral` and a satisfied conditions-precedent checklist.
- **Events:** emits `SecurityPerfected`. This event, together with `FacilityBooked`, is the precondition for funding (see Rule R-04).
- **Reference:** Loan Agreement.pdf §6; Loan Servicing Procedures.pdf §3.

---

## 4. Process P2 — Drawdown Servicing (放款支用)

### Step 4.1 — Receive Drawdown Request
- **Actor / System:** Borrower → Relationship Manager → **nCino**.
- **Objects touched:** creates `Drawdown` (status `Requested`) against an `Active` `LoanFacility`.
- **Action:** `RequestDrawdown` — consumes the borrower drawdown notice; produces a `Drawdown` record.
- **Events:** triggered by `DrawdownRequested`.
- **Reference:** Loan Servicing Procedures.pdf §4.

### Step 4.2 — Pre-Disbursement Covenant & Limit Check
- **Actor / System:** **CovenantWatch** automated check, surfaced in Loan Ops queue.
- **Objects touched:** reads all `Covenant` records and current LTV for the `LoanFacility`; reads any active `WaiverRequest`.
- **Action:** `CheckDrawdownEligibility` — consumes the `Drawdown` request, the live `Covenant` states, the available undrawn commitment, and any `WaiverRequest`; produces an eligibility verdict (`Pass`/`Block`).
- **Events:** triggered by `DrawdownRequested`; emits `DrawdownCleared` or `DrawdownBlocked`. A `DrawdownBlocked` event is raised whenever any financial covenant is in breach and no waiver is on file (see Rule R-05).
- **Reference:** Covenant Compliance Manual.docx §2; see Rules R-05, R-06.

### Step 4.3 — Disburse Funds & Update Outstanding
- **Actor / System:** Loan Operations via **Oracle FLEXCUBE**.
- **Objects touched:** updates `Drawdown.status = Funded`; increments `LoanFacility.outstanding_principal`; adjusts the `RepaymentSchedule`.
- **Action:** `DisburseFunds` — consumes the cleared `Drawdown`; produces a funds transfer and an updated outstanding balance.
- **Events:** triggered by `DrawdownCleared`; emits `FundsDisbursed`.
- **Reference:** Loan Servicing Procedures.pdf §4.3.

---

## 5. Process P3 — Quarterly Covenant Monitoring (季度契约监测)

### Step 5.1 — Schedule Covenant Test
- **Actor / System:** **CovenantWatch** scheduler.
- **Objects touched:** reads `Covenant` records with a quarterly `test_frequency`.
- **Action:** `ScheduleCovenantTest` — consumes the covenant calendar; produces a pending covenant test per facility per quarter.
- **Events:** emits `CovenantTestDue` at the start of each reporting period.
- **Reference:** Covenant Compliance Manual.docx §3; see Rule R-10.

### Step 5.2 — Collect & Spread Compliance Financials
- **Actor / System:** Covenant Monitoring Analyst via **Sageworks Spreading**.
- **Objects touched:** reads the borrower's quarterly financials; recomputes the covenant test metrics (DSCR, leverage, LTV).
- **Action:** `EvaluateCovenant` — consumes the latest financials and the `Covenant` thresholds; produces a `Covenant.test_result` (`Compliant` / `Breached`).
- **Events:** triggered by `CovenantTestDue`; emits `CovenantTested`. If a threshold is violated, also emits `CovenantBreached`.
- **Reference:** Covenant Compliance Manual.docx §3.2; see Rules R-11, R-13.

### Step 5.3 — Raise Breach & Notify Credit Committee
- **Actor / System:** **CovenantWatch** → Covenant Monitoring Analyst → Credit Committee.
- **Objects touched:** creates a breach record on the `Covenant`; may create a `WaiverRequest`.
- **Action:** `EscalateBreach` — consumes the `CovenantBreached` event; produces a committee notification citing the exact covenant clause and loan-agreement section.
- **Events:** triggered by `CovenantBreached`; emits `BreachEscalated`. A breach also schedules an out-of-cycle risk review (see Rule R-08).
- **Reference:** Covenant Compliance Manual.docx §4; see Rules R-13, R-14.

### Step 5.4 — Process Waiver Decision
- **Actor / System:** Credit Officer / Credit Committee via **nCino**; waiver filed in **iManage**.
- **Objects touched:** updates `WaiverRequest.status`; if granted, links the waiver to the breached `Covenant`.
- **Action:** `DecideWaiver` — consumes the `WaiverRequest`; produces a `Granted` or `Denied` decision recorded against the facility.
- **Events:** triggered by `BreachEscalated`; emits `WaiverGranted` or `WaiverDenied`. A granted waiver re-enables drawdowns blocked under Rule R-05.
- **Reference:** Covenant Compliance Manual.docx §5; see Rule R-15.

### Step 5.5 — Issue Margin Call (LTV Breach)
- **Actor / System:** Loan Operations on instruction from Credit; recorded in **FLEXCUBE** and **iManage**.
- **Objects touched:** creates a `MarginCallNotice` linked to the `LoanFacility` and the under-valued `Collateral`.
- **Action:** `IssueMarginCall` — consumes the LTV breach result; produces a `MarginCallNotice` with a cure deadline.
- **Events:** triggered by the LTV-specific `CovenantBreached`; emits `MarginCallIssued`.
- **Reference:** Loan Agreement.pdf §7; see Rules R-09, R-16.

---

## 6. Process P4 — Risk Rating Review (风险评级复核)

### Step 6.1 — Trigger Rating Review
- **Actor / System:** **nCino** scheduler, or event-driven from a breach.
- **Objects touched:** reads `RiskRating.next_review_date`; reads recent `CovenantBreached` events.
- **Action:** `TriggerRatingReview` — consumes the rating calendar and breach events; produces a pending review task for the Credit Analyst.
- **Events:** emits `RatingReviewDue`. A review is due at least every 12 months, or within 30 days of any covenant breach, whichever is sooner (see Rules R-07, R-08).
- **Reference:** Commercial Credit Policy v11.pdf §5.4.

### Step 6.2 — Refresh & Re-Assign Rating
- **Actor / System:** Credit Analyst via **nCino** + **Sageworks**.
- **Objects touched:** updates `RiskRating.value` and `next_review_date` on the `Borrower`.
- **Action:** `RefreshRiskRating` — consumes the latest financials and breach history; produces an updated `RiskRating`.
- **Events:** triggered by `RatingReviewDue`; emits `RiskRatingAssigned` (new version).
- **Reference:** Commercial Credit Policy v11.pdf §5.

---

## 7. Cross-References

- All explicit, atomic business rules invoked above (R-01 … R-16) are defined in **`02-business-rules-policy.md`**.
- All systems of record, data entities/attributes, integrations, and inter-system events are defined in **`03-systems-and-data.md`**.
- Every Object, Action, and Event name in this SOP is used verbatim in the companion documents to allow cross-document linking by the ontology-extraction pipeline.
