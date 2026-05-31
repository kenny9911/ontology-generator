# Systems & Data Reference — Order-to-Cash / 系统与数据参考

**Document ID:** ARCH-O2C-DATA-03
**Version:** 3.0
**Owner:** Enterprise Data Architecture
**Effective Date:** 2025-11-01
**Classification:** Internal — Architecture Reference

---

## 1. Purpose

This document describes the **systems of record**, their **data entities (对象) and attributes** (with types and keys),
the **integrations** between systems, and the **events (事件)** exchanged across them for the Order-to-Cash domain.
Entity and system names are consistent with `01-process-sop.md` and `02-business-rules-policy.md` so that an
ontology-extraction pipeline can link processes, rules, and data.

---

## 2. Systems of Record

| System                         | Role                                              | Owns Objects (对象)                          |
|--------------------------------|---------------------------------------------------|----------------------------------------------|
| **OMS** (Order Management Sys) | Order capture, allocation, fulfillment orchestration | `Order`, `LineItem`, `CreditHold`         |
| **ERP (NetSuite)**             | Inventory, invoicing, credit limits, GL           | `Inventory`, `Invoice`, `Customer.creditLimit` |
| **Salesforce CRM**            | Customer master, accounts, service cases          | `Customer`                                   |
| **Stripe**                     | Payment authorization, capture, refunds           | `Payment`                                    |
| **ShipStation / 3PL**          | Carrier shipping, tracking, delivery confirmation | `Shipment`                                   |
| **prod-postgres-01 · public**  | Operational data store (mirrors OMS), `Product` catalog, `Return` records | `Product`, `Return` |

---

## 3. Data Entities & Attributes

### 3.1 Customer (对象: Customer) — system: Salesforce CRM (master), ERP (credit)
| Attribute       | Type        | Key       | Notes                                       |
|-----------------|-------------|-----------|---------------------------------------------|
| `customerId`    | UUID        | PK        | Primary identifier                          |
| `legalName`     | string      |           |                                             |
| `tier`          | enum        |           | `Standard` \| `Enterprise`                  |
| `creditStatus`  | enum        |           | `Active` \| `Dormant` \| `Suspended`        |
| `creditLimit`   | decimal(12,2)|          | Default `$10,000` Standard (R-02, R-08)     |
| `storeCredit`   | decimal(12,2)|          | Expires 12 months after issue (R-18)        |
| `channel`       | enum        |           | `Web` \| `Marketplace` \| `B2B`             |

### 3.2 Order (对象: Order) — system: OMS
| Attribute       | Type         | Key       | Notes                                                  |
|-----------------|--------------|-----------|--------------------------------------------------------|
| `orderId`       | UUID         | PK        |                                                        |
| `customerId`    | UUID         | FK → Customer |                                                    |
| `status`        | enum         |           | `Pending`\|`Confirmed`\|`Fulfilled`\|`Closed`\|`Cancelled` |
| `orderTotal`    | decimal(12,2)|           | Sum of `LineItem` totals                               |
| `placedAt`      | timestamp    |           |                                                        |

### 3.3 LineItem (对象: LineItem) — system: OMS
| Attribute     | Type         | Key            | Notes                          |
|---------------|--------------|----------------|--------------------------------|
| `lineItemId`  | UUID         | PK             |                                |
| `orderId`     | UUID         | FK → Order     |                                |
| `productId`   | UUID         | FK → Product   |                                |
| `quantity`    | integer      |                |                                |
| `unitPrice`   | decimal(10,2)|                |                                |

### 3.4 Product (对象: Product) — system: prod-postgres-01.public.products
| Attribute        | Type    | Key  | Notes                              |
|------------------|---------|------|------------------------------------|
| `productId`      | UUID    | PK   |                                    |
| `sku`            | string  | UQ   | Stock-keeping unit                 |
| `name`           | string  |      |                                    |
| `backorderable`  | boolean |      | Governs R-09                       |
| `finalSale`      | boolean |      | Governs R-07                       |

### 3.5 Inventory (对象: Inventory) — system: ERP (NetSuite)
| Attribute      | Type    | Key          | Notes                          |
|----------------|---------|--------------|--------------------------------|
| `inventoryId`  | UUID    | PK           |                                |
| `productId`    | UUID    | FK → Product |                                |
| `onHandQty`    | integer |              | Decremented on pick (Step 3.5) |
| `reservedQty`  | integer |              | Increased on allocation        |
| `warehouse`    | string  |              |                                |

### 3.6 Invoice (对象: Invoice) — system: ERP (NetSuite)
| Attribute     | Type         | Key            | Notes                                   |
|---------------|--------------|----------------|-----------------------------------------|
| `invoiceId`   | UUID         | PK             |                                         |
| `orderId`     | UUID         | FK → Order     |                                         |
| `status`      | enum         |                | `Draft`\|`Issued`\|`Paid`\|`Overdue`    |
| `amountDue`   | decimal(12,2)|                |                                         |
| `dueDate`     | date         |                | Net-30 for Enterprise (R-04)            |
| `daysOverdue` | integer      |                | Drives R-03 (60+ days)                  |

### 3.7 Payment (对象: Payment) — system: Stripe
| Attribute      | Type         | Key            | Notes                                |
|----------------|--------------|----------------|--------------------------------------|
| `paymentId`    | string       | PK             | Stripe charge / PaymentIntent id     |
| `invoiceId`    | UUID         | FK → Invoice   |                                      |
| `amount`       | decimal(12,2)|                |                                      |
| `type`         | enum         |                | `Capture` \| `Refund`                |
| `status`       | enum         |                | `Authorized`\|`Settled`\|`Refunded`  |

### 3.8 Shipment (对象: Shipment) — system: ShipStation / 3PL
| Attribute       | Type      | Key          | Notes                                       |
|-----------------|-----------|--------------|---------------------------------------------|
| `shipmentId`    | UUID      | PK           |                                             |
| `orderId`       | UUID      | FK → Order   |                                             |
| `status`        | enum      |              | `Picking`\|`In Transit`\|`Delivered`        |
| `trackingNumber`| string    |              |                                             |
| `deliveredAt`   | timestamp |              | Starts 30-day return clock (R-06)           |
| `destCountry`   | string    |              | Checked against ship-to list (R-11)         |

### 3.9 Return (对象: Return) — system: OMS Returns / prod-postgres-01
| Attribute     | Type      | Key             | Notes                                |
|---------------|-----------|-----------------|--------------------------------------|
| `returnId`    | UUID      | PK              |                                      |
| `lineItemId`  | UUID      | FK → LineItem   |                                      |
| `rmaNumber`   | string    | UQ              | Issued on authorization (Step 4.2)   |
| `status`      | enum      |                 | `Requested`\|`Approved`\|`Received`\|`Closed` |
| `reason`      | enum      |                 | `Defective`\|`Unwanted`\|`Wrong Item`|
| `requestedAt` | timestamp |                 | Checked vs `deliveredAt` (R-06, R-16)|

### 3.10 CreditHold (对象: CreditHold) — system: OMS
| Attribute      | Type      | Key          | Notes                              |
|----------------|-----------|--------------|------------------------------------|
| `creditHoldId` | UUID      | PK           |                                    |
| `orderId`      | UUID      | FK → Order   |                                    |
| `customerId`   | UUID      | FK → Customer|                                    |
| `reasonRule`   | string    |              | Cites R-03 or R-08                 |
| `status`       | enum      |              | `Open` \| `Released` \| `Cancelled`|

---

## 4. System Integrations

| Integration                  | Direction          | Mechanism          | Payload / Objects             |
|------------------------------|--------------------|--------------------|-------------------------------|
| Salesforce → OMS             | CRM to OMS         | REST sync          | `Customer`                    |
| OMS → ERP (NetSuite)         | bidirectional      | REST + webhook     | `Order`, `Invoice`, `Inventory` |
| OMS → Stripe                 | OMS to payments    | API + webhook      | `Payment`                     |
| OMS → ShipStation / 3PL      | OMS to carrier     | API + webhook      | `Shipment`                    |
| prod-postgres-01 ↔ OMS       | CDC replication    | logical decoding   | `Product`, `Return`, `Order`  |

---

## 5. Events Exchanged Between Systems (事件)

| Event (事件)          | Emitted by      | Consumed by         | Triggers Action (SOP ref)                 |
|-----------------------|-----------------|---------------------|-------------------------------------------|
| **CustomerCreated**   | Salesforce      | ERP                 | `AssignCreditLimit` (Step 2.2)            |
| **OrderPlaced**       | OMS             | OMS credit gate, ERP| `ScreenOrderForCredit` (Step 3.2)         |
| **PaymentAuthorized** | Stripe          | OMS                 | `AllocateInventory` (Step 3.3)            |
| **CreditHoldPlaced**  | OMS credit gate | ERP, OMS            | `PlaceCreditHold` (Step 5.1)              |
| **InventoryReserved** | ERP             | OMS, ShipStation    | `CreateShipment` (Step 3.4)               |
| **ShipmentDispatched**| ShipStation     | OMS                 | `ConfirmDelivery` (Step 3.6)              |
| **OrderDelivered**    | ShipStation     | OMS, ERP            | `SettleInvoice` / `CloseOrder` (Step 3.7) |
| **InvoiceIssued**     | ERP             | Stripe, Customer    | dunning / `SettleInvoice` (Step 3.7)      |
| **PaymentSettled**    | Stripe          | ERP, OMS            | `CloseOrder` (Step 3.8)                   |
| **ReturnRequested**   | Storefront/CRM  | OMS Returns         | `InitiateReturn` (Step 4.1)               |
| **ReturnReceived**    | OMS Returns     | ERP, Stripe         | `IssueRefund` (Step 4.4)                  |
| **RefundIssued**      | Stripe          | ERP, Customer       | credit memo posting (Step 4.4)            |

---

## 6. References

- `01-process-sop.md` — process steps and actions that read/write these entities.
- `02-business-rules-policy.md` — rules constraining these attributes (R-01 … R-18).
