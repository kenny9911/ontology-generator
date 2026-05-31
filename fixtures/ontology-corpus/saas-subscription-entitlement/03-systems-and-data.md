# Systems & Data Reference — Subscription & Entitlement

**Document ID:** ARCH-SOR-009
**Version:** 2.6 (effective 2026-04-01)
**Owner:** Platform Engineering, with RevOps and Finance
**Companion documents:** `01-process-sop.md` (SOP-REVOPS-014), `02-business-rules-policy.md` (POL-ENT-2026)

---

## 1. Systems of Record (SoR)

| System | Role | Authoritative Objects (对象) |
|---|---|---|
| **Salesforce CRM** | Commercial relationship of record | `Account`, `Opportunity`, `Contract`, `RenewalOpportunity` |
| **Stripe Billing** | Billing & metering of record | `Subscription`, `Invoice`, `Payment`, `UsageRecord` |
| **Entitlement Service** (internal) | Plan→feature mapping & provisioning orchestration | `Plan`, `Entitlement`, `ProvisioningTask` |
| **LaunchDarkly** | Runtime feature-flag enforcement | projection of `Entitlement` (read model) |

A single object has exactly one SoR; all other systems hold projections that must reconcile back to it (POL-ENT-2026 R-01).

## 2. Key Data Entities & Attributes

### 2.1 Account (Salesforce — `Account`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `account_id` | UUID | **Primary key** |
| `legal_name` | string | |
| `tier` | enum {standard, enterprise, unlimited} | drives R-06 |
| `net_terms` | boolean | drives R-02 exception |
| `csm_owner_id` | UUID | FK → user |

### 2.2 Contract (Salesforce — `Contract`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `contract_id` | UUID | **Primary key** |
| `account_id` | UUID | **FK → Account** |
| `plan_code` | string | **FK → Plan** |
| `term_start` | date | |
| `term_end` | date | drives R-08, R-09 |
| `term_months` | integer | min 12 per R-18 |
| `seat_count` | integer | drives R-17 |
| `discount_pct` | decimal | drives R-07 |
| `tier` | enum {standard, enterprise, unlimited} | |

### 2.3 Subscription (Stripe — `Subscription`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `subscription_id` | UUID | **Primary key** |
| `account_id` | UUID | **FK → Account** |
| `contract_id` | UUID | **FK → Contract** |
| `plan_code` | string | **FK → Plan** |
| `status` | enum {trialing, active, grace, suspended, cancelled} | lifecycle (R-09, R-10, R-13, R-20) |
| `current_period_start` | datetime | |
| `current_period_end` | datetime | drives R-04, R-16 |
| `renewed_through` | date | |

### 2.4 Plan (Entitlement Service — `Plan`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `plan_code` | string | **Primary key** |
| `display_name` | string | |
| `included_quota` | integer | unit per `quota_unit`; drives R-03 |
| `quota_unit` | enum {api_calls, gb, seats} | |
| `tier` | enum {standard, enterprise, unlimited} | drives R-06 |
| `feature_keys` | array<string> | maps to Entitlement grants |

### 2.5 Entitlement (Entitlement Service — `Entitlement`; projected to LaunchDarkly)
| Attribute | Type | Key / Notes |
|---|---|---|
| `entitlement_id` | UUID | **Primary key** |
| `subscription_id` | UUID | **FK → Subscription** |
| `feature_key` | string | flag enforced in LaunchDarkly |
| `quota_limit` | integer | nullable for unlimited tier |
| `seat_grant` | integer | ≤ Contract.seat_count per R-17 |
| `state` | enum {granted, scheduled_revoke, revoked} | drives R-04, R-10, R-12 |
| `effective_at` | datetime | |

### 2.6 UsageRecord (Stripe — `UsageRecord`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `usage_id` | UUID | **Primary key** |
| `subscription_id` | UUID | **FK → Subscription** |
| `metric` | enum {api_calls, gb, seats} | matches Plan.quota_unit |
| `quantity` | integer | |
| `recorded_at` | datetime | |

### 2.7 Invoice (Stripe — `Invoice`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `invoice_id` | UUID | **Primary key** |
| `subscription_id` | UUID | **FK → Subscription** (required, R-15) |
| `period_start` | date | |
| `period_end` | date | |
| `subtotal` | decimal | |
| `overage_amount` | decimal | from R-03 calc |
| `status` | enum {open, paid, failed, void} | |
| `line_items` | array<LineItem> | ≥1 required (R-15) |

### 2.8 Payment (Stripe — `Payment`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `payment_id` | UUID | **Primary key** |
| `invoice_id` | UUID | **FK → Invoice** |
| `amount` | decimal | |
| `status` | enum {succeeded, failed} | drives R-11, R-12, R-19 |
| `attempt_no` | integer | 1–3 per dunning (R-11) |
| `paid_at` | datetime | |

### 2.9 RenewalOpportunity (Salesforce — `RenewalOpportunity`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `renewal_id` | UUID | **Primary key** |
| `subscription_id` | UUID | **FK → Subscription** |
| `stage` | enum {open, won, lost} | R-13 closes as lost |
| `opened_at` | date | T-90 per R-08 |
| `target_close` | date | |

### 2.10 ProvisioningTask (Entitlement Service — `ProvisioningTask`)
| Attribute | Type | Key / Notes |
|---|---|---|
| `task_id` | UUID | **Primary key** |
| `subscription_id` | UUID | **FK → Subscription** |
| `type` | enum {grant, revoke, reconcile} | |
| `status` | enum {pending, completed, failed} | |

## 3. System Integrations

| Integration | Direction | Mechanism | Payload |
|---|---|---|---|
| Salesforce → Entitlement Service | push | webhook on `ContractSigned` | Contract + Plan code |
| Entitlement Service → Stripe Billing | call | API on `SubscriptionCreated` | Subscription + first charge |
| Entitlement Service → LaunchDarkly | push | flag API on grant/revoke | Entitlement feature_keys |
| Stripe Billing → RevOps Automation | push | webhook on invoice/payment | Invoice, Payment events |
| Product runtime → Stripe Billing | push | metered usage API | UsageRecord rows |
| RevOps Automation → Salesforce | call | API on renewal/churn | RenewalOpportunity stage |

## 4. Events Exchanged Between Systems (事件)

| Event | Emitted by | Consumed by | Payload key | SOP step |
|---|---|---|---|---|
| `ContractSigned` | Salesforce | Entitlement Service, RevOps | `contract_id` | 1.3 |
| `SubscriptionCreated` | Stripe | Entitlement Service | `subscription_id` | 1.4 |
| `InvoiceIssued` | Stripe | RevOps, Finance | `invoice_id` | 1.4, 2.3 |
| `EntitlementGranted` | Entitlement Service | LaunchDarkly | `entitlement_id` | 1.5, 3.3, 4.3 |
| `EntitlementRevoked` | Entitlement Service | LaunchDarkly | `entitlement_id` | 3.3, 4.2 |
| `ProvisioningCompleted` | Entitlement Service | RevOps | `task_id` | 1.5 |
| `EntitlementDriftDetected` | RevOps | RevOps lead | `subscription_id` | 1.6 |
| `UsageRecorded` | Product runtime | Stripe | `usage_id` | 2.1 |
| `OverageDetected` | RevOps | Stripe | `subscription_id` | 2.2 |
| `PaymentSucceeded` | Stripe | RevOps, Finance, Entitlement Service | `payment_id` | 2.4, 4.3 |
| `PaymentFailed` | Stripe | RevOps | `invoice_id` | 2.4, 4.1 |
| `RenewalOpportunityCreated` | RevOps | Salesforce, CSM | `renewal_id` | 3.1 |
| `GracePeriodStarted` | RevOps | Entitlement Service | `subscription_id` | 3.4 |
| `SubscriptionSuspended` | Entitlement Service | RevOps, LaunchDarkly | `subscription_id` | 4.2 |
| `SubscriptionReinstated` | Entitlement Service | RevOps | `subscription_id` | 4.3 |
| `SubscriptionCancelled` | RevOps | Salesforce | `subscription_id` | 4.4 |

## 5. Reconciliation

Nightly, RevOps Automation compares each active `Subscription`'s `Plan.feature_keys` against the granted `Entitlement` set in LaunchDarkly and emits `EntitlementDriftDetected` on any mismatch, enforcing POL-ENT-2026 R-01 and R-05.
