# Systems of Record & Data Entities — Care Pathway & Revenue Cycle

**Document ID:** ARCH-RCM-014
**Version:** 4.2
**Effective Date:** 2026-01-01
**Owner:** Enterprise Data & Integration Architecture, Mercy Lakeside Health System
**Companion documents:** `01-process-sop.md`, `02-business-rules-policy.md`.

---

## 1. Purpose

This document defines the systems of record, their authoritative data entities (对象) with key
attributes, the integrations between systems, and the events (事件) exchanged across system
boundaries. Entity and system names here are identical to those used in the SOP and the policy
document so that downstream models can link entity ↔ rule ↔ process.

---

## 2. Systems of Record (系统清单)

| System | 中文 | Role | Authoritative For |
|--------|------|------|-------------------|
| **Epic EHR** | 电子病历系统 | Clinical system of record | Patient, Encounter, Order, Procedure, Diagnosis, PriorAuthorization |
| **Epic Clarity** | 数据仓库 | Reporting / analytics warehouse | Read-only nightly copy of all clinical + financial entities |
| **CDM (Charge Description Master)** | 收费主数据 | Pricing & code reference | Charge code, price, revenue code, CPT/HCPCS crosswalk |
| **Revenue Cycle System (RCS / "Resolute")** | 收入周期系统 | Charge router + claim engine + AR | Charge, Claim, Denial, payment posting |
| **Clearinghouse (Waystar)** | 清算网关 | EDI gateway to payers | Transaction routing (270/271, 278, 837, 835, 999/277CA) |

---

## 3. Data Entities & Attributes (数据实体)

### 3.1 Patient — `EHR.PATIENT`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `MRN` | string(10) | **PK** | Medical Record Number; the canonical patient identifier. |
| `lastName`, `firstName` | string | | Legal name. |
| `dateOfBirth` | date | | Used with name for identity matching. |
| `enterpriseId` | uuid | unique | Cross-facility master-patient-index key. |

### 3.2 Encounter — `EHR.ENCOUNTER`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `EncounterID` | bigint | **PK** | |
| `MRN` | string(10) | **FK → Patient** | Owning patient. |
| `encounterClass` | enum {Inpatient, Outpatient, Emergency, Observation} | | |
| `emergencyFlag` | boolean | | Drives R-02 / R-04 exception. |
| `triageTimestamp` | timestamp | | Anchor for sepsis clock (R-08). |
| `dischargeDate` | date | | Anchor for R-03, R-10, R-12 deadlines. |
| `status` | enum {Open, Discharged, CodingComplete, Billed} | | |

### 3.3 Coverage — `EHR.COVERAGE`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `CoverageID` | bigint | **PK** | |
| `MRN` | string(10) | **FK → Patient** | |
| `payerId` | string | | Payer/plan identifier. |
| `memberId` | string | | Subscriber's member number. |
| `status` | enum {Active, Inactive, Termed} | | Set by VerifyEligibility (271). |
| `eligibilityCheckedAt` | timestamp | | Supports R-02. |

### 3.4 Order — `EHR.ORDER`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `OrderID` | bigint | **PK** | |
| `EncounterID` | bigint | **FK → Encounter** | |
| `ProcedureID` | bigint | **FK → Procedure** | Catalog procedure ordered. |
| `orderingProviderNPI` | string(10) | | |
| `placedAt` | timestamp | | Start of R-06 24-hour auth SLA. |
| `status` | enum {Placed, AuthPending, Released, Cancelled} | | |

### 3.5 Procedure — `EHR.PROCEDURE`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `ProcedureID` | bigint | **PK** | |
| `EncounterID` | bigint | **FK → Encounter** | |
| `cptCode` | string(5) | | CPT/HCPCS code. |
| `billedAmount` | decimal(12,2) | | Drives R-04 $1,500 threshold. |
| `requiresAuth` | boolean | | Designated-procedure flag. |
| `startTime`, `stopTime` | timestamp | | Documented service window. |

### 3.6 Diagnosis — `EHR.DIAGNOSIS`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `DiagnosisID` | bigint | **PK** | |
| `EncounterID` | bigint | **FK → Encounter** | |
| `icd10Code` | string(8) | | ICD-10-CM code. |
| `isPrimary` | boolean | | Principal diagnosis flag. |
| `linkedProcedureID` | bigint | FK → Procedure | Supports R-09 / R-13 linkage. |

### 3.7 PriorAuthorization — `EHR.PRIOR_AUTH`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `AuthID` | bigint | **PK** | |
| `EncounterID` | bigint | **FK → Encounter** | |
| `ProcedureID` | bigint | **FK → Procedure** | |
| `payerId` | string | | |
| `approvalNumber` | string | | Returned on 278 approval. |
| `approvedUnits` | int | | Constrains R-07. |
| `expirationDate` | date | | Date-of-service check (R-07). |
| `status` | enum {Requested, Approved, Denied, Pended} | | |

### 3.8 Charge — `RCS.CHARGE`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `ChargeID` | bigint | **PK** | |
| `EncounterID` | bigint | **FK → Encounter** | |
| `ProcedureID` | bigint | **FK → Procedure** | |
| `cdmCode` | string | **FK → CDM** | Must be active (R-11). |
| `amount` | decimal(12,2) | | |
| `postedAt` | timestamp | | Late-charge window (R-12). |

### 3.9 Claim — `RCS.CLAIM`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `ClaimID` | bigint | **PK** | |
| `EncounterID` | bigint | **FK → Encounter** | |
| `CoverageID` | bigint | **FK → Coverage** | |
| `totalBilled` | decimal(12,2) | | Sum of linked Charges. |
| `frequencyCode` | enum {1, 7, 8} | | 7 = replacement (R-16). |
| `submittedAt` | timestamp | | Timely-filing check (R-03). |
| `status` | enum {Draft, Held, Ready, Submitted, Accepted, Rejected, Paid, Denied} | | |

### 3.10 Denial — `RCS.DENIAL`
| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `DenialID` | bigint | **PK** | |
| `ClaimID` | bigint | **FK → Claim** | |
| `carcCode` | string | | Claim Adjustment Reason Code. |
| `rarcCode` | string | | Remittance Advice Remark Code. |
| `deniedAmount` | decimal(12,2) | | Write-off authority thresholds (R-19). |
| `category` | enum {Clinical, Coding, Authorization, Eligibility, Technical} | | |
| `routedAt` | timestamp | | 2-business-day SLA (R-17). |

---

## 4. System Integrations (集成)

| # | Source → Target | Mechanism | Payload | Cadence |
|---|-----------------|-----------|---------|---------|
| I-1 | Epic EHR → Epic Clarity | ETL extract | All clinical + financial entities | Nightly batch |
| I-2 | Epic EHR → RCS | HL7 / internal API | Documented Procedures → Charges | Near real-time |
| I-3 | RCS → Clearinghouse | EDI 837 | Outbound Claims | Hourly batch |
| I-4 | Clearinghouse → RCS | EDI 835 | Remittance / payments / Denials | On payer file arrival |
| I-5 | Epic EHR ↔ Clearinghouse | EDI 270/271 | Eligibility inquiry / response | Real-time at registration |
| I-6 | Epic EHR ↔ Clearinghouse | EDI 278 | PriorAuthorization request / response | On demand |
| I-7 | RCS ← CDM | Reference lookup | Charge code / price / revenue code | On charge generation |

---

## 5. Events Exchanged Between Systems (系统间事件)

| Event | 中文 | Emitted By | Consumed By | Carries |
|-------|------|-----------|-------------|---------|
| `EncounterCreated` | 就诊创建 | Epic EHR | RCS, Clarity | `EncounterID`, `MRN` |
| `EligibilityVerified` | 资格已核验 | Clearinghouse → EHR | EHR, RCS | `CoverageID`, status |
| `AuthorizationRequested` | 授权已申请 | EHR | Clearinghouse | `AuthID`, `ProcedureID` |
| `AuthorizationApproved` | 授权已批准 | Clearinghouse → EHR | EHR, RCS | `AuthID`, approvalNumber, expirationDate |
| `ProcedureDocumented` | 操作已记录 | Epic EHR | RCS | `ProcedureID`, `EncounterID` |
| `ChargeCaptured` | 费用已生成 | RCS | RCS, Clarity | `ChargeID`, `cdmCode`, amount |
| `CodingCompleted` | 编码已完成 | Epic EHR / RCS | RCS | `EncounterID`, code set |
| `ClaimSubmitted` | 理赔已提交 | RCS → Clearinghouse | Clearinghouse, payer | `ClaimID`, 837 |
| `ClaimAccepted` | 理赔已受理 | Clearinghouse → RCS | RCS | `ClaimID`, 277CA |
| `PaymentPosted` | 付款已入账 | RCS | RCS, Clarity | `ClaimID`, paid amount, 835 |
| `ClaimDenied` | 理赔被拒 | RCS | RCS (Denials queue) | `DenialID`, `carcCode` |

---

## 6. Revision History

| Version | Date | Change |
|---------|------|--------|
| 4.1 | 2025-10-15 | Added `triageTimestamp` to Encounter for sepsis clock. |
| 4.2 | 2026-01-01 | Added Denial entity and `ClaimDenied` event; documented 835/277CA integrations. |
