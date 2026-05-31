# Systems of Record & Data Model — Bill-of-Materials & Quality
## ARCH-DATA-12 · Discrete Manufacturing / 制造业 — 系统与数据

| Field | Value |
|---|---|
| Document ID | ARCH-DATA-12 |
| Revision | E (effective 2026-04-01) |
| Owner | Enterprise Architecture & MES Platform |
| Companion documents | `01-process-sop.md` (SOP-MFG-204), `02-business-rules-policy.md` (POL-QMS-08) |

This document is the authoritative catalog of the business **Objects** (对象), their attributes and keys, the **systems of record**, the integrations between them, and the **Events** (事件) exchanged. Object and event names are identical to those used in the SOP and the rules policy so the model links across all three documents.

---

## 1. Systems of Record

| System | Role | Owns these Objects |
|---|---|---|
| **SAP ECC** | PLM + ERP. Master data, BOM, production, inventory, QM usage decisions. | `Part`, `BillOfMaterials`, `WorkOrder`, `InspectionLot`, `Supplier` |
| **Jira ECR** | Engineering change request workflow & approvals. | `EngineeringChange` |
| **Quality Data Mart** | Inspection results, SPC, nonconformance & CAPA analytics. | `Inspection`, `NonConformance`, `Disposition`, `CorrectiveAction` |

> SAP ECC is the system of record for product structure and inventory state. Jira ECR is authoritative for change governance until release, at which point effectivity is written into SAP ECC. The Quality Data Mart is authoritative for inspection and nonconformance analytics.

---

## 2. Object Catalog — Entities, Attributes, Keys

### 2.1 `Part` (零件) — SAP ECC `MARA`/`MARC`
| Attribute | Type | Notes |
|---|---|---|
| `part_number` | string | **Primary key.** Format `NN-A` (e.g. `12-A`). |
| `revision` | string | Currently effective revision, e.g. `E`. |
| `description` | string | |
| `safety_class` | enum(`Standard`,`Significant`,`Critical`) | Drives `[R-03]`,`[R-13]`,`[R-15]`. |
| `inspection_required` | boolean | Drives `[R-07]`. |
| `unit_of_measure` | string | |
| `make_or_buy` | enum(`Make`,`Buy`) | Buy parts link to a `Supplier`. |

### 2.2 `BillOfMaterials` (物料清单) — SAP ECC `STKO`/`STPO`
| Attribute | Type | Notes |
|---|---|---|
| `bom_id` | string | **Primary key.** |
| `parent_part_number` | string (FK → `Part.part_number`) | The assembled `Part`. |
| `bom_revision` | string | |
| `effective_from` | date | Governed by `[R-06]`. |
| `effective_to` | date / null | |
| `components` | list of {`part_number` (FK → `Part`), `quantity`, `component_revision`} | |

### 2.3 `EngineeringChange` (工程变更) — Jira ECR
| Attribute | Type | Notes |
|---|---|---|
| `ecr_id` | string | **Primary key.** Format `ECR-#####`. |
| `status` | enum(`Draft`,`Classified`,`Approved`,`Rejected`,`Released`) | |
| `category` | enum(`Minor`,`Major`,`Safety`) | Set by `ClassifyEngineeringChange`. |
| `affected_parts` | list (FK → `Part.part_number`) | |
| `safety_classified` | boolean | Drives `[R-03]`. |
| `requires_second_approval` | boolean | |
| `emergency` | boolean | Exception E2 to `[R-06]`. |
| `approver_ids` | list of string | Quorum check `[R-05]`. |

### 2.4 `WorkOrder` (生产工单) — SAP ECC `AUFK`/`AFKO`
| Attribute | Type | Notes |
|---|---|---|
| `work_order_id` | string | **Primary key.** Format `WO-######`. |
| `parent_part_number` | string (FK → `Part`) | |
| `bom_id` | string (FK → `BillOfMaterials.bom_id`) | Revision frozen at release per `[R-09]`. |
| `bom_revision` | string | The revision built to. |
| `status` | enum(`Created`,`Released`,`InProcess`,`Closed`,`Blocked`) | `[R-01]`,`[R-16]`. |
| `quantity` | integer | |

### 2.5 `Supplier` (供应商) — SAP ECC `LFA1`
| Attribute | Type | Notes |
|---|---|---|
| `supplier_id` | string | **Primary key.** |
| `name` | string | |
| `qualification_status` | enum(`Approved`,`Conditional`,`Disqualified`) | `[R-10]`. |
| `rejection_rate_90d` | decimal | Drives `[R-11]` (threshold 2%). |

### 2.6 `InspectionLot` (检验批) — SAP ECC `QALS`
| Attribute | Type | Notes |
|---|---|---|
| `lot_id` | string | **Primary key.** Format `LOT-########`. |
| `part_number` | string (FK → `Part`) | |
| `work_order_id` | string / null (FK → `WorkOrder`) | Null for incoming inspection. |
| `supplier_id` | string / null (FK → `Supplier`) | Set for incoming inspection. |
| `lot_type` | enum(`InProcess`,`Final`,`Incoming`) | |
| `sample_size` | integer | |
| `status` | enum(`Open`,`InProcess`,`Accepted`,`Rejected`) | `[R-04]`,`[R-08]`. |

### 2.7 `Inspection` (检验记录) — Quality Data Mart
| Attribute | Type | Notes |
|---|---|---|
| `inspection_id` | string | **Primary key.** |
| `lot_id` | string (FK → `InspectionLot`) | |
| `characteristics` | list of {`name`, `measured_value`, `result` enum(`Pass`,`Fail`)} | |
| `defect_count` | integer | Compared to AQL number `[R-08]`. |
| `aggregate_result` | enum(`Pass`,`Fail`) | |
| `inspected_by` | string | Quality Inspector id. |
| `posted` | boolean | Once true, immutable per `[R-17]`. |

### 2.8 `NonConformance` (不合格品) — Quality Data Mart
| Attribute | Type | Notes |
|---|---|---|
| `ncr_id` | string | **Primary key.** Format `NCR-#####`. |
| `part_number` | string (FK → `Part`) | |
| `lot_id` | string (FK → `InspectionLot`) | |
| `supplier_id` | string / null (FK → `Supplier`) | |
| `severity` | enum(`Minor`,`Major`,`Critical`) | `[R-20]`. |
| `owner_id` | string / null | Assigned within 24h `[R-12]`. |
| `status` | enum(`Open`,`Assigned`,`Dispositioned`,`Closed`) | |
| `opened_at` | timestamp | Clock for `[R-12]`,`[R-15]`. |

### 2.9 `Disposition` (处置) — Quality Data Mart
| Attribute | Type | Notes |
|---|---|---|
| `disposition_id` | string | **Primary key.** |
| `ncr_id` | string (FK → `NonConformance`) | |
| `decision` | enum(`UseAsIs`,`Rework`,`ReturnToSupplier`,`Quarantine`,`Scrap`) | `[R-02]`,`[R-13]`. |
| `approved_by` | string / null | QM sign-off when required `[R-13]`,`[R-19]`. |

### 2.10 `CorrectiveAction` (纠正措施) — Quality Data Mart
| Attribute | Type | Notes |
|---|---|---|
| `capa_id` | string | **Primary key.** Format `CAPA-#####`. |
| `ncr_id` | string (FK → `NonConformance`) | |
| `root_cause` | text | |
| `due_date` | date | |
| `verified_effective` | boolean | Gate for `[R-18]`. |
| `status` | enum(`Open`,`InVerification`,`Closed`) | |

---

## 3. System Integrations

| Integration | Direction | Payload Object(s) | Cadence |
|---|---|---|---|
| **INT-1: ECR Release Sync** | Jira ECR → SAP ECC | `EngineeringChange`, new `BillOfMaterials` revision | On `EngineeringChangeApproved` |
| **INT-2: QM Result Feed** | SAP ECC → Quality Data Mart | `InspectionLot`, `Inspection` | Near-real-time on each result post |
| **INT-3: NCR Disposition Writeback** | Quality Data Mart → SAP ECC | `Disposition` (stock posting), blocked-stock flag | On `NonConformanceDispositioned` |
| **INT-4: Supplier Scorecard** | Quality Data Mart → SAP ECC | `Supplier.rejection_rate_90d`, re-qualification flag | Nightly batch |

---

## 4. Events Exchanged Between Systems

| Event (事件) | Source system | Target system(s) | Carries |
|---|---|---|---|
| `EngineeringChangeApproved` | Jira ECR | SAP ECC | `ecr_id`, affected `part_number`s |
| `BomRevisionPublished` | SAP ECC | Quality Data Mart, MES | `bom_id`, `bom_revision`, `effective_from` |
| `RevisionBecameEffective` | SAP ECC | SAP ECC (PP), MES | `part_number`, `revision` |
| `WorkOrderReleased` | SAP ECC | Quality Data Mart | `work_order_id`, `bom_revision` |
| `FinishedLotProduced` | SAP ECC | SAP ECC (QM) | `work_order_id`, `part_number`, `lot_id` |
| `InspectionLotOpened` | SAP ECC | Quality Data Mart | `lot_id`, `part_number`, `lot_type` |
| `InspectionRecorded` | Quality Data Mart | SAP ECC | `inspection_id`, `lot_id`, `aggregate_result` |
| `InspectionLotAccepted` | SAP ECC | MES, Delivery | `lot_id` |
| `InspectionLotRejected` | SAP ECC | Quality Data Mart | `lot_id`, `part_number` |
| `NonConformanceOpened` | Quality Data Mart | SAP ECC | `ncr_id`, `lot_id`, `part_number` |
| `NonConformanceDispositioned` | Quality Data Mart | SAP ECC | `ncr_id`, `disposition_id`, `decision` |
| `CorrectiveActionClosed` | Quality Data Mart | Jira ECR (optional new ECR) | `capa_id`, `ncr_id` |

---

## 5. Cross-Document Identifier Map

| Object | Key | First defined | Referenced by rules |
|---|---|---|---|
| `Part` | `part_number` | §2.1 | R-01, R-02, R-03, R-07, R-13, R-14, R-15, R-20 |
| `BillOfMaterials` | `bom_id` | §2.2 | R-01, R-06, R-09 |
| `EngineeringChange` | `ecr_id` | §2.3 | R-03, R-05, R-06 |
| `WorkOrder` | `work_order_id` | §2.4 | R-01, R-02, R-09, R-16 |
| `Supplier` | `supplier_id` | §2.5 | R-10, R-11 |
| `InspectionLot` | `lot_id` | §2.6 | R-04, R-07, R-08, R-16 |
| `Inspection` | `inspection_id` | §2.7 | R-08, R-17 |
| `NonConformance` | `ncr_id` | §2.8 | R-02, R-04, R-12, R-14, R-15, R-18, R-20 |
| `Disposition` | `disposition_id` | §2.9 | R-02, R-13, R-19 |
| `CorrectiveAction` | `capa_id` | §2.10 | R-14, R-18 |
