# Inference Use-Case Suite — 30 multi-hop questions over the golden ontologies

This document defines the acceptance suite for the inference engine described in
[HYPER_AUTOMATION_DESIGN.md](HYPER_AUTOMATION_DESIGN.md) §3. Each use case is a
realistic business question (bilingual en/zh) that **cannot be answered from a
single triple** — answering requires at least **3 inference hops** across the
triple projection of one of the ten golden fixtures in
`fixtures/ontology-golden/`. The machine-readable mirror lives at
[`fixtures/inference-use-cases.json`](../fixtures/inference-use-cases.json);
every node id in every hop path below exists verbatim in its fixture, and every
adjacent (node, predicate, node) pair corresponds to a real projected triple, so
tests can verify the suite deterministically.

## The triple projection, and what counts as a hop

`ontologyToTriples(ontology)` flattens an Ontology into `(subject, predicate,
object)` triples using a **closed predicate vocabulary** (design doc §3.1):

| predicate | meaning |
|---|---|
| `kind`, `label` | every node's entity kind and display name (literals) |
| `has_attribute`, `has_type`, `references` | object → attribute pseudo-node (`<objectId>.<attrName>`), its datatype, and FK references |
| *relationship verb names* | one predicate per `Relationship.name` (e.g. `secured_by`, `contains`, `settled_by`) from source to target object type |
| `applies_to`, `severity`, `rule_kind`, `triggered_by` | rule → governed objects, severity/kind literals, and the event that fires it |
| `consumes`, `produces`, `guarded_by`, `emits`, `triggered_by`, `performed_by`, `calls` | action → its input/output objects, precondition rules, emitted/triggering events, actor role, and called actions |
| `produced_by`, `consumed_by` | event → the actions that emit / are triggered by it (the exact inverse of `emits`/`triggered_by`) |
| `has_step`, `precedes`, `triggered_by`, `involves` | process → its step actions, step ordering, triggering events, and involved objects |

**A hop is one predicate traversal.** A hop path is an alternating chain
`nodeId, predicate, nodeId, predicate, nodeId, …`; the hop count is the number
of predicates in the chain. Conventions used throughout this suite:

- **Traversal is undirected; predicates are canonical.** Triples are directed,
  but inference walks them both ways. Each hop below names the canonical
  predicate of the underlying triple regardless of travel direction — e.g. the
  hop `objectType:feeder → parents → objectType:substation` traverses the
  triple `(objectType:substation, parents, objectType:feeder)` in reverse.
- **Attribute pseudo-ids** look like `objectType:order.total`: the base id must
  be a real object type and the suffix a real entry in its `attributes[].name`.
- **Literals (severity values, actor roles) never appear as path nodes.** When
  a question filters on severity or asks "who", the path ends at the rule or
  action node and the literal facet is part of the expected answer.
- The documented path is **one witness chain** — the minimal evidence walk a
  correct answer must be able to produce. The expected answer usually covers
  the witness plus its siblings (e.g. every block rule on the same step, not
  just the one in the path).

Question archetypes are deliberately varied across the 30 cases:

| archetype | shape |
|---|---|
| upstream-impact | "if X changes/fails, which downstream steps or processes break?" |
| root-cause | "which chain of events leads to X?" |
| authorization | "who can ultimately cause X to happen / must sign off?" |
| data-lineage | "which attributes of object A flow into artifact B, and via what?" |
| compliance | "which block-severity rules transitively guard process P?" |
| blast-radius | "which objects does process P touch through its actions?" |

Per domain: 3 use cases, 30 total. Hop counts range from 3 to 7.

---

## 1. Commercial lending — `fixtures/ontology-golden/commercial-lending.json`

### UC commercial-lending-1 — Block rules transitively gating fund disbursement (compliance, 4 hops)

- **EN:** A borrower asks why their drawdown has not been funded. Which block-severity rules transitively gate fund disbursement within the drawdown-servicing process — including rules enforced on the upstream eligibility check?
- **ZH:** 某借款人询问提款为何迟迟未放款。在提款服务流程中，哪些“阻断级”规则间接卡住了放款环节——包括上游资格审查动作上执行的规则？

```
process:drawdown-servicing
  -[has_step]-> action:disburse-funds
  -[triggered_by]-> event:drawdown.cleared
  -[produced_by]-> action:check-drawdown-eligibility
  -[guarded_by]-> rule:r05-no-drawdown-during-breach
```

**Expected answer:** Walking the process to `disburse-funds` surfaces its direct block guard `rule:r04-no-funding-until-booked-and-perfected` (`rule:r17` is warn-only); stepping upstream through `event:drawdown.cleared` to the eligibility check adds `rule:r05-no-drawdown-during-breach` and `rule:r06-drawdown-within-commitment`. The block-severity set is r04, r05, r06.

### UC commercial-lending-2 — Event chain behind a margin call (root-cause, 5 hops)

- **EN:** A margin call notice was just issued against a facility's collateral. Trace the event chain backwards: which sequence of monitoring events and actions ultimately leads to a margin call?
- **ZH:** 某授信额度的抵押品刚被发出追加保证金通知。请回溯事件链：是哪一连串的监测事件和动作最终导致追加保证金通知的发出？

```
event:margin-call.issued
  -[produced_by]-> action:issue-margin-call
  -[triggered_by]-> event:covenant.breached
  -[produced_by]-> action:evaluate-covenant
  -[triggered_by]-> event:covenant.test-due
  -[produced_by]-> action:schedule-covenant-test
```

**Expected answer:** The root cause runs back through `covenant.breached` (raised by `evaluate-covenant` under the r11 DSCR / r12 leverage thresholds) to the quarterly test-due event raised by `schedule-covenant-test` under `rule:r10`. The answer is the schedule → evaluate → breach → margin-call chain inside `process:quarterly-covenant-monitoring`.

### UC commercial-lending-3 — Collateral attribute lineage into the margin-call event (data-lineage, 3 hops)

- **EN:** Which collateral attributes (for example the appraised fair value) ultimately surface in the margin-call.issued event, and through which action do they flow?
- **ZH:** 抵押品对象的哪些属性（例如评估公允价值）最终会体现在“追加保证金已发出”事件中？它们经由哪个动作流转？

```
objectType:collateral.fair_value
  -[has_attribute]-> objectType:collateral
  -[consumes]-> action:issue-margin-call
  -[emits]-> event:margin-call.issued
```

**Expected answer:** `fair_value` (with `appraisal_date` and `perfection_status` as context) belongs to the collateral object, which `issue-margin-call` consumes alongside the covenant before emitting `margin-call.issued`; the resulting margin-call-notice carries `shortfall_amount` and `cure_deadline`.

---

## 2. Energy grid outage — `fixtures/ontology-golden/energy-grid-outage.json`

### UC energy-grid-outage-1 — Root cause of a regulatory deadline breach (root-cause, 7 hops)

- **EN:** The regulator records a deadline breach on an outage filing. Reconstruct the full chain of events and actions leading from the reporting clock started on a confirmed outage to the regulatory.deadline-breached event.
- **ZH:** 监管机构记录到一次停电报送超期。请还原完整的事件与动作链条：从停电确认后监管时钟启动，到“监管期限已突破”事件，中间经过了哪些环节？

```
event:regulatory.deadline-breached
  -[produced_by]-> action:submit-regulatory-report
  -[triggered_by]-> event:regulatory-report.compiled
  -[produced_by]-> action:compile-regulatory-report
  -[triggered_by]-> event:regulatory-report.opened
  -[produced_by]-> action:open-regulatory-report
  -[triggered_by]-> event:regulatory.clock-started
  -[produced_by]-> action:evaluate-reportability
```

**Expected answer:** The breach event is emitted by `submit-regulatory-report`; tracing triggers backwards reaches compile → open → the clock-started event raised by `evaluate-reportability` under `rule:outage-reportable-threshold-1h` — identifying every stage of `process:outage-regulatory-reporting` where the filing could have stalled.

### UC energy-grid-outage-2 — Physical blast radius of outage scoping (blast-radius, 3 hops)

- **EN:** Beyond the outage record itself, which physical network objects does the detect-to-restore process reach when an operator scopes an outage — up to the parent substation?
- **ZH:** 除停电事件记录本身外，“检测到恢复”流程在调度员定界停电范围时，会触达哪些实体电网对象——一直追溯到上级变电站？

```
process:detect-to-restore
  -[has_step]-> action:scope-outage
  -[consumes]-> objectType:feeder
  -[parents]-> objectType:substation        (traversed inverse: substation parents feeder)
```

**Expected answer:** `scope-outage` consumes the outage-event, feeder, substation and service-point objects; following the feeder through `rel:substation-parents-feeder` shows the blast radius spans feeder, substation, service points and — via `belongs_to` — customers.

### UC energy-grid-outage-3 — The process bound by the critical-care dispatch rule (compliance, 4 hops)

- **EN:** Life-support customers are protected by a 2-hour crew-dispatch rule. Which operational process must satisfy that rule, and through which confirming event does the rule attach to it?
- **ZH:** 维生设备客户受“2 小时内派遣抢修班组”规则保护。哪个运营流程必须满足该规则？该规则又是通过哪个确认事件挂接到流程上的？

```
objectType:customer
  -[applies_to]-> rule:critical-care-dispatch-2h     (traversed inverse: rule applies_to customer)
  -[triggered_by]-> event:outage.confirmed
  -[produced_by]-> action:scope-outage
  -[has_step]-> process:detect-to-restore            (traversed inverse: process has_step action)
```

**Expected answer:** The rule applies to customer/crew/outage-event and fires on `outage.confirmed`, which `scope-outage` emits inside `process:detect-to-restore`; `action:dispatch-crew` in the same process carries the rule as a precondition, so detect-to-restore is the governed process.

---

## 3. Healthcare care pathway — `fixtures/ontology-golden/healthcare-care-pathway.json`

### UC healthcare-care-pathway-1 — Where a missing prior authorization stalls the revenue cycle (upstream-impact, 3 hops)

- **EN:** If a prior authorization is missing or expired, which downstream revenue-cycle process stalls, and at exactly which step?
- **ZH:** 如果事前授权缺失或已过期，下游哪个收入循环流程会被卡住？具体卡在哪一步？

```
objectType:prior-authorization
  -[applies_to]-> rule:r05-claim-requires-linked-auth   (inverse)
  -[guarded_by]-> action:assemble-claim                 (inverse)
  -[has_step]-> process:charge-capture-to-claim         (inverse)
```

**Expected answer:** `rule:r05-claim-requires-linked-auth` requires a linked approved authorization on auth-required procedures and guards `assemble-claim`, so `process:charge-capture-to-claim` halts at claim assembly; the end-to-end `process:care-pathway-revenue-cycle` inherits the same stall via the shared step.

### UC healthcare-care-pathway-2 — Event chain behind a payer appeal (root-cause, 5 hops)

- **EN:** An appeal was just submitted to a payer. Trace the event chain backwards: what had to happen, step by step, for the appeal to exist?
- **ZH:** 刚刚向付款方提交了一份申诉。请回溯事件链：这份申诉的产生，前置必须依次发生哪些事件和动作？

```
event:appeal.submitted
  -[produced_by]-> action:submit-appeal
  -[triggered_by]-> event:denial.assigned
  -[produced_by]-> action:triage-denial
  -[triggered_by]-> event:claim.denied
  -[produced_by]-> action:post-remittance
```

**Expected answer:** appeal.submitted ← submit-appeal ← denial.assigned ← triage-denial ← claim.denied ← post-remittance; the answer names the remittance posting as the origin and the pacing rules `r17-denial-routing-sla-2d` and `r18-appeal-deadline-60d` along the chain.

### UC healthcare-care-pathway-3 — CPT code lineage from procedure to claim (data-lineage, 4 hops)

- **EN:** Which procedure attributes (such as the CPT code) flow into the billed claim, and along which action-and-relationship path do they travel?
- **ZH:** 手术/操作对象的哪些属性（如 CPT 编码）会流入最终提交的理赔单？它们沿着哪条“动作 + 关系”路径流转？

```
objectType:procedure.cpt_code
  -[has_attribute]-> objectType:procedure    (inverse)
  -[consumes]-> action:generate-charge       (inverse)
  -[produces]-> objectType:charge
  -[includes]-> objectType:claim             (inverse: claim includes charge)
```

**Expected answer:** `cpt_code` (together with `billed_amount`) rides the procedure into `generate-charge`, which produces the charge that the claim includes (`rel:claim-includes-charge`). Lineage = attribute → procedure → charge-router action → charge → claim.

---

## 4. HR talent acquisition — `fixtures/ontology-golden/hr-talent-acquisition.json`

### UC hr-talent-acquisition-1 — Who can ultimately cause a hire (authorization, 5 hops)

- **EN:** Who can ultimately cause a candidate to become a hired worker? Walk the chain of actions and triggering events back from candidate.hired and identify each acting role.
- **ZH:** 究竟是谁能够最终促成候选人正式入职？请从“候选人已录用”事件沿动作与触发事件链回溯，并指出每一步的执行角色。

```
event:candidate.hired
  -[produced_by]-> action:convert-to-hire
  -[triggered_by]-> event:background-check.completed
  -[produced_by]-> action:initiate-background-check
  -[triggered_by]-> event:offer.accepted
  -[produced_by]-> action:record-offer-response
```

**Expected answer:** The HR Business Partner (`convert-to-hire`) acts only after the Recruiter-initiated background check completes, which itself requires the candidate's offer acceptance (`record-offer-response`); `rule:clear-background-before-hire` is the final block gate on the conversion.

### UC hr-talent-acquisition-2 — Block rules guarding above-band offers (compliance, 3 hops)

- **EN:** Which block-severity rules transitively guard the offer-approval process when an offer is priced above the salary band?
- **ZH:** 当 offer 薪资高于薪酬带宽时，哪些“阻断级”规则间接守住 offer 审批流程？

```
process:offer-approval
  -[has_step]-> action:approve-offer
  -[guarded_by]-> rule:above-band-vp-approval
  -[applies_to]-> objectType:salary-band
```

**Expected answer:** `approve-offer` is guarded by `above-band-vp-approval` (VP sign-off above band) and `in-band-hm-hrbp-approval`; upstream steps of the same process add `below-band-needs-exception`, `signon-bonus-cap` and `offer-requires-approved-requisition` — all block severity.

### UC hr-talent-acquisition-3 — Ripple effect of rezoning a salary band (upstream-impact, 4 hops)

- **EN:** Compensation rezones a salary band. Which downstream offer steps and which process are impacted through the actions that consume the band?
- **ZH:** 薪酬团队调整了某薪酬带宽（salary band）。通过消费该带宽数据的动作，下游哪些 offer 环节和流程会受到影响？

```
objectType:salary-band
  -[consumes]-> action:draft-offer           (inverse)
  -[emits]-> event:offer.drafted
  -[consumed_by]-> action:validate-offer-band
  -[has_step]-> process:offer-approval       (inverse)
```

**Expected answer:** Both `draft-offer` and `validate-offer-band` consume the band, so a rezoning ripples through `offer.drafted` into band validation and the whole `process:offer-approval`; offers already drafted may flip `band_status` and re-route approvals under the above-band/below-band rules.

---

## 5. Insurance claims & underwriting — `fixtures/ontology-golden/insurance-claims-underwriting.json`

### UC insurance-claims-underwriting-1 — Final authority over above-limit claim payments (authorization, 3 hops)

- **EN:** Who can ultimately authorize a claim payment that exceeds the handling adjuster's authority limit, and which object carries that limit?
- **ZH:** 当理赔付款金额超出经办理算员的权限上限时，最终由谁授权？该权限上限记录在哪个对象上？

```
event:payment.issued
  -[produced_by]-> action:issue-claim-payment
  -[guarded_by]-> rule:br-05-payment-escalation
  -[applies_to]-> objectType:adjuster
```

**Expected answer:** `payment.issued` is emitted by `issue-claim-payment`, guarded by `br-04-adjuster-payment-authority` (the limit itself) and `br-05-payment-escalation` (escalation above the limit); the `authority_limit` attribute lives on the adjuster object.

### UC insurance-claims-underwriting-2 — Event chain behind a subrogation file (root-cause, 5 hops)

- **EN:** A subrogation recovery file was opened. What chain of claim-settlement events had to occur first?
- **ZH:** 刚立了一个代位追偿案。此前必须依次发生哪些理赔结案事件？

```
event:subrogation.opened
  -[produced_by]-> action:open-subrogation
  -[triggered_by]-> event:claim.closed
  -[produced_by]-> action:close-exposure
  -[triggered_by]-> event:payment.issued
  -[produced_by]-> action:issue-claim-payment
```

**Expected answer:** subrogation.opened ← open-subrogation (gated by `br-19-recovery-preconditions`) ← claim.closed ← close-exposure (`br-13-no-close-with-reserve`) ← payment.issued ← issue-claim-payment.

### UC insurance-claims-underwriting-3 — Policy-side blast radius of coverage verification (blast-radius, 4 hops)

- **EN:** When the FNOL-to-settlement process verifies coverage, which policy-side objects does it reach, down to the exposure that eventually pays out?
- **ZH:** FNOL 到赔付结案的流程在核实承保范围时，会触达哪些保单侧对象？一直延伸到最终实际赔付的责任敞口（exposure）。

```
process:fnol-to-settlement
  -[has_step]-> action:verify-coverage
  -[consumes]-> objectType:policy
  -[contains]-> objectType:coverage
  -[covers]-> objectType:exposure            (inverse: exposure covers coverage)
```

**Expected answer:** `verify-coverage` consumes the claim and the policy; the policy contains coverages that exposures cover against, so the blast radius spans policy, coverage and exposure — with reserves and claim payments hanging off the exposure downstream.

---

## 6. Logistics freight fulfillment — `fixtures/ontology-golden/logistics-freight-fulfillment.json`

### UC logistics-freight-fulfillment-1 — Block rules gating international departure (compliance, 3 hops)

- **EN:** Which block-severity rules transitively gate an international consignment's departure inside the order-to-delivery process?
- **ZH:** 在“订单到交付”流程中，哪些“阻断级”规则间接卡住国际货件的出运环节？

```
process:order-to-delivery
  -[has_step]-> action:file-customs-declaration
  -[guarded_by]-> rule:controlled-goods-license
  -[applies_to]-> objectType:customs-declaration
```

**Expected answer:** `file-customs-declaration` carries three block guards — `formal-entry-threshold`, `customs-filing-lead-time` and `controlled-goods-license` — all applying to the customs-declaration/consignment pair; `pick-and-pack` then waits on `customs.cleared`, so the whole departure leg is transitively gated.

### UC logistics-freight-fulfillment-2 — Downstream breakage from a carrier insurance lapse (upstream-impact, 4 hops)

- **EN:** A carrier's cargo insurance lapses below the high-value threshold. Which fulfillment steps break downstream of tendering?
- **ZH:** 某承运商的货物保险额度降到高货值门槛以下。运输招标（tender）之后的哪些履约环节会随之中断？

```
objectType:carrier
  -[applies_to]-> rule:high-value-insured-carrier   (inverse)
  -[guarded_by]-> action:tender-shipment            (inverse)
  -[emits]-> event:shipment.tendered
  -[consumed_by]-> action:pick-and-pack
```

**Expected answer:** `high-value-insured-carrier` blocks `tender-shipment` for high-value consignments, so `shipment.tendered` never fires and both of its consumers — `file-customs-declaration` and `pick-and-pack` — stall, effectively freezing the rest of `process:order-to-delivery` for affected shipments.

### UC logistics-freight-fulfillment-3 — Event chain behind a service-failure claim (root-cause, 7 hops)

- **EN:** A service-failure claim was submitted against a carrier. Reconstruct the full event chain back to the tracking signal that started it.
- **ZH:** 针对某承运商提交了一笔服务失败索赔。请把事件链完整回溯到最初触发它的在途跟踪信号。

```
event:claim.submitted
  -[produced_by]-> action:raise-service-failure-claim
  -[triggered_by]-> event:exception.classified
  -[produced_by]-> action:classify-exception
  -[triggered_by]-> event:exception.opened
  -[produced_by]-> action:open-exception
  -[triggered_by]-> event:sla.breached
  -[produced_by]-> action:ingest-tracking-event
```

**Expected answer:** claim.submitted ← raise-service-failure-claim ← exception.classified ← classify-exception ← exception.opened ← open-exception (`exception-auto-open-15min`) ← sla.breached ← ingest-tracking-event, which reads EDI status codes against the lane SLA.

---

## 7. Manufacturing BOM & quality — `fixtures/ontology-golden/manufacturing-bom-quality.json`

### UC manufacturing-bom-quality-1 — Work-order impact of a safety-part engineering change (upstream-impact, 5 hops)

- **EN:** An approved engineering change revises a safety-classified part. Which open work orders are forced into revalidation, and along which path does the impact propagate?
- **ZH:** 一项已批准的工程变更修订了某安全件。哪些在制工单会被强制重新校验？影响沿哪条路径传导？

```
objectType:part
  -[affects]-> objectType:engineeringChange      (inverse: engineeringChange affects part)
  -[consumes]-> action:set-revision-effectivity  (inverse)
  -[emits]-> event:revision.became.effective
  -[consumed_by]-> action:revalidate-open-work-orders
  -[produces]-> objectType:workOrder
```

**Expected answer:** The engineering change affecting the part feeds `set-revision-effectivity`; `revision.became.effective` then drives `revalidate-open-work-orders`, which re-checks every open work order against `rule:R-01-workorder-effective-revision` (work orders must reference the effective BOM revision).

### UC manufacturing-bom-quality-2 — Sign-off authority for use-as-is dispositions (authorization, 3 hops)

- **EN:** Who must sign off before a 'use-as-is' or 'rework' disposition can release nonconforming material, and where in the CAPA process does that gate sit?
- **ZH:** “让步接收”或“返工”处置要放行不合格品，必须由谁签批？该关卡位于 CAPA 流程的哪个环节？

```
process:nonconformance-disposition-capa
  -[has_step]-> action:disposition-non-conformance
  -[guarded_by]-> rule:R-13-useasis-rework-qm-signoff
  -[applies_to]-> objectType:disposition
```

**Expected answer:** `disposition-non-conformance` (second step of the CAPA process) is guarded by `R-13` (Quality Manager sign-off), plus `R-19-disposition-authorization` and `R-02-quarantine-blocks-release`; the Quality Engineer executes but the Quality Manager authorizes.

### UC manufacturing-bom-quality-3 — Event chain behind a CAPA (root-cause, 7 hops)

- **EN:** A corrective action (CAPA) was opened. Trace the quality event chain back to the inspection usage decision that started it.
- **ZH:** 新开了一项纠正预防措施（CAPA）。请把质量事件链回溯到最初触发它的检验使用决策。

```
event:corrective.action.opened
  -[produced_by]-> action:open-corrective-action
  -[triggered_by]-> event:non.conformance.dispositioned
  -[produced_by]-> action:disposition-non-conformance
  -[triggered_by]-> event:non.conformance.assigned
  -[produced_by]-> action:triage-non-conformance
  -[triggered_by]-> event:non.conformance.opened
  -[produced_by]-> action:post-usage-decision
```

**Expected answer:** CAPA ← open-corrective-action ← NC dispositioned ← disposition-non-conformance ← NC assigned ← triage-non-conformance (24h owner rule R-12, safety escalation R-15) ← NC opened ← post-usage-decision rejecting an inspection lot.

---

## 8. Public-sector permitting — `fixtures/ontology-golden/public-sector-permitting.json`

### UC public-sector-permitting-1 — Who can ultimately cause permit issuance (authorization, 5 hops)

- **EN:** Who can ultimately cause a permit to be issued? Trace from permit.issued back through payment and determination, naming the roles and the approval gates.
- **ZH:** 究竟是谁能最终促成许可证签发？请从“许可证已签发”事件回溯付款与裁定环节，指出各步角色和审批关卡。

```
event:permit.issued
  -[produced_by]-> action:issue-permit
  -[triggered_by]-> event:payment.cleared
  -[produced_by]-> action:collect-payment
  -[triggered_by]-> event:determination.recorded
  -[produced_by]-> action:record-determination
```

**Expected answer:** The PBE-CMS system issues only after the applicant's payment clears (`payment-cleared-before-issuance`), which follows the caseworker's recorded determination — itself gated by `supervisor-approval-threshold` for high benefit values and `denial-must-cite-criterion`.

### UC public-sector-permitting-2 — Block rules protecting benefits during appeal (compliance, 3 hops)

- **EN:** Which block-severity rules transitively protect an existing benefit while an appeal is in flight in the determination-to-appeal process?
- **ZH:** 在“裁定到申诉”流程中，申诉期间有哪些“阻断级”规则间接保障既有待遇不被削减？

```
process:determination-to-appeal
  -[has_step]-> action:file-appeal
  -[guarded_by]-> rule:pause-reduction-on-appeal
  -[applies_to]-> objectType:case
```

**Expected answer:** `file-appeal` is guarded by `pause-reduction-on-appeal` (no reduction while the appeal is pending) and `appeal-filing-window`; the `decide-appeal` step adds `determination-records-ruleset-version` (block) and `appeal-decision-time-limit` (warn).

### UC public-sector-permitting-3 — Household income lineage into determinations (data-lineage, 4 hops)

- **EN:** Which household attributes (such as annual income) flow into an eligibility determination, and which criterion citation does the determination end up referencing?
- **ZH:** 家庭对象的哪些属性（如年收入）会流入资格裁定？该裁定最终引用的是哪个资格准则条款？

```
objectType:household.annual_income
  -[has_attribute]-> objectType:household    (inverse)
  -[consumes]-> action:evaluate-eligibility  (inverse)
  -[produces]-> objectType:determination
  -[cites]-> objectType:eligibility-criterion
```

**Expected answer:** `annual_income` and `household_size` ride the household object into `evaluate-eligibility` (where `income-threshold-ineligible` applies), producing a determination whose `decisive_criterion_id` and `ruleset_version` cite the eligibility criterion via `rel:determination-cites-criterion`.

---

## 9. Retail order-to-cash — `fixtures/ontology-golden/retail-order-to-cash.json`

### UC retail-order-to-cash-1 — How an overdue invoice freezes new orders (upstream-impact, 5 hops)

- **EN:** An invoice on a customer's account goes overdue. Which automated chain places new orders on hold, and which object records the freeze?
- **ZH:** 某客户账上的一张发票逾期了。哪条自动化链路会冻结其新订单？冻结记录落在哪个对象上？

```
objectType:invoice
  -[applies_to]-> rule:no-order-when-invoice-overdue  (inverse)
  -[guarded_by]-> action:screen-order-for-credit      (inverse)
  -[emits]-> event:credit.hold.placed
  -[consumed_by]-> action:place-credit-hold
  -[produces]-> objectType:creditHold
```

**Expected answer:** The overdue invoice trips `no-order-when-invoice-overdue` at the OMS credit gate; `credit.hold.placed` drives `place-credit-hold`, which produces a creditHold that freezes the order (`rel:creditHold-freezes-order`) until the Credit Manager resolves it under `credit-hold-override-authority`.

### UC retail-order-to-cash-2 — Event chain behind a customer refund (root-cause, 5 hops)

- **EN:** A refund was just issued to a customer. What chain of return events had to complete first?
- **ZH:** 刚给客户开出了一笔退款。此前必须依次完成哪些退货事件？

```
event:refund.issued
  -[produced_by]-> action:issue-refund
  -[triggered_by]-> event:return.received
  -[produced_by]-> action:receive-return
  -[triggered_by]-> event:return.authorized
  -[produced_by]-> action:authorize-return
```

**Expected answer:** refund.issued ← issue-refund (`large-refund-manager-approval`) ← return.received ← receive-return ← return.authorized ← authorize-return, which itself requires a delivered shipment under `return-requires-delivered-shipment`.

### UC retail-order-to-cash-3 — Financial blast radius of the refund step (blast-radius, 3 hops)

- **EN:** Beyond the returned line item itself, which financial objects does the returns-and-refunds process touch when the refund step runs?
- **ZH:** 除被退货的订单行本身之外，退货退款流程在执行退款环节时还会触达哪些财务对象？

```
process:returns-and-refunds
  -[has_step]-> action:issue-refund
  -[consumes]-> objectType:invoice
  -[settled_by]-> objectType:payment
```

**Expected answer:** `issue-refund` consumes the return and the original invoice and produces a payment (refund or store credit) plus customer updates; via `rel:invoice-settled-by-payment` the blast radius covers invoice, payment and the customer's `store_credit` balance.

---

## 10. SaaS subscription & entitlement — `fixtures/ontology-golden/saas-subscription-entitlement.json`

### UC saas-subscription-entitlement-1 — Billing-failure chain behind a churn (root-cause, 7 hops)

- **EN:** A subscription was cancelled (churned). Reconstruct the billing-failure chain back to the original payment failure.
- **ZH:** 某订阅最终被取消（流失）。请把账务失败链完整回溯到最初的那笔扣款失败。

```
event:subscription.cancelled
  -[produced_by]-> action:churn-subscription
  -[triggered_by]-> event:subscription.suspended
  -[produced_by]-> action:suspend-subscription
  -[triggered_by]-> event:dunning.exhausted
  -[produced_by]-> action:run-dunning
  -[triggered_by]-> event:payment.failed
  -[produced_by]-> action:collect-payment
```

**Expected answer:** cancelled ← churn-subscription (`churn-after-30-days`) ← suspended ← suspend-subscription (`suspend-on-grace-expiry`) ← dunning.exhausted ← run-dunning (`dunning-3-retries-10-days`) ← payment.failed ← collect-payment.

### UC saas-subscription-entitlement-2 — Ripple effect of changing plan feature keys (upstream-impact, 5 hops)

- **EN:** Product changes a plan's feature_keys. Which entitlement-drift machinery does that change reach, and which rule finally fires?
- **ZH:** 产品团队修改了某套餐的 feature_keys。这一变更会波及哪条权益漂移检测链路？最终触发的是哪条规则？

```
objectType:plan.feature_keys
  -[has_attribute]-> objectType:plan        (inverse)
  -[defines]-> objectType:entitlement
  -[consumes]-> action:reconcile-entitlements  (inverse)
  -[emits]-> event:entitlement.drift_detected
  -[triggered_by]-> rule:entitlements-match-plan  (inverse: rule triggered_by event)
```

**Expected answer:** `feature_keys` define the entitlements the plan grants (`rel:plan-defines-entitlement`); `reconcile-entitlements` compares actual entitlements to the plan and emits `entitlement.drift_detected`, which triggers `entitlements-match-plan` (block) and the `drift-remediation-sla` provisioning tasks.

### UC saas-subscription-entitlement-3 — Financial preconditions for revenue recognition (compliance, 4 hops)

- **EN:** Which upstream financial conditions must hold before revenue can be recognized on a subscription, and which settled object closes the loop?
- **ZH:** 在订阅上确认收入之前，必须满足哪些上游财务条件？闭环最终落在哪个已结清对象上？

```
event:revenue.recognized
  -[produced_by]-> action:recognize-revenue
  -[guarded_by]-> rule:no-revenue-before-payment
  -[applies_to]-> objectType:payment
  -[settled_by]-> objectType:invoice        (inverse: invoice settled_by payment)
```

**Expected answer:** `recognize-revenue` is guarded by `no-revenue-before-payment`, which applies to subscription, invoice and payment; the payment must settle the issued invoice (`rel:invoice-settled-by-payment`) before Finance recognizes revenue.

---

## Verification

Every hop path above is mirrored 1:1 in `fixtures/inference-use-cases.json` and
was machine-verified against the golden fixtures: all even-position elements
resolve to real node ids (attribute pseudo-ids resolve to a real object id plus
a real `attributes[].name`), all odd-position elements are predicates from the
closed vocabulary or relationship verb names present in that fixture, and every
adjacent `(node, predicate, node)` pair exists as a projected triple (in one of
its two orientations). Re-verify after editing either file by rebuilding the
§3.1 projection per fixture and replaying each `hopPath` — any miss means an id
or an edge drifted.
