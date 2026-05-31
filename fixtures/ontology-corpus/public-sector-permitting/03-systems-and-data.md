# Systems of Record & Data Model — Permitting & Benefits Eligibility

**Document ID:** ARCH-PBE-003
**Owning unit:** Office of Permitting & Benefits Administration (OPBA) — Data & Integration
**Version:** 4.2 (effective 2026-01-01)
**Related documents:** `01-process-sop.md` (SOP-PBE-014), `02-business-rules-policy.md` (POL-PBE-007)

---

## 1. Systems of Record

| System | Code | Role | System of record for |
|---|---|---|---|
| Case-Management System | **PBE-CMS** | Adjudication core | `Case`, `Application`, `Determination`, `Appeal`, `Permit`, `Inspection` |
| Document-Management System | **DMS** | Document storage & verification status | `Document` |
| Public Self-Service Portal | **PORTAL** | Applicant-facing intake & appeals | `Applicant`, draft `Application` |
| Payment Gateway | **PAY** | Fee collection | `Payment` |
| Notification Service | **NOTIFY** | Outbound correspondence | (no entities; emits notices) |
| Identity & Residency Verification | **IDV** | External lookups | residency / identity attributes of `Applicant`, `Household` |

PBE-CMS is the authoritative source for adjudication Objects. DMS owns Document binaries and verification state. The eligibility engine inside PBE-CMS evaluates `EligibilityCriterion` definitions against `Application` and `Household` data.

## 2. Data Entities & Attributes

Types: `uuid`, `string`, `enum`, `int`, `money`, `date`, `timestamp`, `bool`. **PK** = primary key, **FK** = foreign key.

### 2.1 Applicant (申请人) — owner: PORTAL/PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `applicant_id` | uuid | **PK** |
| `full_name` | string | |
| `national_id` | string | unique, verified via IDV |
| `email` | string | |
| `residency_verified` | bool | set by IDV per [BR-06] |
| `household_id` | uuid | **FK** → Household |

### 2.2 Household (家庭) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `household_id` | uuid | **PK** |
| `household_size` | int | drives income threshold [BR-05] |
| `annual_income` | money | tested against threshold |
| `address` | string | within-jurisdiction check |

### 2.3 Application (申请) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `application_id` | uuid | **PK** |
| `applicant_id` | uuid | **FK** → Applicant |
| `program_code` | enum | `BENEFIT` / `PERMIT` |
| `permit_class` | enum | `OCCUPANCY` / `OPERATING` / `PERMANENT` (null for benefits) |
| `status` | enum | `Submitted` / `Accepted` / `ReturnedIncomplete` / `Adjudicated` |
| `submitted_at` | timestamp | starts clock [BR-03] |

### 2.4 Case (案件) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `case_id` | uuid | **PK** |
| `application_id` | uuid | **FK** → Application |
| `assigned_caseworker` | string | |
| `status` | enum | `Open` / `PendingApproval` / `Closed` / `Suspended` |
| `recert_due_date` | date | drives [BR-17]/[BR-18] |

### 2.5 EligibilityCriterion (资格条件) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `criterion_id` | uuid | **PK** |
| `rule_citation` | string | e.g. `BR-05`, used in denials [BR-08] |
| `program_code` | enum | scope |
| `threshold_value` | money | income limit by size |
| `ruleset_version` | string | versioned per [BR-15] |

### 2.6 Document (文件) — owner: DMS
| Attribute | Type | Notes |
|---|---|---|
| `document_id` | uuid | **PK** |
| `application_id` | uuid | **FK** → Application |
| `doc_type` | enum | `INCOME` / `RESIDENCY` / `IDENTITY` / `HARDSHIP` |
| `status` | enum | `Pending` / `Verified` / `Rejected` |
| `verified_by` | string | must differ from logger [BR-02] |
| `dated_on` | date | residency recency [BR-06] |

### 2.7 Determination (裁定) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `determination_id` | uuid | **PK** |
| `case_id` | uuid | **FK** → Case |
| `outcome` | enum | `Approved` / `Denied` / `PendingApproval` |
| `decisive_criterion_id` | uuid | **FK** → EligibilityCriterion [BR-08] |
| `ruleset_version` | string | snapshot at decision [BR-15] |
| `benefit_value` | money | escalation trigger [BR-07] |
| `decided_at` | timestamp | |

### 2.8 Permit (许可证) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `permit_id` | uuid | **PK** |
| `determination_id` | uuid | **FK** → Determination |
| `payment_id` | uuid | **FK** → Payment [BR-09] |
| `status` | enum | `Active` / `ConditionalHold` / `Active-Verified` / `Expired` / `Revoked` |
| `issued_at` | date | |
| `expires_at` | date | ≤ 12 months [BR-13] |

### 2.9 Inspection (验收) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `inspection_id` | uuid | **PK** |
| `permit_id` | uuid | **FK** → Permit |
| `status` | enum | `Scheduled` / `Passed` / `Failed` |
| `inspector_id` | string | |
| `reinspect_by` | date | 30-day window [BR-14] |

### 2.10 Payment (缴费) — owner: PAY
| Attribute | Type | Notes |
|---|---|---|
| `payment_id` | uuid | **PK** |
| `application_id` | uuid | **FK** → Application |
| `amount` | money | fee schedule |
| `status` | enum | `Pending` / `Cleared` / `Failed` |

### 2.11 Appeal (申诉) — owner: PBE-CMS
| Attribute | Type | Notes |
|---|---|---|
| `appeal_id` | uuid | **PK** |
| `determination_id` | uuid | **FK** → Determination |
| `filed_at` | timestamp | ≤ 30 days of notice [BR-11] |
| `status` | enum | `Filed` / `UnderReview` / `Upheld` / `Overturned` |
| `decided_at` | timestamp | ≤ 45 days [BR-16] |

## 3. System Integrations

| From → To | Mechanism | Payload |
|---|---|---|
| PORTAL → PBE-CMS | REST `POST /applications` | Application + Document references |
| PBE-CMS → DMS | REST + webhook | Document verification requests/results |
| PBE-CMS → IDV | REST lookup | residency/identity attribute checks |
| PORTAL → PAY → PBE-CMS | redirect + webhook | Payment authorization & clearance |
| PBE-CMS → NOTIFY | event/queue | decision-notice render request |

## 4. Events Exchanged Between Systems (事件)

| Event | Emitted by | Consumed by | Carries |
|---|---|---|---|
| `ApplicationSubmitted` | PORTAL | PBE-CMS | `application_id`, `submitted_at` |
| `ApplicationAccepted` / `ApplicationReturned` | PBE-CMS | PORTAL, NOTIFY | `application_id`, missing-doc list |
| `DocumentVerified` / `DocumentRejected` | DMS | PBE-CMS | `document_id`, status, reason |
| `EligibilityEvaluated` | PBE-CMS | PBE-CMS | `case_id`, `decisive_criterion_id` |
| `DeterminationRecorded` | PBE-CMS | NOTIFY, PAY | `determination_id`, `outcome` |
| `ApprovalRequested` | PBE-CMS | PBE-CMS (Supervisor queue) | `determination_id`, `benefit_value` |
| `DeterminationNotified` | NOTIFY | Applicant | notice, appeal deadline |
| `PaymentCleared` / `PaymentFailed` | PAY | PBE-CMS | `payment_id`, `amount`, status |
| `PermitIssued` | PBE-CMS | PORTAL, NOTIFY | `permit_id`, `expires_at` |
| `InspectionScheduled` | PBE-CMS | Inspector | `inspection_id`, `permit_id` |
| `InspectionPassed` / `InspectionFailed` | PBE-CMS | PBE-CMS | `inspection_id`, findings |
| `AppealFiled` | PORTAL | PBE-CMS | `appeal_id`, `determination_id` |
| `AppealDecided` | PBE-CMS | NOTIFY | `appeal_id`, outcome |
| `RecertificationDue` | PBE-CMS | NOTIFY, Applicant | `case_id`, `recert_due_date` |
| `CaseSuspended` | PBE-CMS | NOTIFY | `case_id`, reason |

## 5. Cross-Reference Integrity

- Every `Determination` cites a `decisive_criterion_id` and `ruleset_version` to satisfy [BR-08] and [BR-15].
- `Permit.payment_id` is non-null only after a `PaymentCleared` event, enforcing [BR-09].
- `Case.recert_due_date` drives the `RecertificationDue` event per [BR-17].
- All Object, Action, and Event names match exactly across `01-process-sop.md` and `02-business-rules-policy.md`.
