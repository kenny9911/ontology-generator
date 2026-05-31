# Standard Operating Procedure — Claims & Underwriting Operations

**Document:** SOP-CLM-UW-014
**Business Unit:** P&C Insurance — Commercial Property Lines
**Owner:** VP, Claims & Underwriting Operations
**Version:** 6.2 (Effective 2026-01-15)
**Classification:** Internal — Operations
**Related documents:** `02-business-rules-policy.md` (Claims & Underwriting Business Rules v6.2), `03-systems-and-data.md` (Systems & Data Reference v6.2), `Policy Wording — Commercial Property.pdf`, `Claims Handling Manual.docx`, `Underwriting Guidelines.pdf`

---

## 1. Purpose and Scope

This Standard Operating Procedure (SOP) defines the end-to-end operating procedures for two core processes in our Commercial Property book:

- **Process A — Submission to Bind / 投保到承保** — the underwriting workflow from receipt of a broker submission through risk evaluation, quote, and binding of a **Policy**.
- **Process B — FNOL to Settlement / 报案到结案** — the claims workflow from First Notice of Loss (FNOL) through coverage verification, reserving, adjudication, and **ClaimPayment**.

Two supporting processes are also defined:

- **Process C — Reserve Review / 准备金复核** — the periodic re-evaluation of **Reserve** adequacy on every open **Exposure**.
- **Process D — Subrogation & Recovery / 代位求偿与追偿** — pursuit of third-party recovery after settlement.

This SOP names, for each step, the **Actor/system**, the business **Objects** (对象) touched, the system **Action** (动作) taken with what it consumes and produces, and the **Event(s)** (事件) that trigger or result from the step. The rules referenced as `[BR-nn]` are defined in `02-business-rules-policy.md`.

The systems of record referenced — **PolicyCenter** (policy administration), **ClaimCenter** (claims platform, Guidewire), **RatingEngine**, **BillingCenter**, and **DocVault** (document management) — are specified in `03-systems-and-data.md`.

---

## 2. Roles and Authority

| Role | Abbrev. | Primary system | Notes |
|------|---------|----------------|-------|
| Broker / Producer | BRK | PolicyCenter (portal) | External submitter |
| Underwriter | UW | PolicyCenter, RatingEngine | Binds Policy, sets terms |
| Underwriting Manager | UWM | PolicyCenter | Approves referrals |
| Claims Intake Agent | CIA | ClaimCenter | Records FNOL |
| Adjuster | ADJ | ClaimCenter | Manages Claim, Exposure, Reserve |
| Claims Supervisor | SUP | ClaimCenter | Approves above-authority payments |
| Claims Manager | CLM-MGR | ClaimCenter | Approves large-loss reserves |
| Subrogation Specialist | SUBRO | ClaimCenter | Pursues Recovery |

Authority limits (the **Adjuster** payment authority of **$25,000** per **ClaimPayment**, the **Supervisor** limit of **$100,000**, and the large-loss **Reserve** threshold of **$250,000**) are normative and defined in `02-business-rules-policy.md` rules `[BR-04]`, `[BR-05]`, and `[BR-11]`.

---

## 3. Process A — Submission to Bind / 投保到承保

### Step A1 — Receive submission
- **Actor/system:** Broker (BRK) via PolicyCenter Producer Portal.
- **Objects touched:** `Submission`, `Applicant`.
- **Action (`RecordSubmission`):** consumes the broker's application package (ACORD form + loss runs); produces a new `Submission` record in `Cleared` = false state and links it to an `Applicant`.
- **Events:** triggered by **SubmissionReceived**; emits **SubmissionCleared** once duplicate-clearance completes per `[BR-01]`.

### Step A2 — Risk evaluation and referral check
- **Actor/system:** Underwriter (UW) in PolicyCenter.
- **Objects touched:** `Submission`, `RiskAssessment`, `Coverage`.
- **Action (`AssessRisk`):** consumes the `Submission` plus loss-run history and property characteristics; produces a `RiskAssessment` with a risk score and proposed `Coverage` list. Submissions exceeding the eligibility thresholds in `[BR-02]` and `[BR-03]` are flagged for referral.
- **Events:** triggered by **SubmissionCleared**; emits **ReferralRaised** when a referral threshold is hit, otherwise **RiskAssessed**.

### Step A3 — Manager referral approval (conditional)
- **Actor/system:** Underwriting Manager (UWM) in PolicyCenter.
- **Objects touched:** `Submission`, `RiskAssessment`, `Approval`.
- **Action (`ApproveReferral`):** consumes the `RiskAssessment`; produces an `Approval` record (Approved / Declined) attached to the `Submission`. Required whenever **ReferralRaised** fired, per `[BR-03]`.
- **Events:** triggered by **ReferralRaised**; emits **ReferralApproved** or **SubmissionDeclined**.

### Step A4 — Rate and quote
- **Actor/system:** Underwriter (UW) → RatingEngine.
- **Objects touched:** `Submission`, `Coverage`, `Quote`, `Premium`.
- **Action (`GenerateQuote`):** consumes the approved `RiskAssessment` and `Coverage` selections; calls RatingEngine to compute `Premium`; produces a `Quote` with line-item premiums, deductibles, and limits. Premium must reflect the minimum-premium floor in `[BR-06]`.
- **Events:** triggered by **RiskAssessed** or **ReferralApproved**; emits **QuoteIssued**.

### Step A5 — Bind policy
- **Actor/system:** Underwriter (UW) in PolicyCenter; BillingCenter downstream.
- **Objects touched:** `Quote`, `Policy`, `Coverage`, `Premium`.
- **Action (`BindPolicy`):** consumes an accepted `Quote`; produces a `Policy` in `Bound` status with an effective date and expiry date, materializing each `Coverage` and the bound `Premium`. Binding is blocked if `[BR-07]` (effective date not in the past beyond the backdating window) is violated.
- **Events:** triggered by **QuoteAccepted**; emits **PolicyBound**, which BillingCenter consumes to raise the first invoice.

### Step A6 — Issue documents
- **Actor/system:** PolicyCenter → DocVault.
- **Objects touched:** `Policy`, `PolicyDocument`.
- **Action (`IssuePolicyDocuments`):** consumes the bound `Policy`; produces the declarations page and policy wording as a `PolicyDocument` stored in DocVault.
- **Events:** triggered by **PolicyBound**; emits **PolicyIssued**.

---

## 4. Process B — FNOL to Settlement / 报案到结案

### Step B1 — Record First Notice of Loss (FNOL)
- **Actor/system:** Claims Intake Agent (CIA) in ClaimCenter (phone, portal, or broker feed).
- **Objects touched:** `Claim`, `Policy`, `Exposure`.
- **Action (`RecordFNOL`):** consumes the reported loss details (date of loss, cause, claimant); produces a new `Claim` linked to the matched `Policy`, and opens at least one `Exposure` per affected `Coverage`.
- **Events:** triggered by **LossReported**; emits **FNOLRecorded** and **ExposureOpened** (one per Exposure).

### Step B2 — Verify coverage in force
- **Actor/system:** ClaimCenter (automated) with Adjuster (ADJ) review.
- **Objects touched:** `Claim`, `Policy`, `Coverage`.
- **Action (`VerifyCoverage`):** consumes the `Claim` date of loss and the linked `Policy` effective/expiry dates and `Coverage` terms; produces a coverage decision (`InForce` / `OutOfForce` / `NeedsReview`). Applies `[BR-08]`: no coverage if loss date precedes the Policy effective date or follows expiry.
- **Events:** triggered by **FNOLRecorded**; emits **CoverageConfirmed** or **CoverageDenied**.

### Step B3 — Assign adjuster
- **Actor/system:** ClaimCenter assignment engine.
- **Objects touched:** `Claim`, `Adjuster`, `Exposure`.
- **Action (`AssignAdjuster`):** consumes the `Claim` severity and line of business; produces an `Adjuster` assignment on the `Claim` and its open `Exposure`s. Severe losses route to senior adjusters per `[BR-12]`.
- **Events:** triggered by **CoverageConfirmed**; emits **ClaimAssigned**.

### Step B4 — Set initial reserve
- **Actor/system:** Adjuster (ADJ) in ClaimCenter.
- **Objects touched:** `Exposure`, `Reserve`, `Claim`.
- **Action (`SetReserve`):** consumes the Adjuster's loss estimate; produces a `Reserve` amount on each open `Exposure`. Must occur within **48 hours** of FNOL per `[BR-09]`; reserves at or above **$250,000** require Claims Manager approval per `[BR-11]`.
- **Events:** triggered by **ExposureOpened**; emits **ReserveSet**; emits **ReserveApprovalRequested** when the large-loss threshold is met.

### Step B5 — Investigate and adjust
- **Actor/system:** Adjuster (ADJ) in ClaimCenter; DocVault for evidence.
- **Objects touched:** `Claim`, `Exposure`, `Reserve`, `ClaimDocument`.
- **Action (`AdjustClaim`):** consumes investigation findings, estimates, and supporting `ClaimDocument`s; produces updated `Reserve` values and a recommended settlement amount per `Exposure`. Reserve changes are versioned for audit.
- **Events:** triggered by **ClaimAssigned**; emits **ReserveAdjusted** (on each change) and **SettlementRecommended**.

### Step B6 — Authorize and issue payment
- **Actor/system:** Adjuster (ADJ); Claims Supervisor (SUP) when above authority; BillingCenter/Treasury for disbursement.
- **Objects touched:** `ClaimPayment`, `Exposure`, `Reserve`, `Approval`.
- **Action (`IssueClaimPayment`):** consumes the approved settlement amount; produces a `ClaimPayment` and decrements the `Reserve` on the paying `Exposure`. A `ClaimPayment` above the Adjuster's **$25,000** authority requires a Supervisor `Approval` per `[BR-04]` and `[BR-05]`.
- **Events:** triggered by **SettlementRecommended**; emits **PaymentAuthorizationRequested** when above authority, then **PaymentIssued** once disbursed.

### Step B7 — Close exposure and claim
- **Actor/system:** Adjuster (ADJ) in ClaimCenter.
- **Objects touched:** `Exposure`, `Claim`, `Reserve`.
- **Action (`CloseExposure`):** consumes the fully-paid `Exposure`; produces a closed `Exposure` (Reserve zeroed). When all Exposures on a `Claim` are closed, the `Claim` is closed. Closure is blocked while any Reserve balance remains per `[BR-13]`.
- **Events:** triggered by **PaymentIssued**; emits **ExposureClosed** and, when the last one closes, **ClaimClosed**.

---

## 5. Process C — Reserve Review / 准备金复核

### Step C1 — Scheduled reserve adequacy review
- **Actor/system:** ClaimCenter (scheduler) + Adjuster (ADJ).
- **Objects touched:** `Exposure`, `Reserve`, `Claim`.
- **Action (`ReviewReserve`):** consumes the open `Exposure` and elapsed time; produces a confirmed or revised `Reserve`. Every open `Exposure` must be reviewed at least every **90 days** per `[BR-10]`.
- **Events:** triggered by **ReserveReviewDue**; emits **ReserveAdjusted** or **ReserveConfirmed**.

---

## 6. Process D — Subrogation & Recovery / 代位求偿与追偿

### Step D1 — Open subrogation
- **Actor/system:** Subrogation Specialist (SUBRO) in ClaimCenter.
- **Objects touched:** `Claim`, `Recovery`, `Exposure`.
- **Action (`OpenSubrogation`):** consumes a settled `Claim` with identified third-party liability; produces a `Recovery` record targeting the liable party.
- **Events:** triggered by **ClaimClosed** (with subrogation flag); emits **SubrogationOpened**.

### Step D2 — Record recovery receipt
- **Actor/system:** Subrogation Specialist (SUBRO); BillingCenter.
- **Objects touched:** `Recovery`, `Claim`.
- **Action (`RecordRecovery`):** consumes funds received from the liable party; produces an updated `Recovery` amount and offsets net incurred loss on the `Claim`.
- **Events:** triggered by **RecoveryReceived**; emits **RecoveryRecorded**.

---

## 7. Cross-References and Controls

- All authority and timing thresholds in this SOP are governed by `02-business-rules-policy.md`.
- All Objects, attributes, keys, and the events exchanged between PolicyCenter, ClaimCenter, RatingEngine, BillingCenter, and DocVault are defined in `03-systems-and-data.md`.
- Every state-changing Action writes an audit entry; reserve and payment changes are immutable once posted.

**End of SOP-CLM-UW-014.**
