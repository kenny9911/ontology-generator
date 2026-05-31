# Subscription & Entitlement Business Rules Policy

**Document ID:** POL-ENT-2026
**Version:** 3.1 (effective 2026-04-01)
**Owner:** Revenue Operations (RevOps)
**Applies to:** all `Account`, `Contract`, `Subscription`, `Plan`, `Entitlement`, `UsageRecord`, `Invoice`, `Payment`, and `RenewalOpportunity` records.
**Companion documents:** `01-process-sop.md` (SOP-REVOPS-014), `03-systems-and-data.md` (ARCH-SOR-009).

---

## Purpose

This policy states the explicit, atomic business rules that govern subscription and entitlement operations. Each rule is written as a single enforceable clause so it can be cited and applied independently by automation and audit.

## Rules (规则)

**R-01.** An Account's active Entitlements must at all times match the entitlement set defined by its current Subscription Plan.

**R-02.** A Subscription's Entitlements shall not be provisioned before the initial Invoice is issued, unless the Contract carries a `net_terms` flag.

**R-03.** Usage beyond a Plan's included quota must be billed as an overage line item on the next Invoice.

**R-04.** A Plan downgrade may not revoke the removed features before the end of the current billing period.

**R-05.** Detected entitlement drift is required to be remediated within one business day, and drift unresolved beyond 72 hours must be escalated to the RevOps lead.

**R-06.** A Subscription on an unlimited-tier Contract shall not incur overage charges regardless of recorded usage.

**R-07.** A quote whose discount exceeds 20% of list price must be approved by the Deal Desk, and a discount exceeding 40% is required to receive VP of Sales approval before the Contract may be signed.

**R-08.** A RenewalOpportunity must be opened no later than 90 days before the Subscription term-end date.

**R-09.** A Subscription not renewed by its term-end date shall move to a 14-day grace period during which Entitlements remain active.

**R-10.** A Subscription whose 14-day grace period expires without renewal must be suspended and all of its Entitlements revoked.

**R-11.** A failed Payment shall trigger a dunning sequence of no more than 3 automated retry attempts spread over 10 calendar days.

**R-12.** A suspended Subscription may be reinstated only after a successful catch-up Payment clears all overdue Invoices, after which Entitlements must be re-granted within 1 hour.

**R-13.** A Subscription that remains suspended for more than 30 consecutive days must be cancelled and its RenewalOpportunity closed as lost.

**R-14.** An Account may not hold more than one active Subscription per product line at any time.

**R-15.** Every Invoice must reference the Subscription that generated it and shall not be issued without at least one line item.

**R-16.** A mid-term upgrade is required to be provisioned immediately and the price difference shall be prorated on the next Invoice.

**R-17.** A seat-based Entitlement may not grant more active seats than the seat count purchased on the Contract.

**R-18.** A Contract term shall be a minimum of 12 months unless a month-to-month exception is approved by Finance.

**R-19.** Revenue may not be recognized against a Subscription until the corresponding Invoice Payment has succeeded.

**R-20.** A free-trial Subscription must auto-convert to a paid Plan at trial end or be suspended, and may not extend beyond 30 days without CSM approval.

## Exceptions Register

- **Net-terms exception (R-02):** Accounts flagged `net_terms` in Salesforce are provisioned on Contract signature, before invoice payment.
- **Unlimited-tier exception (R-03, R-06):** Contracts with `tier = unlimited` suppress overage calculation entirely.
- **Month-to-month exception (R-18):** Requires a recorded Finance approval on the Contract.
- **Trial-extension exception (R-20):** Requires a recorded CSM approval; capped at one extension.
