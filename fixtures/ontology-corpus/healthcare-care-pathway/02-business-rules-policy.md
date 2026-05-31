# Business Rules & Policy — Care Pathway & Revenue Cycle (规则)

**Document ID:** POL-RCM-014
**Version:** 4.2
**Effective Date:** 2026-01-01
**Owner:** Revenue Cycle Governance Committee, Mercy Lakeside Health System
**Authority Source:** CMS Conditions of Participation, payer contracts, internal compliance policy.
**Companion documents:** `01-process-sop.md`, `03-systems-and-data.md`.

---

## 1. Scope

This document states the explicit, atomic business rules that govern the clinical and revenue-cycle
processes. Each rule is written as a single enforceable clause. Rules use the keywords **must**,
**shall**, **may not**, **is required to**, and **may** with their conventional compliance meaning.
Every rule references the Objects it constrains so the model can link rule → entity. Exceptions are
stated inline with the word *unless* or *except*.

---

## 2. Identity & Coverage Rules (患者与保险)

**R-01.** Every Encounter must resolve to exactly one Patient identified by a single active MRN.

**R-02.** A Patient's Coverage must be verified as active before any non-emergency Procedure is
performed, unless the Encounter is flagged Emergency.

**R-03.** A Claim shall be submitted within 90 calendar days of the Encounter discharge date for
commercial payers, and within 365 calendar days for Medicare, except where a payer contract sets a
shorter timely-filing limit.

---

## 3. Prior Authorization Rules (事前授权)

**R-04.** A high-cost imaging Procedure with a billed amount of $1,500 or more must have an approved
PriorAuthorization before scheduling, unless the Encounter is flagged Emergency.

**R-05.** A Claim may not be submitted for a Procedure that required PriorAuthorization unless an
approved PriorAuthorization is linked to the Encounter.

**R-06.** A UM Coordinator is required to submit an urgent PriorAuthorization request to the payer
within 24 hours of the Order being placed.

**R-07.** A PriorAuthorization is valid only for the approved units within its approval window, and
the date of service must fall on or before the PriorAuthorization expiration date.

---

## 4. Clinical Pathway Rules (临床路径)

**R-08.** A sepsis bundle must record a lactate result within 3 hours of the triage timestamp.

**R-09.** Every billable Procedure on an Encounter is required to link to at least one documented
Diagnosis with a supporting ICD-10-CM code.

**R-10.** An Encounter must be coding-complete within 4 calendar days of its discharge date, except
for Encounters held for clinical query, which may extend to 10 calendar days.

---

## 5. Charge & Coding Rules (计费与编码)

**R-11.** Every Charge must map to an active line in the Charge Description Master on the date of
service.

**R-12.** A late Charge may not be added to an Encounter more than 7 calendar days after the
discharge date without supervisor approval.

**R-13.** A Procedure with a Diagnosis pairing that fails the applicable medical-necessity policy
(LCD/NCD) may not be billed to the payer and must be flagged for review.

**R-14.** Two Procedures that violate an NCCI Procedure-to-Procedure edit may not be billed on the
same Claim unless a valid modifier is documented.

---

## 6. Claim Submission & Integrity Rules (理赔提交)

**R-15.** A Claim must pass all scrubber edits and reach status Ready before it may be submitted to a
payer.

**R-16.** A Claim that has already been accepted by the payer may not be resubmitted as an original;
corrections shall be submitted only as a replacement Claim with frequency code 7.

**R-17.** A Denial must be routed to a Denials Analyst work queue within 2 business days of the
remittance posting date.

---

## 7. Denial, Appeal & Write-off Rules (拒付与申诉)

**R-18.** An appeal for a denied Claim shall be submitted within the payer's appeal deadline, which
may not exceed 60 calendar days from the Denial date unless the payer contract grants a longer window.

**R-19.** A write-off of a denied balance of $5,000 or more is required to have Director-level
approval, and a write-off of $25,000 or more is required to have CFO approval.

**R-20.** A Patient may not be balance-billed for any amount denied as a provider coding or
authorization error.

---

## 8. Exceptions Register

| Rule | Exception Condition | Authorized By |
|------|--------------------|---------------|
| R-02, R-04 | `Encounter.emergencyFlag = true` (EMTALA) | System (automatic) |
| R-03 | Payer-contracted shorter filing limit | Billing Manager |
| R-10 | Clinical-query hold | Coding Lead |
| R-12 | Late charge beyond 7 days | Charge Integrity Supervisor |
| R-18 | Payer-granted extended appeal window | Denials Lead |
| R-19 | Write-off ≥ $5,000 / ≥ $25,000 | Director / CFO |

---

## 9. Revision History

| Version | Date | Change |
|---------|------|--------|
| 4.1 | 2025-10-15 | Added sepsis lactate rule (R-08). |
| 4.2 | 2026-01-01 | Added denial/appeal rules R-17 through R-20; raised imaging auth threshold to $1,500. |
