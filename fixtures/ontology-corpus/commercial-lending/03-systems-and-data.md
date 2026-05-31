# Commercial Lending — Systems of Record & Data Model
## System Landscape, Data Entities, Integrations & Events

| | |
|---|---|
| **Document ID** | ARC-CL-DATA-05 |
| **Version** | v3.4 |
| **Owner** | Enterprise Data Architecture — Lending Domain |
| **Effective Date** | 2026-01-15 |
| **Classification** | Internal — Restricted |
| **Related Documents** | `01-process-sop.md`, `02-business-rules-policy.md` |

---

## 1. Systems of Record

| System | Vendor / Platform | System of record for | Primary keys it issues |
|---|---|---|---|
| **nCino** | Salesforce | `LoanFacility` pipeline, `CreditMemo`, `WaiverRequest`, application workflow | `facility_id`, `memo_id` |
| **Sageworks Spreading** | Abrigo | Spread financials, computed ratios, `RiskRating` candidate scores | `spread_id` |
| **Oracle FLEXCUBE** | Oracle | Booked `LoanFacility`, `Drawdown`, `RepaymentSchedule`, `Collateral` register, `Borrower` party | `borrower_id`, `flexcube_facility_no`, `drawdown_id` |
| **CovenantWatch** | In-house | `Covenant` definitions, test schedule, breach detection | `covenant_id`, `test_id` |
| **iManage** | iManage | `Loan Agreement` documents, executed waivers, signed credit memos | `doc_id` |

> **Identity reconciliation:** `Borrower` is mastered in **Oracle FLEXCUBE** (`borrower_id`); nCino references it by `borrower_id` as a foreign key. A `LoanFacility` is created in nCino (`facility_id`) and, upon `FacilityApproved`, mirrored into FLEXCUBE (`flexcube_facility_no`), with `facility_id` retained as the cross-system correlation key.

---

## 2. Core Data Entities & Attributes (对象)

### 2.1 `Borrower` — *system of record: Oracle FLEXCUBE*
| Attribute | Type | Notes |
|---|---|---|
| `borrower_id` | UUID | **Primary key** |
| `legal_name` | string | |
| `tax_id` | string | Unique business identifier |
| `industry_code` | enum (NAICS) | |
| `watch_list_flag` | boolean | Set by Rule R-14 |
| `risk_rating_id` | UUID | **FK → `RiskRating`** |

### 2.2 `LoanFacility` — *system of record: nCino (pipeline) → Oracle FLEXCUBE (booked)*
| Attribute | Type | Notes |
|---|---|---|
| `facility_id` | UUID | **Primary key** (cross-system correlation key) |
| `flexcube_facility_no` | string | FLEXCUBE booked identifier |
| `borrower_id` | UUID | **FK → `Borrower`** |
| `facility_type` | enum {`Term`, `Revolver`, `CommittedLine`} | |
| `committed_amount` | decimal(18,2) | Drives Rule R-01 |
| `outstanding_principal` | decimal(18,2) | Updated by `DisburseFunds` |
| `status` | enum {`Applied`, `Approved`, `Active`, `Default`, `Closed`} | |
| `ltv` | decimal(5,4) | Loan-to-value; Rule R-09 |
| `conditions_met` | boolean | Rule R-04 |

### 2.3 `Covenant` — *system of record: CovenantWatch*
| Attribute | Type | Notes |
|---|---|---|
| `covenant_id` | UUID | **Primary key** |
| `facility_id` | UUID | **FK → `LoanFacility`** |
| `covenant_type` | enum {`DSCR`, `Leverage`, `LTV`, `MinLiquidity`} | |
| `threshold_value` | decimal | e.g., 1.25 (DSCR), 3.5 (Leverage) |
| `test_frequency` | enum {`Quarterly`, `Annual`} | Rule R-10 |
| `test_result` | enum {`Compliant`, `Breached`, `NotYetTested`} | |
| `clause_reference` | string | Loan-agreement section, e.g., "§5.3(b)" |

### 2.4 `Collateral` — *system of record: Oracle FLEXCUBE*
| Attribute | Type | Notes |
|---|---|---|
| `collateral_id` | UUID | **Primary key** |
| `facility_id` | UUID | **FK → `LoanFacility`** |
| `collateral_type` | enum {`RealEstate`, `Equipment`, `Receivables`, `Securities`} | |
| `fair_value` | decimal(18,2) | Drives LTV; Rule R-09 |
| `appraisal_date` | date | Rule R-19 |
| `perfection_status` | enum {`Unperfected`, `Perfected`} | Rule R-04 |

### 2.5 `RepaymentSchedule` — *system of record: Oracle FLEXCUBE*
| Attribute | Type | Notes |
|---|---|---|
| `schedule_id` | UUID | **Primary key** |
| `facility_id` | UUID | **FK → `LoanFacility`** |
| `installment_seq` | integer | |
| `due_date` | date | |
| `principal_due` | decimal(18,2) | |
| `interest_due` | decimal(18,2) | |

### 2.6 `RiskRating` — *system of record: nCino (assigned), Sageworks (scored)*
| Attribute | Type | Notes |
|---|---|---|
| `risk_rating_id` | UUID | **Primary key** |
| `borrower_id` | UUID | **FK → `Borrower`** |
| `value` | integer (1–10) | 10 = highest risk |
| `assigned_date` | date | |
| `next_review_date` | date | Rules R-07, R-08 |
| `version` | integer | Incremented by `RefreshRiskRating` |

### 2.7 `Drawdown` — *system of record: Oracle FLEXCUBE*
| Attribute | Type | Notes |
|---|---|---|
| `drawdown_id` | UUID | **Primary key** |
| `facility_id` | UUID | **FK → `LoanFacility`** |
| `amount` | decimal(18,2) | Rule R-06 |
| `request_date` | date | |
| `status` | enum {`Requested`, `Cleared`, `Funded`, `Blocked`} | |

### 2.8 `CreditMemo` — *system of record: nCino; document in iManage*
| Attribute | Type | Notes |
|---|---|---|
| `memo_id` | UUID | **Primary key** |
| `facility_id` | UUID | **FK → `LoanFacility`** |
| `recommended_terms` | text | |
| `decision` | enum {`Pending`, `Approved`, `Declined`} | |
| `approval_level` | enum {`CreditOfficer`, `CreditCommittee`} | Rules R-01, R-02 |
| `doc_id` | string | **FK → iManage document** |

### 2.9 `WaiverRequest` — *system of record: nCino; document in iManage*
| Attribute | Type | Notes |
|---|---|---|
| `waiver_id` | UUID | **Primary key** |
| `covenant_id` | UUID | **FK → `Covenant`** |
| `status` | enum {`Requested`, `Granted`, `Denied`} | Rule R-05 |
| `expiry_date` | date | Rule R-15 |

### 2.10 `MarginCallNotice` — *system of record: Oracle FLEXCUBE; document in iManage*
| Attribute | Type | Notes |
|---|---|---|
| `margin_call_id` | UUID | **Primary key** |
| `facility_id` | UUID | **FK → `LoanFacility`** |
| `collateral_id` | UUID | **FK → `Collateral`** |
| `shortfall_amount` | decimal(18,2) | |
| `cure_deadline` | date | Rule R-16 (10 business days) |

---

## 3. System Integrations

| # | Source → Target | Mechanism | Payload (Objects) |
|---|---|---|---|
| I1 | nCino → Oracle FLEXCUBE | REST API on `FacilityApproved` | `LoanFacility`, approved terms from `CreditMemo` |
| I2 | Sageworks → nCino | Nightly batch + on-demand | spread ratios, `RiskRating` candidate |
| I3 | Oracle FLEXCUBE → CovenantWatch | CDC stream (change-data-capture) | `LoanFacility`, `Drawdown`, `Collateral`, `RepaymentSchedule` |
| I4 | CovenantWatch → nCino | Webhook on breach | `CovenantBreached`, `Covenant` |
| I5 | nCino / FLEXCUBE → iManage | Document push | `CreditMemo`, `WaiverRequest`, `MarginCallNotice` PDFs |

---

## 4. Events Exchanged Between Systems (事件)

| Event | Emitting system | Consuming system(s) | Payload Object | Linked Action (动作) |
|---|---|---|---|---|
| `ApplicationSubmitted` | Borrower portal → nCino | nCino | `Borrower` application | `CaptureApplication` |
| `FacilityCreated` | nCino | Sageworks | `LoanFacility` | `SpreadFinancials` |
| `FinancialsSpread` | Sageworks | nCino | spread ratios | `AssignRiskRating` |
| `RiskRatingAssigned` | nCino | nCino, CovenantWatch | `RiskRating` | `DraftCreditMemo` |
| `CollateralValued` | nCino | FLEXCUBE | `Collateral` | `ValueCollateral` |
| `CreditMemoSubmitted` | nCino | nCino (approval) | `CreditMemo` | `RenderCreditDecision` |
| `FacilityApproved` | nCino | Oracle FLEXCUBE | `LoanFacility`, `CreditMemo` | `BookFacility` |
| `FacilityDeclined` | nCino | nCino | `CreditMemo` | — |
| `FacilityBooked` | Oracle FLEXCUBE | CovenantWatch, Loan Ops | `LoanFacility`, `RepaymentSchedule` | `PerfectSecurity` |
| `SecurityPerfected` | Loan Ops → FLEXCUBE | FLEXCUBE | `Collateral` | (enables funding, Rule R-04) |
| `DrawdownRequested` | nCino | CovenantWatch | `Drawdown` | `CheckDrawdownEligibility` |
| `DrawdownCleared` | CovenantWatch | Oracle FLEXCUBE | `Drawdown` | `DisburseFunds` |
| `DrawdownBlocked` | CovenantWatch | nCino, Loan Ops | `Drawdown` | (Rule R-05) |
| `FundsDisbursed` | Oracle FLEXCUBE | nCino, GL | `Drawdown`, `LoanFacility` | — |
| `CovenantTestDue` | CovenantWatch | Sageworks, Analyst | `Covenant` | `EvaluateCovenant` |
| `CovenantTested` | CovenantWatch | nCino | `Covenant` | — |
| `CovenantBreached` | CovenantWatch | nCino, Credit Committee | `Covenant` | `EscalateBreach`, `IssueMarginCall` |
| `BreachEscalated` | CovenantWatch | Credit Committee | `Covenant`, `WaiverRequest` | `DecideWaiver` |
| `WaiverGranted` | nCino | CovenantWatch, FLEXCUBE | `WaiverRequest` | (re-enables drawdown) |
| `WaiverDenied` | nCino | nCino | `WaiverRequest` | — |
| `MarginCallIssued` | Oracle FLEXCUBE | Borrower portal, iManage | `MarginCallNotice` | (Rule R-16) |
| `RatingReviewDue` | nCino | Analyst | `RiskRating` | `RefreshRiskRating` |

---

## 5. Notes for the Ontology Pipeline

- **Object catalogue (10):** `Borrower`, `LoanFacility`, `Covenant`, `Collateral`, `RepaymentSchedule`, `RiskRating`, `Drawdown`, `CreditMemo`, `WaiverRequest`, `MarginCallNotice`.
- **Action catalogue (动作):** `CaptureApplication`, `SpreadFinancials`, `AssignRiskRating`, `ValueCollateral`, `DraftCreditMemo`, `RenderCreditDecision`, `BookFacility`, `PerfectSecurity`, `RequestDrawdown`, `CheckDrawdownEligibility`, `DisburseFunds`, `ScheduleCovenantTest`, `EvaluateCovenant`, `EscalateBreach`, `DecideWaiver`, `IssueMarginCall`, `TriggerRatingReview`, `RefreshRiskRating`.
- **Process catalogue (流程):** P1 Origination to Funding, P2 Drawdown Servicing, P3 Quarterly Covenant Monitoring, P4 Risk Rating Review.
- Every Object, Action, Event, and Rule identifier here is consistent with `01-process-sop.md` and `02-business-rules-policy.md` to permit cross-document graph linking.
