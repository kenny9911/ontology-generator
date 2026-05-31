# Business Rules & Policy — Order-to-Cash / 业务规则与政策

**Document ID:** POL-O2C-RULES-03
**Version:** 3.0
**Owner:** VP Finance & VP Operations (joint)
**Effective Date:** 2025-11-01
**Supersedes:** Returns & Refunds Policy v2, Credit Policy v1.4
**Classification:** Internal — Binding Policy

---

## 1. Purpose

This document states the **explicit, atomic business rules (规则)** that govern the Order-to-Cash, Returns & Refunds,
and Credit Hold processes. Each rule is written as a single enforceable sentence so it can be cited individually.
Rules reference the Objects (对象) `Customer`, `Order`, `LineItem`, `Product`, `Inventory`, `Invoice`, `Payment`,
`Shipment`, `Return`, and `CreditHold` as defined in `03-systems-and-data.md` and exercised in the SOP
(`01-process-sop.md`).

Defined terms: **Standard tier** and **Enterprise tier** are values of `Customer.tier`. **In full** means the captured
`Payment` amount equals the `Order` total. **Delivery date** means `Shipment.deliveredAt`.

---

## 2. Order & Fulfillment Rules

**R-01.** Every `Order` must reference exactly one `Customer` whose `creditStatus` is Active at the time of order placement.

**R-02.** A `Customer` is required to have an assigned `creditLimit` before any `Order` may be confirmed.

**R-03.** A `Customer` may not place an `Order` if any of their `Invoice` records are overdue by 60 or more days.

**R-04.** An `Order` may only be Fulfilled after its `Payment` is received in full, unless the `Customer`'s tier is Enterprise, in which case the `Order` is fulfilled on net-30 invoice terms.

**R-05.** An `Order` shall not be marked Fulfilled while an active `CreditHold` exists against it.

**R-08.** An `Order` may not be confirmed if its total would cause the `Customer`'s open balance to exceed their assigned `creditLimit`, unless the `Customer`'s tier is Enterprise.

**R-09.** A `LineItem` may not be allocated against `Inventory` unless on-hand quantity covers the ordered quantity, unless the referenced `Product` is flagged backorderable.

**R-10.** An `Order` total of `$50,000` or more is required to receive Operations Director approval before it is released to fulfillment.

**R-11.** A `Shipment` may not be dispatched to an international destination unless the destination country is on the approved-ship-to list.

---

## 3. Returns & Refunds Rules

**R-06.** A `Return` must be initiated within 30 days of the `Shipment` delivery date for a full refund; after 30 days, the `Customer` may receive store credit only.

**R-07.** A `Product` marked final-sale may not be returned under any circumstances.

**R-12.** A refund `Payment` exceeding `$2,000` is required to have Finance Manager approval before it is issued.

**R-14.** A `Return` may not be approved unless it references a `LineItem` on an `Order` whose `Shipment` status is Delivered.

**R-16.** A `Return` for a defective `Product` may be initiated within 90 days of the delivery date regardless of the standard 30-day window.

**R-18.** Store credit issued in lieu of a refund shall expire 12 months after the date of issue.

---

## 4. Credit & Customer Rules

**R-13.** An active `CreditHold` may not be overridden except by a Credit Manager or higher, and the override must record a written reason.

**R-15.** A `Customer` may be assigned Enterprise tier only after a signed master agreement is on file and Finance approval is recorded.

**R-17.** A `Customer` whose account has been inactive for 24 months shall have their `creditStatus` set to Dormant, after which new `Order` placement requires re-verification.

---

## 5. Approval Authority Matrix

| Action                              | Threshold / Condition            | Required Approver        | Rule  |
|-------------------------------------|----------------------------------|--------------------------|-------|
| Release `Order` to fulfillment      | Total ≥ `$50,000`                | Operations Director      | R-10  |
| Issue refund `Payment`              | Amount > `$2,000`                | Finance Manager          | R-12  |
| Override `CreditHold`               | Any active hold                  | Credit Manager or above  | R-13  |
| Assign Enterprise tier              | New Enterprise `Customer`        | Finance (with agreement) | R-15  |

---

## 6. References

- `01-process-sop.md` — process steps that enforce these rules.
- `03-systems-and-data.md` — entity and attribute definitions referenced by these rules.
