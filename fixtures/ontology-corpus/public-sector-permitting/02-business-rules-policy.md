# Business Rules & Policy — Permitting & Benefits Eligibility (Administrative Rules Chapter 7)

**Document ID:** POL-PBE-007
**Authority:** Administrative Rules Chapter 7 — Permitting & Benefits Administration
**Version:** 4.2 (effective 2026-01-01)
**Owning unit:** Office of Permitting & Benefits Administration (OPBA)
**Related documents:** `01-process-sop.md` (SOP-PBE-014), `03-systems-and-data.md`

---

## 1. Purpose

This policy states the explicit, atomic business **Rules** (规则) that govern the `Application`, `Document`, `EligibilityCriterion`, `Determination`, `Permit`, `Inspection`, `Payment`, `Appeal`, and `Case` Objects defined in the companion SOP. Each rule is written as a single extractable clause. Thresholds, time limits, eligibility tests, approval levels, and exceptions are stated in plain language.

## 2. Rules (规则)

**[BR-01]** An Application may not reach Determination until every required Document has been verified and is on file.

**[BR-02]** Each required Document must be verified by a Caseworker other than the Intake Clerk who logged it.

**[BR-03]** A Determination must be recorded within 30 business days of the ApplicationSubmitted event for benefit programs, and within 45 business days for permit applications.

**[BR-04]** The processing clock shall be suspended on the date an Application is set to ReturnedIncomplete and shall resume on the date the missing Document is received.

**[BR-05]** An Applicant whose Household income exceeds the published program threshold for their Household size is ineligible, and the resulting Determination must be Denied.

**[BR-06]** An Applicant is required to demonstrate residency within the jurisdiction by a Document dated no more than 90 days before the ApplicationSubmitted event.

**[BR-07]** A Caseworker may not record a Determination whose associated benefit value exceeds $25,000 annually or whose permit fee exceeds $5,000 without Supervisor approval.

**[BR-08]** A Denied Determination shall include the specific EligibilityCriterion and the rule citation that was the basis for denial.

**[BR-09]** A Permit may not be issued until its associated Payment has cleared in full, unless the Applicant qualifies for a documented fee waiver.

**[BR-10]** A Permit in an inspectable class is required to undergo a physical Inspection, and may not move to Active-Verified status until that Inspection is recorded as Passed.

**[BR-11]** An Appeal must be filed within 30 calendar days of the DeterminationNotified event, after which the Determination is final.

**[BR-12]** A benefit reduction or suspension shall be paused once an Appeal is filed and may not resume until the AppealDecided event.

**[BR-13]** An issued Permit shall carry an expiry date no later than 12 months after its issue date, unless the permit class is designated permanent in the Program Eligibility Manual.

**[BR-14]** A Permit whose Inspection is recorded as Failed must be re-inspected within 30 calendar days, after which an unresolved failure moves the Permit to Revoked.

**[BR-15]** A Determination must record the version of the EligibilityCriterion rule set that was in force on the determination date.

**[BR-16]** An Appeals Officer is required to issue the AppealDecided outcome within 45 calendar days of the AppealFiled event.

**[BR-17]** A benefit Case must be recertified at least every 12 months, and a Household may not continue receiving benefits past the recertification due date without a renewed Determination.

**[BR-18]** A Case whose recertification lapses beyond a 14-day grace period shall be suspended automatically, and the associated Permit, if any, shall move to Expired.

**[BR-19]** An Applicant may not hold more than one Active benefit Case for the same program at the same time.

**[BR-20]** An override of an automated ineligibility result requires a recorded Supervisor justification and may not be applied retroactively to prior Determinations.

## 3. Exceptions Register

- **Fee waiver (exception to [BR-09]):** granted only on a verified hardship Document and recorded against the Case.
- **Emergency intake (exception to [BR-01]):** a Determination may issue on an unverified Document set where the Applicant presents a qualifying emergency, subject to verification within 10 business days.
- **Permanent permit classes (exception to [BR-13]):** enumerated in the Program Eligibility Manual and exempt from the 12-month expiry.
