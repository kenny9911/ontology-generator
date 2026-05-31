# Commercial Lending — Credit & Covenant Business Rules
## Policy of Record (规则)

| | |
|---|---|
| **Document ID** | POL-CL-RULES-09 |
| **Version** | v11.0 (aligned to Commercial Credit Policy v11.pdf) |
| **Owner** | Chief Credit Officer |
| **Effective Date** | 2026-01-15 |
| **Classification** | Internal — Restricted |
| **Related Documents** | `01-process-sop.md`, `03-systems-and-data.md`, `Covenant Compliance Manual.docx`, `Loan Agreement.pdf` |

---

## Preamble

The following are explicit, atomic business **Rules** (规则) governing the origination, drawdown, monitoring, and risk management of commercial loan facilities. Each rule is stated as a single enforceable clause so that it is sentence-extractable. Object names (`Borrower`, `LoanFacility`, `Covenant`, `Collateral`, `RepaymentSchedule`, `RiskRating`, `Drawdown`, `CreditMemo`, `WaiverRequest`, `MarginCallNotice`) are used exactly as defined in the companion SOP and data documents. Each rule carries a source citation.

---

## Section A — Approval Authority & Eligibility

**R-01.** A `CreditMemo` recommending a new `LoanFacility` shall be approved by a Credit Officer when the committed amount is at or below USD 5,000,000; above this amount the `CreditMemo` must be escalated to the Credit Committee. — *Commercial Credit Policy v11.pdf §7.1*

**R-02.** A `LoanFacility` with a `Borrower` `RiskRating` weaker than 6 (on the 1–10 scale where 10 is highest risk) may not be approved by a single Credit Officer and is required to receive Credit Committee approval regardless of amount. — *Commercial Credit Policy v11.pdf §7.2*

**R-03.** Every `LoanFacility` must have at least one financial `Covenant` defined in its `CreditMemo` before it may be submitted for credit decision. — *Covenant Compliance Manual.docx §1.1*

**R-04.** A `LoanFacility` may not be funded until both the `FacilityBooked` event and the `SecurityPerfected` event have been recorded, confirming all conditions precedent are satisfied. — *Loan Servicing Procedures.pdf §3.4*

## Section B — Drawdown Controls

**R-05.** A `LoanFacility` may not be drawn down while any financial `Covenant` is in breach, unless a `WaiverRequest` with status `Granted` is on file for that `Covenant`. — *Covenant Compliance Manual.docx §2*

**R-06.** A `Drawdown` may not exceed the undrawn available commitment of its `LoanFacility`. — *Loan Servicing Procedures.pdf §4.2*

**R-17.** A `Drawdown` request that is not funded within 5 business days of being cleared is required to be re-validated against current `Covenant` states before disbursement. — *Loan Servicing Procedures.pdf §4.4*

## Section C — Risk Rating

**R-07.** A `Borrower` `RiskRating` must be refreshed at least every 12 months. — *Commercial Credit Policy v11.pdf §5.3*

**R-08.** A `Borrower` `RiskRating` is required to be refreshed within 30 days after any covenant breach, and where this 30-day deadline falls before the scheduled annual review it shall take precedence. — *Commercial Credit Policy v11.pdf §5.4*

**R-18.** A `RiskRating` of 9 or 10 must be reviewed by the Credit Committee and may not be assigned by a Credit Analyst acting alone. — *Commercial Credit Policy v11.pdf §5.6*

## Section D — Collateral & Loan-to-Value

**R-09.** A `LoanFacility`'s loan-to-value must stay at or below 80% of the pledged `Collateral` fair value; a breach triggers a `MarginCallNotice`. — *Loan Agreement.pdf §7.1*

**R-16.** A `Borrower` who receives a `MarginCallNotice` is required to cure the loan-to-value shortfall within 10 business days, after which the `LoanFacility` shall be classified as in default. — *Loan Agreement.pdf §7.3*

**R-19.** `Collateral` pledged against a `LoanFacility` must be re-appraised at least every 18 months, or within 30 days of a `MarginCallNotice`, whichever is sooner. — *Covenant Compliance Manual.docx §6.2*

## Section E — Covenant Testing & Breach Handling

**R-10.** A financial `Covenant` with a quarterly `test_frequency` must be tested within 45 calendar days of each fiscal quarter end. — *Covenant Compliance Manual.docx §3.1*

**R-11.** A debt-service-coverage `Covenant` is breached when the tested ratio falls below 1.25x. — *Covenant Compliance Manual.docx §3.3*

**R-12.** A leverage `Covenant` is breached when total funded debt to EBITDA exceeds 3.5x. — *Covenant Compliance Manual.docx §3.4*

**R-13.** A `CovenantBreached` event must be escalated to the Credit Committee within 2 business days of detection, with a citation to the breached covenant clause and the relevant `Loan Agreement` section. — *Covenant Compliance Manual.docx §4.1*

**R-14.** A `Borrower` with two or more covenant breaches within any rolling 12-month period shall be placed on the Watch List and may not receive new `LoanFacility` approvals until removed. — *Commercial Credit Policy v11.pdf §9.2*

## Section F — Waivers

**R-15.** A `WaiverRequest` covering a financial covenant breach may be granted only by the Credit Committee and is required to specify an expiry date no later than the next scheduled covenant test. — *Covenant Compliance Manual.docx §5.1*

**R-20.** A `WaiverRequest` may not be granted retroactively for a breach that has already triggered a `MarginCallNotice`. — *Covenant Compliance Manual.docx §5.3*
