# Systems & Data Reference / 系统与数据参考

**Document:** ARC-CLM-UW-DATA-062
**Business Unit:** P&C Insurance — Commercial Property Lines
**Owner:** Enterprise Architecture, Claims & Underwriting Platforms
**Version:** 6.2 (Effective 2026-01-15)
**Classification:** Internal — Architecture
**Companion documents:** `01-process-sop.md`, `02-business-rules-policy.md`

This reference describes the systems of record, their key data **Objects** (对象) with attributes and keys, the integrations between systems, and the **Events** (事件) exchanged. Object and event names are consistent with the SOP and the business-rules policy.

---

## 1. Systems of Record

| System | Role | Vendor/Type | Primary objects owned |
|--------|------|-------------|-----------------------|
| **PolicyCenter** | Policy administration | Guidewire-style PAS | `Submission`, `Quote`, `Policy`, `Coverage`, `Premium`, `Applicant` |
| **RatingEngine** | Premium calculation | Internal microservice | computes `Premium` (no system-of-record ownership) |
| **ClaimCenter** | Claims platform | Guidewire ClaimCenter | `Claim`, `Exposure`, `Reserve`, `ClaimPayment`, `Adjuster`, `Recovery`, `ClaimDocument` |
| **BillingCenter** | Billing & disbursement | Guidewire BillingCenter | invoices, disbursements (downstream of `Policy` and `ClaimPayment`) |
| **DocVault** | Document management | Internal DMS | `PolicyDocument`, `ClaimDocument` |

---

## 2. Data Entities and Attributes

### 2.1 Applicant (PolicyCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `applicant_id` | UUID | **PK** |
| `legal_name` | string | |
| `industry_code` | string (NAICS) | |
| `prior_loss_count_36m` | integer | drives `[BR-16]` |

### 2.2 Submission (PolicyCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `submission_id` | UUID | **PK** |
| `applicant_id` | UUID | **FK → Applicant** |
| `total_insured_value` | decimal(14,2) | drives `[BR-02]` |
| `cat_zone_tier` | enum {Tier1, Tier2, Tier3} | drives `[BR-03]` |
| `cleared` | boolean | `[BR-01]` |
| `status` | enum {New, Cleared, Referred, Quoted, Bound, Declined} | |

### 2.3 Quote (PolicyCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `quote_id` | UUID | **PK** |
| `submission_id` | UUID | **FK → Submission** |
| `quoted_premium` | decimal(12,2) | |
| `issued_date` | date | drives `[BR-14]` 60-day validity |
| `expiry_date` | date | |

### 2.4 Policy (PolicyCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `policy_id` | UUID | **PK** |
| `policy_number` | string | **business key**, unique |
| `applicant_id` | UUID | **FK → Applicant** |
| `effective_date` | date | drives `[BR-07]`, `[BR-08]` |
| `expiry_date` | date | drives `[BR-08]` |
| `status` | enum {Bound, Issued, InForce, Cancelled, Expired} | |

### 2.5 Coverage (PolicyCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `coverage_id` | UUID | **PK** |
| `policy_id` | UUID | **FK → Policy** |
| `peril` | enum {Fire, Wind, Flood, Theft, BusinessInterruption} | |
| `limit` | decimal(14,2) | |
| `deductible` | decimal(12,2) | drives `[BR-15]` |

### 2.6 Premium (PolicyCenter / RatingEngine)
| Attribute | Type | Key |
|-----------|------|-----|
| `premium_id` | UUID | **PK** |
| `policy_id` | UUID | **FK → Policy** |
| `annual_amount` | decimal(12,2) | drives `[BR-06]` minimum |

### 2.7 Claim (ClaimCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `claim_id` | UUID | **PK** |
| `claim_number` | string | **business key**, unique |
| `policy_number` | string | **FK → Policy.policy_number** |
| `date_of_loss` | date | drives `[BR-08]` |
| `fnol_timestamp` | timestamp | drives `[BR-09]` 48h clock |
| `estimated_incurred` | decimal(14,2) | drives `[BR-12]` |
| `status` | enum {Open, Assigned, InReview, Settled, Closed, Stale} | |

### 2.8 Exposure (ClaimCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `exposure_id` | UUID | **PK** |
| `claim_id` | UUID | **FK → Claim** |
| `coverage_id` | UUID | **FK → Coverage** |
| `coverage_decision` | enum {InForce, OutOfForce, NeedsReview, CoverageDenied} | drives `[BR-17]` |
| `status` | enum {Open, Reserved, Paying, Closed} | drives `[BR-13]` |

### 2.9 Reserve (ClaimCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `reserve_id` | UUID | **PK** |
| `exposure_id` | UUID | **FK → Exposure** |
| `amount` | decimal(14,2) | drives `[BR-11]` $250k approval |
| `last_reviewed_date` | date | drives `[BR-10]` 90-day review |
| `approved_by` | UUID (user) | nullable |

### 2.10 ClaimPayment (ClaimCenter → BillingCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `payment_id` | UUID | **PK** |
| `exposure_id` | UUID | **FK → Exposure** |
| `amount` | decimal(14,2) | drives `[BR-04]`, `[BR-05]` |
| `authorized_by` | UUID (user) | |
| `payment_status` | enum {Requested, Authorized, Issued, Voided} | |

### 2.11 Adjuster (ClaimCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `adjuster_id` | UUID | **PK** |
| `name` | string | |
| `authority_limit` | decimal(12,2) | default 25000 per `[BR-04]` |
| `seniority` | enum {Junior, Standard, Senior} | drives `[BR-12]` |

### 2.12 Recovery (ClaimCenter)
| Attribute | Type | Key |
|-----------|------|-----|
| `recovery_id` | UUID | **PK** |
| `claim_id` | UUID | **FK → Claim** |
| `liable_party` | string | drives `[BR-19]` |
| `recovered_amount` | decimal(14,2) | |

---

## 3. System Integrations

| # | Source → Target | Mechanism | Payload |
|---|-----------------|-----------|---------|
| I1 | PolicyCenter → RatingEngine | synchronous REST | `Submission` + `Coverage` selections → `Premium` |
| I2 | PolicyCenter → BillingCenter | async event bus | bound `Policy` + `Premium` → invoice |
| I3 | PolicyCenter → ClaimCenter | nightly batch + on-demand lookup | `Policy`, `Coverage` snapshot for coverage verification |
| I4 | ClaimCenter → BillingCenter | async event bus | authorized `ClaimPayment` → disbursement |
| I5 | PolicyCenter / ClaimCenter → DocVault | async upload | `PolicyDocument`, `ClaimDocument` |

---

## 4. Events Exchanged Between Systems

| Event | Emitted by | Consumed by | Carries |
|-------|-----------|-------------|---------|
| **SubmissionReceived** | PolicyCenter | PolicyCenter (clearance) | `submission_id` |
| **PolicyBound** | PolicyCenter | BillingCenter | `policy_id`, `premium_id` |
| **PolicyIssued** | PolicyCenter | DocVault | `policy_id` |
| **LossReported** | ClaimCenter | ClaimCenter | `policy_number`, `date_of_loss` |
| **FNOLRecorded** | ClaimCenter | ClaimCenter (coverage) | `claim_id` |
| **ExposureOpened** | ClaimCenter | ClaimCenter (reserving) | `exposure_id`, `coverage_id` |
| **CoverageConfirmed** | ClaimCenter (via I3) | ClaimCenter (assignment) | `claim_id`, decision |
| **ReserveSet** | ClaimCenter | ClaimCenter, BillingCenter | `reserve_id`, `amount` |
| **PaymentAuthorizationRequested** | ClaimCenter | ClaimCenter (supervisor queue) | `payment_id`, `amount` |
| **PaymentIssued** | BillingCenter | ClaimCenter | `payment_id` |
| **ClaimClosed** | ClaimCenter | ClaimCenter (subrogation) | `claim_id` |
| **RecoveryReceived** | BillingCenter | ClaimCenter | `recovery_id`, `recovered_amount` |

---

**End of ARC-CLM-UW-DATA-062.**
