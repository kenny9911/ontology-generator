# Claims & Underwriting Business Rules / 理赔与核保业务规则

**Document:** POL-CLM-UW-RULES-062
**Business Unit:** P&C Insurance — Commercial Property Lines
**Owner:** VP, Claims & Underwriting Operations
**Version:** 6.2 (Effective 2026-01-15)
**Classification:** Internal — Governance
**Authority:** This document is the normative source for all thresholds, time limits, eligibility criteria, and approval levels referenced by `01-process-sop.md` and implemented across the systems in `03-systems-and-data.md`.

---

## 1. Conventions

Each rule below is **atomic** and **stated as a single enforceable clause** so it can be extracted sentence-by-sentence. Rules use the modal verbs **must**, **shall**, **may not**, and **is required to**. Object names (`Submission`, `Policy`, `Coverage`, `Claim`, `Exposure`, `Reserve`, `ClaimPayment`, `Adjuster`, `Recovery`, `Quote`) are consistent with the SOP and the data reference.

---

## 2. Underwriting Rules / 核保规则

**[BR-01]** Every `Submission` shall be cleared against existing `Policy` and `Submission` records for the same `Applicant` within **2 business days** of receipt, and a duplicate submission may not proceed to risk assessment.

**[BR-02]** A `Submission` for a single insured location with a Total Insured Value exceeding **$50,000,000** may not be quoted without a documented facultative reinsurance arrangement on file.

**[BR-03]** A `Submission` whose property is located in a Tier-1 catastrophe-exposed zone, or whose proposed limit exceeds **$10,000,000**, is required to be referred to an Underwriting Manager for approval before a `Quote` is issued.

**[BR-06]** A bound `Policy` must carry an annual `Premium` of at least the minimum-premium floor of **$2,500**, regardless of computed rate.

**[BR-07]** A `Policy` may not be bound with an effective date more than **30 days** in the past, and may not be bound with an effective date in the future beyond **90 days**.

**[BR-14]** A `Quote` is valid for **60 days** from issuance, and a `Quote` that has expired may not be bound without re-rating.

**[BR-15]** A `Coverage` deductible may not be set below the underwriting-guideline minimum of **$5,000** for any commercial property peril.

**[BR-16]** An `Applicant` with two or more total-loss claims in the prior **36 months** shall be declined unless an Underwriting Manager records a written exception.

---

## 3. Claims Handling Rules / 理赔处理规则

**[BR-08]** No `Coverage` applies to a loss whose date of loss precedes the `Policy` effective date or follows the `Policy` expiry date.

**[BR-09]** A `Reserve` must be set within **48 hours** of First Notice of Loss on every open `Exposure`.

**[BR-10]** Every open `Exposure` is required to have its `Reserve` reviewed for adequacy at least every **90 days**.

**[BR-04]** A `ClaimPayment` may not exceed the assigned `Adjuster`'s authority limit of **$25,000** per payment.

**[BR-05]** A `ClaimPayment` above the `Adjuster` authority limit must be approved by a Claims Supervisor, and a `ClaimPayment` above the Supervisor limit of **$100,000** shall be escalated to the Claims Manager.

**[BR-11]** A `Reserve` set at or above **$250,000** on any single `Exposure` is required to receive Claims Manager approval before it is posted.

**[BR-12]** A `Claim` with an estimated total incurred loss at or above **$500,000** must be assigned to a senior `Adjuster` within **24 hours** of coverage confirmation.

**[BR-13]** An `Exposure` may not be closed while any `Reserve` balance remains greater than zero on that `Exposure`.

**[BR-17]** A `ClaimPayment` may not be issued on an `Exposure` whose coverage decision is `OutOfForce` or `CoverageDenied`.

**[BR-18]** A `Claim` that has had no adjuster activity for **30 consecutive days** must be flagged as stale and routed to the Claims Supervisor for review.

---

## 4. Recovery and Audit Rules / 追偿与审计规则

**[BR-19]** A `Recovery` may only be opened on a `Claim` that is closed and carries an identified liable third party.

**[BR-20]** Every `ClaimPayment` and every `Reserve` change shall be recorded with the acting user, timestamp, and prior value, and such audit records may not be altered or deleted.

---

**End of POL-CLM-UW-RULES-062.**
