# Order Fulfillment SOP — Order-to-Cash / 订单到回款标准操作流程

**Document ID:** SOP-O2C-014
**Version:** 3.2
**Owner:** Director of Fulfillment Operations
**Effective Date:** 2025-11-01
**Review Cycle:** Annual
**Classification:** Internal — Operations & Finance

---

## 1. Purpose & Scope

This Standard Operating Procedure (SOP) defines the end-to-end **Order-to-Cash (订单到回款)** process for the
retail and e-commerce business, from the moment a `Customer` submits an `Order` through to the point where the
corresponding `Payment` is settled and the `Invoice` is closed. It also defines the linked **Returns & Refunds
(退货与退款)** process and the **Credit Hold Review (信用冻结审查)** process.

This SOP governs all sales channels (web storefront, marketplace, and B2B portal) and all fulfillment paths
(in-house warehouse and third-party logistics / 3PL). It is the authoritative process reference and is cross-linked
to `02-business-rules-policy.md` (the Returns & Refunds Policy and Credit Policy) and `03-systems-and-data.md`
(systems of record and data entities).

**Business Objects (对象) in scope:** `Customer`, `Order`, `LineItem`, `Product`, `Inventory`, `Invoice`, `Payment`,
`Shipment`, `Return`, `CreditHold`.

**Processes (流程) defined here:**
- **Order-to-Cash (订单到回款)** — §3
- **Returns & Refunds (退货与退款)** — §4
- **Credit Hold Review (信用冻结审查)** — §5
- **Customer Onboarding (客户开户)** — §2

---

## 2. Process: Customer Onboarding (客户开户)

### Step 2.1 — Create Customer account
- **Actor / System:** Customer Service Representative (CSR) via **Salesforce CRM**.
- **Objects touched:** `Customer` (created).
- **Action:** `RegisterCustomer` — consumes the customer's submitted profile (legal name, billing address, channel,
  requested tier); produces a new `Customer` record with `tier = Standard` and `creditStatus = Active`.
- **Events:** Triggered by event **CustomerSignupSubmitted**; emits event **CustomerCreated**.

### Step 2.2 — Assign credit limit and tier
- **Actor / System:** Finance Analyst via **ERP (NetSuite)**.
- **Objects touched:** `Customer` (updated).
- **Action:** `AssignCreditLimit` — consumes the `CustomerCreated` event and a credit assessment; produces an updated
  `Customer` with `creditLimit` set (default `$10,000` for Standard; up to `$250,000` for Enterprise) and `tier`
  confirmed.
- **Events:** Triggered by **CustomerCreated**; emits **CreditLimitAssigned**.

> Reference: Eligibility and tier thresholds are governed by Rules R-01, R-02, and R-15 in `02-business-rules-policy.md`.

---

## 3. Process: Order-to-Cash (订单到回款)

### Step 3.1 — Capture the Order
- **Actor / System:** Customer (self-service) via the **Storefront / OMS (Order Management System)**.
- **Objects touched:** `Order` (created), `LineItem` (created, one per item), `Product` (read), `Customer` (read).
- **Action:** `PlaceOrder` — consumes a cart of `Product` selections and the authenticated `Customer`; produces one
  `Order` (status `Pending`) with its child `LineItem` records and a calculated order total.
- **Events:** Triggered by **CheckoutSubmitted**; emits **OrderPlaced**.

### Step 3.2 — Credit & payment screening
- **Actor / System:** **OMS** automated credit gate, calling **ERP (NetSuite)** and **Stripe**.
- **Objects touched:** `Order` (read/updated), `Customer` (read), `Invoice` (created), `CreditHold` (conditionally created).
- **Action:** `ScreenOrderForCredit` — consumes the `OrderPlaced` event and the `Customer` credit profile; checks
  outstanding `Invoice` aging and available credit. Produces either a captured/authorized `Payment` and a draft
  `Invoice`, **or** a `CreditHold` record if the rules below are violated.
  - Per **Rule R-03**, an `Order` is blocked if the `Customer` has any `Invoice` overdue by 60+ days.
  - Per **Rule R-08**, an `Order` is blocked if it would push the `Customer` above their assigned `creditLimit`,
    unless `tier = Enterprise`.
- **Events:** Triggered by **OrderPlaced**; emits **PaymentAuthorized** on success, or **CreditHoldPlaced** on failure.

> **Key rule (R-04):** An `Order` may only be Fulfilled after `Payment` is received in full, **unless** the
> `Customer`'s `tier` is Enterprise (in which case net-30 terms apply). See `02-business-rules-policy.md`.

### Step 3.3 — Confirm and allocate Inventory
- **Actor / System:** **OMS** allocation engine, reading **ERP (NetSuite)** inventory.
- **Objects touched:** `Order` (updated to `Confirmed`), `LineItem` (read), `Inventory` (decremented/reserved), `Product` (read).
- **Action:** `AllocateInventory` — consumes the `PaymentAuthorized` event and the `Order`'s `LineItem` list; produces
  a reservation against `Inventory` (`reservedQty` increased) and sets `Order.status = Confirmed`.
  - Per **Rule R-09**, an `Order` line may not be allocated unless on-hand `Inventory` covers the ordered quantity,
    unless the `Product` is flagged `backorderable`.
- **Events:** Triggered by **PaymentAuthorized**; emits **InventoryReserved**, or **BackorderRaised** if stock is short.

### Step 3.4 — Generate the Shipment / pick-pack
- **Actor / System:** Warehouse Operator (in-house) or **3PL / ShipStation** (outsourced).
- **Objects touched:** `Shipment` (created), `Order` (read), `LineItem` (read), `Inventory` (decremented on pick).
- **Action:** `CreateShipment` — consumes the `InventoryReserved` event and the `Confirmed` `Order`; produces a
  `Shipment` record (status `Picking`) with a packing list and a carrier assignment.
- **Events:** Triggered by **InventoryReserved**; emits **ShipmentCreated**.

### Step 3.5 — Dispatch and track
- **Actor / System:** Carrier integration via **ShipStation**.
- **Objects touched:** `Shipment` (updated to `In Transit`), `Order` (updated to `Fulfilled`), `Inventory` (on-hand decremented).
- **Action:** `DispatchShipment` — consumes the `ShipmentCreated` event; produces a tracking number, sets
  `Shipment.status = In Transit` and `Order.status = Fulfilled`.
  - Per **Rule R-05**, an `Order` may not be marked `Fulfilled` while a `CreditHold` is active on it.
- **Events:** Triggered by **ShipmentCreated**; emits **OrderFulfilled** and **ShipmentDispatched**.

### Step 3.6 — Confirm delivery
- **Actor / System:** Carrier integration via **ShipStation** (delivery webhook).
- **Objects touched:** `Shipment` (updated to `Delivered`), `Order` (read).
- **Action:** `ConfirmDelivery` — consumes the carrier delivery webhook; produces `Shipment.status = Delivered` and a
  `deliveredAt` timestamp (this timestamp starts the 30-day return clock per Rule R-06).
- **Events:** Triggered by **ShipmentDispatched** + carrier callback; emits **OrderDelivered**.

### Step 3.7 — Issue Invoice and collect Payment
- **Actor / System:** Finance Analyst via **ERP (NetSuite)**; payment capture via **Stripe**.
- **Objects touched:** `Invoice` (finalized), `Payment` (captured/settled), `Order` (read), `Customer` (read).
- **Action:** `SettleInvoice` — consumes the `OrderFulfilled` event and the draft `Invoice`; finalizes the `Invoice`
  (status `Issued` → `Paid`) and records the matched `Payment`.
  - For Standard customers, `Payment` was captured up front (Step 3.2); for Enterprise customers, the `Invoice` is
    issued on net-30 terms per Rule R-04.
- **Events:** Triggered by **OrderFulfilled**; emits **InvoiceIssued** and, on settlement, **PaymentSettled**.

### Step 3.8 — Close the Order
- **Actor / System:** **OMS** (automated reconciliation).
- **Objects touched:** `Order` (updated to `Closed`), `Invoice` (read), `Payment` (read).
- **Action:** `CloseOrder` — consumes the `PaymentSettled` and `OrderDelivered` events; produces `Order.status = Closed`.
- **Events:** Triggered by **PaymentSettled** + **OrderDelivered**; emits **OrderClosed**.

---

## 4. Process: Returns & Refunds (退货与退款)

### Step 4.1 — Initiate Return
- **Actor / System:** Customer via Storefront, or CSR via **Salesforce CRM**.
- **Objects touched:** `Return` (created), `Order` (read), `LineItem` (read), `Shipment` (read).
- **Action:** `InitiateReturn` — consumes the `Customer`'s request against a delivered `Order`; produces a `Return`
  record (status `Requested`) referencing the original `LineItem`(s).
  - Per **Rule R-06**, a `Return` must be initiated within 30 days of `Shipment.deliveredAt` for a full refund;
    after 30 days, store credit only.
  - Per **Rule R-07**, final-sale `Product` items are not eligible for `Return`.
- **Events:** Triggered by **ReturnRequested** (customer action); emits **ReturnInitiated**.

### Step 4.2 — Approve and authorize Return
- **Actor / System:** Returns Specialist via **OMS Returns module**.
- **Objects touched:** `Return` (updated to `Approved`), `Order` (read).
- **Action:** `AuthorizeReturn` — consumes the `ReturnInitiated` event; validates eligibility windows and produces an
  RMA (Return Merchandise Authorization) number on the `Return`.
- **Events:** Triggered by **ReturnInitiated**; emits **ReturnAuthorized**.

### Step 4.3 — Receive returned goods and restock
- **Actor / System:** Warehouse Operator via **OMS**, updating **ERP (NetSuite)** inventory.
- **Objects touched:** `Return` (updated to `Received`), `Inventory` (incremented), `Product` (read).
- **Action:** `ReceiveReturn` — consumes the inbound `Shipment` against the RMA; produces an inspection result and,
  if the goods are sellable, increments `Inventory.onHandQty`.
- **Events:** Triggered by **ReturnAuthorized** + goods received; emits **ReturnReceived**.

### Step 4.4 — Issue Refund or store credit
- **Actor / System:** Finance Analyst via **ERP (NetSuite)** and **Stripe**.
- **Objects touched:** `Payment` (refund created), `Invoice` (credit memo), `Customer` (store-credit balance updated), `Return` (closed).
- **Action:** `IssueRefund` — consumes the `ReturnReceived` event; produces either a `Payment` refund (within window)
  or a store-credit adjustment on the `Customer` (outside window), plus a credit memo against the `Invoice`.
  - Per **Rule R-12**, any refund exceeding `$2,000` requires Finance Manager approval before issuance.
- **Events:** Triggered by **ReturnReceived**; emits **RefundIssued**.

---

## 5. Process: Credit Hold Review (信用冻结审查)

### Step 5.1 — Detect and place CreditHold
- **Actor / System:** **OMS** credit gate (automated) — see Step 3.2.
- **Objects touched:** `CreditHold` (created), `Order` (held), `Customer` (read), `Invoice` (read).
- **Action:** `PlaceCreditHold` — consumes a failed credit screen; produces a `CreditHold` record citing the violated
  rule (R-03 or R-08) and freezes the `Order`.
- **Events:** Triggered by **CreditHoldPlaced**; emits **CreditHoldOpened**.

### Step 5.2 — Review and resolve
- **Actor / System:** Credit Manager via **ERP (NetSuite)**.
- **Objects touched:** `CreditHold` (resolved), `Order` (released or cancelled), `Invoice` (read).
- **Action:** `ResolveCreditHold` — consumes the `CreditHoldOpened` event; the Credit Manager either records payment
  of the overdue `Invoice` and releases the `Order`, or cancels the `Order`.
  - Per **Rule R-13**, a `CreditHold` may only be overridden by a Credit Manager or above, with a recorded reason.
- **Events:** Triggered by **CreditHoldOpened**; emits **CreditHoldReleased** (which re-enters Step 3.3) or **OrderCancelled**.

---

## 6. References

- `02-business-rules-policy.md` — Returns & Refunds Policy v3 and Credit Policy (Rules R-01 … R-18).
- `03-systems-and-data.md` — Systems of record, data entities, attributes, and inter-system events.
- Customer Onboarding Playbook (internal, §2 here).

## 7. Revision History

| Version | Date       | Change                                              |
|---------|------------|-----------------------------------------------------|
| 3.0     | 2024-06-01 | Initial O2C consolidation across channels           |
| 3.1     | 2025-03-15 | Added 3PL dispatch path (Step 3.4)                  |
| 3.2     | 2025-11-01 | Added Credit Hold Review process (§5); net-30 terms |
