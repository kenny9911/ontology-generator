# Business Rules & Quality Policy — Bill-of-Materials & Quality
## POL-QMS-08 · Discrete Manufacturing / 制造业 — 物料清单与质量规则

| Field | Value |
|---|---|
| Document ID | POL-QMS-08 |
| Revision | E (effective 2026-04-01) |
| Owner | Vice President, Quality |
| Authority | ISO 9001:2015, IATF 16949 |
| Governs Objects | `Part`, `BillOfMaterials`, `EngineeringChange`, `WorkOrder`, `Supplier`, `InspectionLot`, `Inspection`, `NonConformance`, `Disposition`, `CorrectiveAction` |
| Companion documents | `01-process-sop.md` (SOP-MFG-204), `03-systems-and-data.md` |

> **Reading note for extraction.** Each rule below is one atomic, self-contained clause. Rules are referenced elsewhere as `[R-nn]`. Thresholds, time limits, approval levels, eligibility, and exceptions are stated explicitly.

---

## Section A — Revision & Engineering Change Rules

**[R-01]** A `WorkOrder` **may not be released** unless every component `Part` in its `BillOfMaterials` is at the currently effective `revision`.

**[R-02]** A component `Part` that has an open `NonConformance` with `Disposition = Quarantine` **shall not** be consumed by any newly released `WorkOrder`.

**[R-03]** Any `EngineeringChange` that affects a `Part` whose `safety_class` is `Critical` **is required to** obtain a second engineer's approval before it may be released.

**[R-04]** A finished lot **may not ship** until its `InspectionLot` is `Accepted`; a `Rejected` `InspectionLot` **shall** automatically open a `NonConformance`.

**[R-05]** An `EngineeringChange` **must** be approved by a Change Control Board quorum of at least three voting members before it moves to status `Approved`.

**[R-06]** A `BillOfMaterials` revision **shall** carry an `effective_from` date no fewer than 5 business days in the future, except that an `EngineeringChange` flagged `emergency = true` **may** be made effective immediately with VP of Quality approval.

---

## Section B — Production & Material Rules

**[R-07]** An `InspectionLot` **is required** for every finished lot of any `Part` whose `inspection_required` flag is true.

**[R-08]** An `InspectionLot` **shall** be set to `Accepted` only when the observed defect count is at or below the AQL 1.0 acceptance number for the applicable sample size; otherwise it **must** be set to `Rejected`.

**[R-09]** Every component goods issue **must** be backflushed against the `bom_revision` recorded on the released `WorkOrder`, and **may not** be backflushed against a later revision.

**[R-16]** A `WorkOrder` **may not** be closed while any linked `InspectionLot` remains in status `Open` or `InProcess`.

---

## Section C — Supplier Rules

**[R-10]** Goods **may** be received only from a `Supplier` whose `qualification_status` is `Approved`.

**[R-11]** A `Supplier` whose incoming-lot rejection rate exceeds 2% over any rolling 90-day window **shall** be automatically flagged for re-qualification.

---

## Section D — Nonconformance & Corrective Action Rules

**[R-12]** A `NonConformance` **must** be assigned an owner within 24 hours of being opened.

**[R-13]** A `Disposition` of `UseAsIs` or `Rework` on a `Part` whose `safety_class` is `Critical` **is required to** carry Quality Manager sign-off.

**[R-14]** A `NonConformance` that recurs three or more times within any 90-day window for the same `Part` **shall** trigger a formal `CorrectiveAction` (CAPA).

**[R-15]** A `NonConformance` involving a `Part` whose `safety_class` is `Critical` **must** be escalated to the Quality Manager within 4 hours of being opened.

---

## Section E — Records & Eligibility Rules

**[R-17]** An `Inspection` record **may not** be edited after its `InspectionLot` usage decision has been posted; corrections **shall** be made through a new, linked `Inspection`.

**[R-18]** A `CorrectiveAction` **must** be verified effective before its linked `NonConformance` **may** be set to status `Closed`.

**[R-19]** Only a Quality Engineer or higher **is authorized to** post a `Disposition`; a Quality Inspector **may not** post a `Disposition`.

**[R-20]** A `Part` **may not** be released to a customer-facing shipment if any of its constituent component lots has an unresolved `NonConformance` with severity `Major` or `Critical`.

---

## Exceptions Register

- **E1 (to [R-01]):** A `WorkOrder` already released before an `EngineeringChange` became effective is grandfathered to its build revision and is flagged `WorkOrderRevalidationRequired` for engineering review rather than auto-blocked.
- **E2 (to [R-06]):** Emergency changes bypass the 5-business-day lead time only with recorded VP of Quality approval against the `EngineeringChange`.
- **E3 (to [R-10]):** A one-time `Supplier` waiver receipt is permitted with Director of Supply Chain approval recorded against the goods receipt, valid for that single lot only.
