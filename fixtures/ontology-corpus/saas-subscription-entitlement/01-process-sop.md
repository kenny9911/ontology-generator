# Standard Operating Procedure — Subscription & Entitlement Lifecycle
## Quote-to-Provision, Renewal-to-Expansion, Usage-to-Invoice, and Suspension-to-Recovery

**Document ID:** SOP-REVOPS-014
**Version:** 4.2 (effective 2026-04-01)
**Owner:** Revenue Operations (RevOps), in partnership with Customer Success (CS) and Finance
**Classification:** Internal — Confidential
**Related documents:** `02-business-rules-policy.md` (POL-ENT-2026), `03-systems-and-data.md` (ARCH-SOR-009), `Plan & Packaging Spec.md`, `Order Form template.pdf`, `Renewal & Expansion Playbook.docx`

---

### 1. Purpose & Scope

This SOP defines the end-to-end operating procedure by which our B2B SaaS business converts a signed commercial agreement into provisioned product access, keeps billing and feature **Entitlements (权益)** in sync with the contracted **Plan (套餐)**, meters and bills usage, renews and expands subscriptions, and handles non-payment through suspension and recovery.

It governs four processes (流程):

- **P1 — Quote to Provision / 报价到开通**: from an approved Opportunity through a signed Order Form to a live, fully entitled Subscription.
- **P2 — Usage to Invoice / 用量到开票**: continuous metering of consumption against included quota, overage calculation, and invoicing.
- **P3 — Renewal to Expansion / 续约到扩展**: term-end renewal, upgrade/downgrade, and grace/suspension handling.
- **P4 — Suspension to Recovery / 暂停到恢复**: dunning, suspension, reinstatement, and churn on terminal non-payment.

The business **Objects (对象)** in scope are: `Account`, `Contract`, `Subscription`, `Plan`, `Entitlement`, `UsageRecord`, `Invoice`, `Payment`, `RenewalOpportunity`, and `ProvisioningTask`. Systems of record and their data entities are specified in `03-systems-and-data.md`.

### 2. Roles & Systems (Actors)

| Actor | Type | Responsibility |
|---|---|---|
| Account Executive (AE) | Human | Closes the Opportunity; requests Order Form generation. |
| Deal Desk Analyst | Human | Validates pricing, discount, and term against policy. |
| RevOps Automation | System | Orchestrates provisioning; reconciles entitlements. |
| Salesforce CRM | System of record (Account, Opportunity, Contract) | Holds the commercial relationship. |
| Stripe Billing | System of record (Subscription, Invoice, Payment, UsageRecord) | Bills and meters. |
| LaunchDarkly | System of record (Entitlement / feature flags) | Grants/revokes feature access. |
| Entitlement Service | System | Maps Plan → Entitlements; emits provisioning events. |
| Customer Success Manager (CSM) | Human | Owns renewals and expansion conversations. |
| Finance / Revenue Accountant | Human | Reviews recognition against the Subscription. |

### 3. Process P1 — Quote to Provision (报价到开通)

| # | Actor / System | Object(s) touched | Action (consumes → produces) | Triggering / resulting Event(s) |
|---|---|---|---|---|
| 1.1 | Account Executive | `Account`, `Opportunity` | **Create Order Form** — consumes the Closed-Won Opportunity and selected `Plan`; produces a draft `Order Form` linked to the `Account`. | Triggered by `OpportunityClosedWon`; emits `OrderFormDrafted`. |
| 1.2 | Deal Desk Analyst | `Order Form`, `Plan` | **Validate Quote** — consumes the draft Order Form, list price, and discount; produces an approved or rejected quote. Above-threshold discounts require escalation (see POL-ENT-2026 R-07). | Triggered by `OrderFormDrafted`; emits `QuoteApproved` or `QuoteRejected`. |
| 1.3 | Customer (counter-signature) + Salesforce CRM | `Contract` | **Sign Contract** — consumes the approved Order Form; produces an executed `Contract` with term start, term end, and committed quantities. | Triggered by `QuoteApproved`; emits `ContractSigned`. |
| 1.4 | RevOps Automation + Stripe Billing | `Subscription`, `Plan`, `Invoice` | **Create Subscription** — consumes the executed `Contract` and `Plan`; produces an active `Subscription` and the first `Invoice` (the initial term charge). | Triggered by `ContractSigned`; emits `SubscriptionCreated` and `InvoiceIssued`. |
| 1.5 | Entitlement Service + LaunchDarkly | `Entitlement`, `Subscription`, `ProvisioningTask` | **Provision Entitlements** — consumes the `Subscription`'s `Plan` mapping; produces one or more `Entitlement` records (feature flags, quota limits, seat counts) and closes the `ProvisioningTask`. | Triggered by `SubscriptionCreated`; emits `EntitlementGranted` and `ProvisioningCompleted`. |
| 1.6 | RevOps Automation | `Account`, `Subscription`, `Entitlement` | **Reconcile Entitlements** — consumes the live `Entitlement` set and the `Plan` spec; produces a drift report and, if mismatched, a remediation `ProvisioningTask` (see POL-ENT-2026 R-01). | Triggered by `ProvisioningCompleted` (and nightly); emits `EntitlementDriftDetected` when a mismatch exists. |

The provisioning gate: per POL-ENT-2026 R-02, **Provision Entitlements (1.5) must not run before the initial `Invoice` is issued in step 1.4**, except where the `Contract` carries a `net_terms` flag (invoice-on-terms accounts).

### 4. Process P2 — Usage to Invoice (用量到开票)

| # | Actor / System | Object(s) touched | Action (consumes → produces) | Triggering / resulting Event(s) |
|---|---|---|---|---|
| 2.1 | Product runtime + Stripe Billing | `UsageRecord`, `Subscription` | **Record Usage** — consumes metered product events (API calls, seats, GB); produces timestamped `UsageRecord` rows keyed to the `Subscription`. | Triggered continuously by product runtime; emits `UsageRecorded`. |
| 2.2 | RevOps Automation | `UsageRecord`, `Entitlement`, `Plan` | **Calculate Overage** — consumes cumulative `UsageRecord` totals and the `Entitlement` included quota; produces an overage quantity when usage exceeds quota (see POL-ENT-2026 R-03). | Triggered by billing-period close; emits `OverageDetected` when quota is exceeded, otherwise `UsageWithinQuota`. |
| 2.3 | Stripe Billing | `Invoice`, `Subscription`, `UsageRecord` | **Issue Invoice** — consumes the recurring plan charge plus any overage line items; produces the period `Invoice`. | Triggered by `OverageDetected` or period close; emits `InvoiceIssued`. |
| 2.4 | Customer + Stripe Billing | `Payment`, `Invoice` | **Collect Payment** — consumes a payment instrument charge against the open `Invoice`; produces a `Payment` and marks the `Invoice` Paid or Failed. | Triggered by `InvoiceIssued`; emits `PaymentSucceeded` or `PaymentFailed`. |
| 2.5 | Finance / Revenue Accountant | `Subscription`, `Invoice` | **Recognize Revenue** — consumes the `Subscription` term and `Invoice`; produces recognized revenue schedules. | Triggered by `PaymentSucceeded`; emits `RevenueRecognized`. |

### 5. Process P3 — Renewal to Expansion (续约到扩展)

| # | Actor / System | Object(s) touched | Action (consumes → produces) | Triggering / resulting Event(s) |
|---|---|---|---|---|
| 3.1 | RevOps Automation + Salesforce CRM | `Subscription`, `RenewalOpportunity` | **Open Renewal** — consumes a `Subscription` approaching term end; produces a `RenewalOpportunity` 90 days before term-end (see POL-ENT-2026 R-08). | Triggered by `RenewalWindowOpened` (T-90 days); emits `RenewalOpportunityCreated`. |
| 3.2 | Customer Success Manager | `RenewalOpportunity`, `Plan`, `Subscription` | **Process Renewal** — consumes the customer's renewal decision; produces a renewed `Subscription`, an upgrade, or a downgrade. | Triggered by `RenewalOpportunityCreated`; emits `SubscriptionRenewed`, `PlanUpgraded`, or `PlanDowngraded`. |
| 3.3 | Entitlement Service + LaunchDarkly | `Entitlement`, `Subscription`, `Plan` | **Adjust Entitlements** — consumes the new `Plan` mapping; on upgrade produces new `Entitlement` grants immediately, on downgrade schedules revocation of removed features at period end (see POL-ENT-2026 R-04). | Triggered by `PlanUpgraded` / `PlanDowngraded`; emits `EntitlementGranted` or `EntitlementRevoked`. |
| 3.4 | RevOps Automation | `Subscription` | **Enter Grace Period** — consumes a `Subscription` not renewed by its term-end date; produces a 14-day grace state (see POL-ENT-2026 R-09). | Triggered when term-end passes without `SubscriptionRenewed`; emits `GracePeriodStarted`. |

### 6. Process P4 — Suspension to Recovery (暂停到恢复)

| # | Actor / System | Object(s) touched | Action (consumes → produces) | Triggering / resulting Event(s) |
|---|---|---|---|---|
| 4.1 | RevOps Automation | `Invoice`, `Payment`, `Account` | **Run Dunning** — consumes a `PaymentFailed` `Invoice`; produces a dunning schedule of up to 3 retries over 10 days (see POL-ENT-2026 R-11). | Triggered by `PaymentFailed`; emits `DunningStarted` and, on terminal failure, `DunningExhausted`. |
| 4.2 | Entitlement Service + LaunchDarkly | `Subscription`, `Entitlement` | **Suspend Subscription** — consumes a `Subscription` whose grace period or dunning is exhausted; produces a Suspended `Subscription` and revokes all `Entitlement` access (see POL-ENT-2026 R-10). | Triggered by `GracePeriodStarted` (+14d) or `DunningExhausted`; emits `SubscriptionSuspended` and `EntitlementRevoked`. |
| 4.3 | Customer + Stripe Billing + Entitlement Service | `Payment`, `Subscription`, `Entitlement` | **Reinstate Subscription** — consumes a successful catch-up `Payment` on a Suspended `Subscription`; produces a reactivated `Subscription` and re-grants `Entitlement` access (see POL-ENT-2026 R-12). | Triggered by `PaymentSucceeded` on a Suspended subscription; emits `SubscriptionReinstated` and `EntitlementGranted`. |
| 4.4 | RevOps Automation + Salesforce CRM | `Subscription`, `Account` | **Churn Subscription** — consumes a `Subscription` suspended beyond 30 days; produces a Cancelled `Subscription` and a closed-lost `RenewalOpportunity` (see POL-ENT-2026 R-13). | Triggered when suspension exceeds 30 days; emits `SubscriptionCancelled`. |

### 7. Controls & Exceptions

- **Entitlement drift** detected in step 1.6 or by nightly reconciliation must be remediated within one business day; unresolved drift older than 72 hours is escalated to the RevOps lead (POL-ENT-2026 R-05).
- **Mid-term upgrades** are provisioned immediately and prorated on the next `Invoice`; **mid-term downgrades** never revoke access before period end (POL-ENT-2026 R-04).
- **Unlimited-tier contracts** suppress `OverageDetected`; step 2.2 short-circuits to `UsageWithinQuota` (POL-ENT-2026 R-06).
- **Net-terms accounts** are exempt from the provisioning payment gate in §3 (POL-ENT-2026 R-02 exception).

### 8. References

- POL-ENT-2026 — Subscription & Entitlement Business Rules (`02-business-rules-policy.md`)
- ARCH-SOR-009 — Systems & Data Reference (`03-systems-and-data.md`)
- `Plan & Packaging Spec.md`, `Order Form template.pdf`, `Renewal & Expansion Playbook.docx`
