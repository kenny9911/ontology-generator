# Systems of Record & Data Dictionary — Talent Acquisition
## 招聘系统与数据字典 (系统、对象、事件)

**Document ID:** TA-SYS-003
**Version:** 4.2
**Owner:** HR Technology (HRIS) & Data Engineering
**Effective Date:** 2026-01-15
**Related documents:** `01-process-sop.md` (TA-SOP-001), `02-business-rules-policy.md` (TA-POL-002).

This document is the authoritative data contract for the Talent Acquisition stack. Entity (对象) and attribute names here are the canonical names referenced by the SOP and the policy rules.

---

## 1. Systems of Record

| System | Role | Owns (system of record for) |
|---|---|---|
| **Workday** (HRIS) | Core HR | `Position`, `Approval` chain, `Worker`, `SalaryBand` (master) |
| **Greenhouse ATS** | Applicant tracking | `Requisition`, `Candidate`, `Application`, `InterviewStage`, `InterviewPanel`, `Scorecard`, `Offer` |
| **HackerRank** | Technical assessment | `Assessment` |
| **Checkr** | Background screening | `BackgroundCheck` |
| **DocuSign** | E-signature | `Offer` signature envelope |

---

## 2. Entities and Attributes (对象与属性)

### 2.1 `Position` — Workday
| Attribute | Type | Key |
|---|---|---|
| `position_id` | string | **PK** |
| `job_profile` | string | |
| `cost_center` | string | |
| `funded_headcount` | integer | |
| `annual_budget` | decimal(12,2) | |
| `salary_band_id` | string | **FK → SalaryBand** |
| `status` | enum(`Open`,`Frozen`,`Filled`) | |

### 2.2 `SalaryBand` — Workday (master)
| Attribute | Type | Key |
|---|---|---|
| `salary_band_id` | string | **PK** |
| `job_level` | string | |
| `location_zone` | string | |
| `currency` | char(3) | |
| `min_salary` | decimal(12,2) | |
| `mid_salary` | decimal(12,2) | |
| `max_salary` | decimal(12,2) | |

### 2.3 `Requisition` — Greenhouse ATS
| Attribute | Type | Key |
|---|---|---|
| `requisition_id` | string | **PK** |
| `position_id` | string | **FK → Position** |
| `hiring_manager_id` | string | **FK → HiringManager** |
| `recruiter_id` | string | |
| `title` | string | |
| `status` | enum(`Draft`,`Pending Approval`,`Approved`,`Rejected`,`Open`,`Filled`,`Closed`) | |
| `opened_at` | timestamp | |
| `closed_at` | timestamp | nullable |

### 2.4 `Candidate` — Greenhouse ATS
| Attribute | Type | Key |
|---|---|---|
| `candidate_id` | string | **PK** |
| `email` | string | **Unique** (dedup key) |
| `full_name` | string | |
| `is_internal` | boolean | |
| `source` | enum(`Inbound`,`Sourced`,`Referral`,`Agency`) | |
| `consent_retention_until` | date | nullable |

### 2.5 `Application` — Greenhouse ATS
| Attribute | Type | Key |
|---|---|---|
| `application_id` | string | **PK** |
| `candidate_id` | string | **FK → Candidate** |
| `requisition_id` | string | **FK → Requisition** |
| `current_stage` | enum(`Application Review`,`Recruiter Screen`,`Assessment`,`Onsite`,`Offer`,`Hired`,`Rejected`) | |
| `disposition_reason` | string | nullable (required when Rejected, per R17) |
| `created_at` | timestamp | |

### 2.6 `InterviewStage` / `InterviewPanel` — Greenhouse ATS
| Attribute | Type | Key |
|---|---|---|
| `stage_id` | string | **PK** |
| `application_id` | string | **FK → Application** |
| `stage_name` | string | |
| `panel_id` | string | |
| `interviewer_ids` | array<string> | min length 3 (per R5) |
| `bar_raiser_id` | string | (per R14) |
| `scheduled_at` | timestamp | |

### 2.7 `Scorecard` — Greenhouse ATS
| Attribute | Type | Key |
|---|---|---|
| `scorecard_id` | string | **PK** |
| `application_id` | string | **FK → Application** |
| `stage_id` | string | **FK → InterviewStage** |
| `interviewer_id` | string | **FK → Interviewer** |
| `recommendation` | enum(`Strong Yes`,`Yes`,`No`,`Strong No`) | |
| `submitted_at` | timestamp | |

### 2.8 `Assessment` — HackerRank
| Attribute | Type | Key |
|---|---|---|
| `assessment_id` | string | **PK** |
| `application_id` | string | **FK → Application** |
| `score_pct` | decimal(5,2) | pass threshold 70% (per R7) |
| `completed_at` | timestamp | |

### 2.9 `Offer` — Greenhouse ATS (signed via DocuSign)
| Attribute | Type | Key |
|---|---|---|
| `offer_id` | string | **PK** |
| `application_id` | string | **FK → Application** |
| `requisition_id` | string | **FK → Requisition** |
| `salary_band_id` | string | **FK → SalaryBand** |
| `base_salary` | decimal(12,2) | |
| `signon_bonus` | decimal(12,2) | (cap per R13) |
| `band_status` | enum(`InBand`,`AboveBand`,`BelowBand`) | |
| `status` | enum(`Draft`,`Pending Approval`,`Approved`,`Extended`,`Accepted`,`Declined`,`Expired`) | |
| `expires_at` | date | ≤ 7 business days (per R9) |

### 2.10 `Approval` — Workday
| Attribute | Type | Key |
|---|---|---|
| `approval_id` | string | **PK** |
| `subject_type` | enum(`Requisition`,`Offer`) | |
| `subject_id` | string | **FK → Requisition or Offer** |
| `approver_id` | string | |
| `approval_level` | enum(`Manager`,`HRBP`,`Finance`,`VP`) | |
| `decision` | enum(`Approved`,`Rejected`,`Pending`) | |
| `decided_at` | timestamp | |

### 2.11 `BackgroundCheck` — Checkr
| Attribute | Type | Key |
|---|---|---|
| `check_id` | string | **PK** |
| `candidate_id` | string | **FK → Candidate** |
| `offer_id` | string | **FK → Offer** |
| `result` | enum(`Clear`,`Consider`,`Suspended`) | (gate per R10) |
| `completed_at` | timestamp | |

### 2.12 `HiringManager` / `Interviewer` — Workday `Worker`
| Attribute | Type | Key |
|---|---|---|
| `worker_id` | string | **PK** |
| `email` | string | **Unique** |
| `department` | string | |
| `is_bar_raiser_certified` | boolean | (per R14) |

---

## 3. System Integrations

| Integration | Direction | Mechanism | Payload |
|---|---|---|---|
| Workday → Greenhouse | outbound | nightly batch + on-change webhook | `Position`, `SalaryBand`, `Approval` chain |
| Greenhouse → Workday | outbound | webhook | `Offer` accepted → create `Worker`, close `Requisition` |
| Greenhouse ↔ HackerRank | bidirectional | REST + webhook | `Assessment` invite / score |
| Greenhouse ↔ Checkr | bidirectional | REST + webhook | `BackgroundCheck` order / result |
| Greenhouse ↔ DocuSign | bidirectional | REST + webhook | `Offer` envelope / signature |

---

## 4. Events Exchanged Between Systems (事件)

| Event | Emitter | Consumer(s) | Carries |
|---|---|---|---|
| `RequisitionApproved` | Workday | Greenhouse | `requisition_id`, `Approval` |
| `JobPublished` | Greenhouse | sourcing channels | `requisition_id` |
| `ApplicationReceived` | Greenhouse | Recruiter queue | `application_id`, `candidate_id` |
| `AssessmentCompleted` | HackerRank | Greenhouse | `assessment_id`, `score_pct` |
| `InterviewScheduled` | Greenhouse | calendar, Interviewers | `stage_id`, `interviewer_ids` |
| `ScorecardSubmitted` | Greenhouse | Recruiter | `scorecard_id`, `recommendation` |
| `OfferApproved` | Workday | Greenhouse, DocuSign | `offer_id`, `Approval` |
| `OfferAccepted` | DocuSign | Greenhouse → Workday | `offer_id`, signature |
| `BackgroundCheckCompleted` | Checkr | Greenhouse, Workday | `check_id`, `result` |
| `CandidateHired` | Workday | Onboarding | `worker_id`, `requisition_id` |
| `RequisitionClosed` | Greenhouse | reporting | `requisition_id`, `closed_at` |

---

## 5. Identity & Linking Keys

- A `Candidate` is deduplicated globally by `email`.
- An `Application` is the unique link between one `Candidate` and one `Requisition`.
- An `Offer` links back to exactly one `Application`, `Requisition`, and `SalaryBand`.
- An `Approval` polymorphically references either a `Requisition` or an `Offer` via (`subject_type`, `subject_id`).
- `time_to_hire` is computed as `Requisition.closed_at − Requisition.opened_at`, enabling consistent people-analytics reporting once `InterviewStage` and stage transitions share one definition across systems.
