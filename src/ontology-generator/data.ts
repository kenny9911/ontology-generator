// Sample enterprise dataset + the AI discovery script.
// Ported from OntologyGen_design/src/data.js with explicit TypeScript types.
// The dataset includes: sources, objects, rules, processes, relations, and the
// "discovery script" — the timeline of events to play during the magic moment.

export type Lang = 'en' | 'zh';

export interface OntAttr {
  name: string;
  type: string;
  role?: 'pk' | 'fk';
  req: boolean;
}

export interface OntObject {
  id: string;
  name: string;
  zh: string;
  emoji: string;
  color: string;
  confidence: number;
  sources: number;
  attrs: OntAttr[];
  relations: string[];
}

export interface RuleSource {
  name: string;
  excerpt: string;
  page: number;
}

export interface OntRule {
  id: string;
  confidence: number;
  plain: Record<Lang, string>;
  formal: string;
  source: RuleSource;
  objects: string[];
}

export interface ProcStep {
  en: string;
  zh: string;
  obj: string;
}

export interface OntProcess {
  id: string;
  name: Record<Lang, string>;
  actors: string[];
  objects: string[];
  steps: ProcStep[];
}

export type SourceKind = 'doc' | 'db' | 'app';

export interface OntSource {
  kind: SourceKind;
  name: string;
  size: string;
  pages: number;
}

export interface Dataset {
  id: string;
  label: Record<Lang, string>;
  sublabel: Record<Lang, string>;
  sources: OntSource[];
  objects: OntObject[];
  rules: OntRule[];
  processes: OntProcess[];
}

export type DiscoveryEvent =
  | { at: number; kind: 'phase'; name: string }
  | { at: number; kind: 'object'; obj: OntObject }
  | { at: number; kind: 'rule'; rule: OntRule }
  | { at: number; kind: 'process'; proc: OntProcess }
  | { at: number; kind: 'log'; text: string };

export interface DiscoveryScript {
  events: DiscoveryEvent[];
  duration: number;
}

export const DATASETS: Record<string, Dataset> = {
  commerce: {
    id: 'commerce',
    label: { en: 'Generic enterprise', zh: '通用企业' },
    sublabel: { en: 'Orders · Customers · Products', zh: '订单 · 客户 · 商品' },

    sources: [
      { kind: 'doc', name: 'Customer Onboarding Playbook.pdf', size: '2.4 MB', pages: 18 },
      { kind: 'doc', name: 'Order Fulfillment SOP.docx', size: '812 KB', pages: 9 },
      { kind: 'doc', name: 'Returns & Refunds Policy v3.pdf', size: '456 KB', pages: 6 },
      { kind: 'doc', name: 'Product Catalog Schema.md', size: '118 KB', pages: 4 },
      { kind: 'db', name: 'prod-postgres-01 · public', size: '37 tables', pages: 0 },
      { kind: 'app', name: 'Salesforce → Accounts, Opportunities', size: 'API', pages: 0 },
    ],

    objects: [
      { id: 'customer', name: 'Customer', zh: '客户', emoji: '👤', color: 'accent',
        confidence: 0.98, sources: 14,
        attrs: [
          { name: 'customer_id', type: 'UUID', role: 'pk', req: true },
          { name: 'company_name', type: 'String', req: true },
          { name: 'billing_address', type: 'Address', req: true },
          { name: 'tax_id', type: 'String', req: false },
          { name: 'tier', type: 'Enum<Standard|Premium|Enterprise>', req: true },
          { name: 'credit_limit', type: 'Money', req: false },
          { name: 'onboarded_at', type: 'DateTime', req: true },
        ],
        relations: ['places → Order', 'owns → ShippingAddress', 'linked → Account (Salesforce)'] },
      { id: 'order', name: 'Order', zh: '订单', emoji: '📦', color: 'accent',
        confidence: 0.99, sources: 22,
        attrs: [
          { name: 'order_id', type: 'UUID', role: 'pk', req: true },
          { name: 'customer_id', type: 'UUID', role: 'fk', req: true },
          { name: 'placed_at', type: 'DateTime', req: true },
          { name: 'status', type: 'Enum<Draft|Placed|Fulfilled|Returned|Cancelled>', req: true },
          { name: 'subtotal', type: 'Money', req: true },
          { name: 'tax', type: 'Money', req: true },
          { name: 'total', type: 'Money', req: true },
          { name: 'channel', type: 'Enum<Web|Phone|Field|Partner>', req: true },
        ],
        relations: ['contains → LineItem', 'ships → Shipment', 'billed → Invoice'] },
      { id: 'product', name: 'Product', zh: '商品', emoji: '🏷', color: 'accent',
        confidence: 0.97, sources: 11,
        attrs: [
          { name: 'sku', type: 'String', role: 'pk', req: true },
          { name: 'name', type: 'String', req: true },
          { name: 'category', type: 'Reference<Category>', req: true },
          { name: 'list_price', type: 'Money', req: true },
          { name: 'cost', type: 'Money', req: false },
          { name: 'weight_kg', type: 'Decimal', req: false },
          { name: 'active', type: 'Boolean', req: true },
        ],
        relations: ['belongs → Category', 'stocked → Inventory', 'appears → LineItem'] },
      { id: 'lineitem', name: 'LineItem', zh: '订单行', emoji: '▦', color: 'accent',
        confidence: 0.96, sources: 9,
        attrs: [
          { name: 'line_id', type: 'UUID', role: 'pk', req: true },
          { name: 'order_id', type: 'UUID', role: 'fk', req: true },
          { name: 'sku', type: 'String', role: 'fk', req: true },
          { name: 'qty', type: 'Integer', req: true },
          { name: 'unit_price', type: 'Money', req: true },
          { name: 'discount', type: 'Money', req: false },
        ],
        relations: ['part-of → Order', 'refers → Product'] },
      { id: 'invoice', name: 'Invoice', zh: '发票', emoji: '🧾', color: 'accent',
        confidence: 0.94, sources: 8,
        attrs: [
          { name: 'invoice_id', type: 'UUID', role: 'pk', req: true },
          { name: 'order_id', type: 'UUID', role: 'fk', req: true },
          { name: 'issued_at', type: 'DateTime', req: true },
          { name: 'due_at', type: 'DateTime', req: true },
          { name: 'status', type: 'Enum<Open|Paid|Overdue|Void>', req: true },
          { name: 'amount_due', type: 'Money', req: true },
        ],
        relations: ['billed-from → Order', 'settled → Payment'] },
      { id: 'shipment', name: 'Shipment', zh: '发运', emoji: '🚚', color: 'accent',
        confidence: 0.92, sources: 7,
        attrs: [
          { name: 'shipment_id', type: 'UUID', role: 'pk', req: true },
          { name: 'order_id', type: 'UUID', role: 'fk', req: true },
          { name: 'carrier', type: 'String', req: true },
          { name: 'tracking_no', type: 'String', req: false },
          { name: 'shipped_at', type: 'DateTime', req: false },
          { name: 'delivered_at', type: 'DateTime', req: false },
        ],
        relations: ['ships → Order', 'uses → Carrier'] },
      { id: 'return', name: 'Return', zh: '退货', emoji: '↩', color: 'accent',
        confidence: 0.89, sources: 5,
        attrs: [
          { name: 'return_id', type: 'UUID', role: 'pk', req: true },
          { name: 'order_id', type: 'UUID', role: 'fk', req: true },
          { name: 'reason', type: "Enum<Defect|WrongItem|Buyer'sRemorse|Other>", req: true },
          { name: 'received_at', type: 'DateTime', req: false },
          { name: 'refund_amount', type: 'Money', req: false },
        ],
        relations: ['reverses → Order', 'triggers → Refund'] },
      { id: 'payment', name: 'Payment', zh: '支付', emoji: '💳', color: 'accent',
        confidence: 0.93, sources: 6,
        attrs: [
          { name: 'payment_id', type: 'UUID', role: 'pk', req: true },
          { name: 'invoice_id', type: 'UUID', role: 'fk', req: true },
          { name: 'method', type: 'Enum<Card|Wire|ACH|Check>', req: true },
          { name: 'amount', type: 'Money', req: true },
          { name: 'received_at', type: 'DateTime', req: true },
        ],
        relations: ['settles → Invoice'] },
      { id: 'category', name: 'Category', zh: '分类', emoji: '🗂', color: 'accent',
        confidence: 0.86, sources: 4,
        attrs: [
          { name: 'category_id', type: 'UUID', role: 'pk', req: true },
          { name: 'name', type: 'String', req: true },
          { name: 'parent_id', type: 'UUID', role: 'fk', req: false },
        ],
        relations: ['groups → Product', 'child-of → Category'] },
      { id: 'address', name: 'Address', zh: '地址', emoji: '📍', color: 'accent',
        confidence: 0.88, sources: 6,
        attrs: [
          { name: 'address_id', type: 'UUID', role: 'pk', req: true },
          { name: 'line1', type: 'String', req: true },
          { name: 'city', type: 'String', req: true },
          { name: 'region', type: 'String', req: true },
          { name: 'country', type: 'String', req: true },
          { name: 'postal_code', type: 'String', req: true },
        ],
        relations: ['used-by → Customer, Shipment'] },
      { id: 'inventory', name: 'Inventory', zh: '库存', emoji: '📊', color: 'accent',
        confidence: 0.84, sources: 3,
        attrs: [
          { name: 'sku', type: 'String', role: 'fk', req: true },
          { name: 'warehouse_id', type: 'UUID', role: 'fk', req: true },
          { name: 'on_hand', type: 'Integer', req: true },
          { name: 'reserved', type: 'Integer', req: true },
        ],
        relations: ['holds → Product', 'located-in → Warehouse'] },
      { id: 'warehouse', name: 'Warehouse', zh: '仓库', emoji: '🏭', color: 'accent',
        confidence: 0.83, sources: 3,
        attrs: [
          { name: 'warehouse_id', type: 'UUID', role: 'pk', req: true },
          { name: 'name', type: 'String', req: true },
          { name: 'address_id', type: 'UUID', role: 'fk', req: true },
        ],
        relations: ['stores → Inventory'] },
    ],

    rules: [
      { id: 'r1', confidence: 0.97,
        plain: { en: "An Order may only be Fulfilled after Payment is received in full, unless the Customer's tier is Enterprise.",
                 zh: '订单仅在收到全额付款后方可被标记为已履约；客户层级为 Enterprise 时除外。' },
        formal: 'Order.status = Fulfilled → (Payment.amount = Invoice.total) ∨ (Customer.tier = Enterprise)',
        source: { name: 'Order Fulfillment SOP.docx', excerpt: '§3.2 — Fulfillment teams may not release goods until payment has cleared the merchant of record. Enterprise customers operate under net-30 terms.', page: 4 },
        objects: ['Order', 'Payment', 'Customer'] },
      { id: 'r2', confidence: 0.94,
        plain: { en: 'Returns must be initiated within 30 days of delivery for a full refund; after 30 days, store credit only.',
                 zh: '退货须在交付后 30 天内发起方可全额退款；超过 30 天仅提供商城积分。' },
        formal: 'Return.received_at − Shipment.delivered_at ≤ 30d → Refund.full; else → StoreCredit',
        source: { name: 'Returns & Refunds Policy v3.pdf', excerpt: 'Customers have thirty (30) calendar days from confirmed delivery to initiate a return for a full refund of the purchase price.', page: 2 },
        objects: ['Return', 'Shipment', 'Refund'] },
      { id: 'r3', confidence: 0.91,
        plain: { en: 'Customer credit_limit must be set before any Order on the Phone or Field channel is accepted.',
                 zh: '电话或现场渠道下单前，客户的信用额度必须已设定。' },
        formal: 'Order.channel ∈ {Phone, Field} → Customer.credit_limit ≠ null',
        source: { name: 'Customer Onboarding Playbook.pdf', excerpt: 'Account managers must complete a credit review before accepting orders placed by phone or in the field.', page: 11 },
        objects: ['Customer', 'Order'] },
      { id: 'r4', confidence: 0.96,
        plain: { en: 'An Order.total must equal Σ(LineItem.qty × LineItem.unit_price) − discounts + tax.',
                 zh: '订单合计须等于 Σ(订单行.数量 × 订单行.单价) − 折扣 + 税额。' },
        formal: 'Order.total = Σ(li.qty × li.unit_price) − Σ(li.discount) + Order.tax',
        source: { name: 'Order Fulfillment SOP.docx', excerpt: 'Order totals are derived from line items, discounts, and applicable taxes; they are never entered directly.', page: 2 },
        objects: ['Order', 'LineItem'] },
      { id: 'r5', confidence: 0.88,
        plain: { en: 'An Invoice becomes Overdue when the current date exceeds due_at by more than 0 days and status is Open.',
                 zh: '当当前日期已超过到期日且发票状态为未结，发票自动变为逾期。' },
        formal: 'Invoice.status = Open ∧ today > Invoice.due_at → Invoice.status := Overdue',
        source: { name: 'prod-postgres-01 → invoices.cron_overdue', excerpt: 'Trigger function flips status from Open to Overdue nightly.', page: 0 },
        objects: ['Invoice'] },
      { id: 'r6', confidence: 0.85,
        plain: { en: 'Inventory cannot be allocated below zero; orders exceeding on_hand − reserved are placed on backorder.',
                 zh: '库存不可分配为负值；超过可用库存（在手 − 已预留）的订单转为缺货等待。' },
        formal: '(Inventory.on_hand − Inventory.reserved) < LineItem.qty → Order.status := Backorder',
        source: { name: 'Order Fulfillment SOP.docx', excerpt: 'Backorders are created automatically when inventory is insufficient to fulfill the line.', page: 6 },
        objects: ['Inventory', 'LineItem', 'Order'] },
      { id: 'r7', confidence: 0.82,
        plain: { en: 'A Customer cannot place an Order if any of their Invoices are Overdue by 60+ days.',
                 zh: '若客户有任何发票逾期 60 天及以上，则该客户不可下单。' },
        formal: '∃ Invoice ∈ Customer.invoices : (today − Invoice.due_at) > 60d ∧ Invoice.status = Overdue → block Order',
        source: { name: 'Customer Onboarding Playbook.pdf', excerpt: 'Accounts with severely delinquent invoices are placed on credit hold until reconciled.', page: 14 },
        objects: ['Customer', 'Invoice', 'Order'] },
    ],

    processes: [
      { id: 'p1', name: { en: 'Order to Cash', zh: '订单到回款' },
        actors: ['Customer', 'Sales Rep', 'Fulfillment', 'Finance'],
        objects: ['Customer', 'Order', 'Invoice', 'Shipment', 'Payment'],
        steps: [
          { en: 'Customer places Order', zh: '客户下单', obj: 'Order' },
          { en: 'Credit check against Customer.credit_limit', zh: '对照客户信用额度进行风控', obj: 'Customer' },
          { en: 'Allocate Inventory & reserve stock', zh: '分配库存并预留', obj: 'Inventory' },
          { en: 'Issue Invoice', zh: '开具发票', obj: 'Invoice' },
          { en: 'Ship goods via Carrier', zh: '通过承运方发货', obj: 'Shipment' },
          { en: 'Receive Payment, settle Invoice', zh: '收款并结清发票', obj: 'Payment' },
        ] },
      { id: 'p2', name: { en: 'Customer Onboarding', zh: '客户准入' },
        actors: ['Sales', 'Finance', 'Customer Success'],
        objects: ['Customer', 'Address'],
        steps: [
          { en: 'Capture company details', zh: '录入企业资料', obj: 'Customer' },
          { en: 'Verify tax_id & legal entity', zh: '核验税号与法律实体', obj: 'Customer' },
          { en: 'Run credit review, set credit_limit', zh: '完成信用评估并设定额度', obj: 'Customer' },
          { en: 'Assign tier (Standard/Premium/Enterprise)', zh: '划定客户层级', obj: 'Customer' },
          { en: 'Provision billing & shipping Address', zh: '维护账单与收货地址', obj: 'Address' },
        ] },
      { id: 'p3', name: { en: 'Returns & Refunds', zh: '退货与退款' },
        actors: ['Customer', 'Support', 'Warehouse', 'Finance'],
        objects: ['Order', 'Return', 'Shipment', 'Payment'],
        steps: [
          { en: 'Customer initiates Return within 30d', zh: '客户在 30 天内发起退货', obj: 'Return' },
          { en: 'Generate return Shipment label', zh: '生成退货运单', obj: 'Shipment' },
          { en: 'Receive item at Warehouse, inspect', zh: '仓库收货并检验', obj: 'Return' },
          { en: 'Approve Refund or issue store credit', zh: '审批退款或发放积分', obj: 'Payment' },
          { en: 'Reverse Invoice / issue credit note', zh: '冲销发票或开具贷项', obj: 'Invoice' },
        ] },
      { id: 'p4', name: { en: 'Procure to Stock', zh: '采购到入库' },
        actors: ['Buyer', 'Supplier', 'Warehouse'],
        objects: ['Product', 'Inventory', 'Warehouse'],
        steps: [
          { en: 'Forecast demand by SKU', zh: '按 SKU 预测需求', obj: 'Product' },
          { en: 'Issue PO to Supplier', zh: '向供应商下达采购单', obj: 'Product' },
          { en: 'Receive goods at Warehouse', zh: '仓库收货', obj: 'Warehouse' },
          { en: 'Update Inventory.on_hand', zh: '更新在手库存', obj: 'Inventory' },
        ] },
    ],
  },
};

// Discovery script — the timeline of events for the "magic moment".
// Each event has: at (ms), kind, payload. The screen consumes these as a stream.
export function buildDiscoveryScript(dataset: Dataset, speed: number): DiscoveryScript {
  const events: DiscoveryEvent[] = [];
  const objs = dataset.objects;
  const rules = dataset.rules;
  const procs = dataset.processes;

  const phaseStart = (name: string, at: number) => events.push({ at, kind: 'phase', name });
  const objFound = (o: OntObject, at: number) => events.push({ at, kind: 'object', obj: o });
  const ruleFound = (r: OntRule, at: number) => events.push({ at, kind: 'rule', rule: r });
  const procFound = (p: OntProcess, at: number) => events.push({ at, kind: 'process', proc: p });
  const log = (text: string, at: number) => events.push({ at, kind: 'log', text });

  // Tempo — base ms scaled by speed (0.5 fast → 2 slow)
  const k = speed;
  let t = 0;

  phaseStart('parse', t);
  for (let i = 0; i < dataset.sources.length; i++) {
    const s = dataset.sources[i];
    log(`parsing ${s.name}`, t);
    t += 220 * k;
  }
  t += 200 * k;

  phaseStart('entity', t);
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    log(`entity ${o.name} — confidence ${(o.confidence * 100).toFixed(0)}%`, t);
    objFound(o, t);
    t += 320 * k;
  }
  t += 200 * k;

  phaseStart('rule', t);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    log(`rule extracted — "${r.plain.en.slice(0, 56)}…"`, t);
    ruleFound(r, t);
    t += 380 * k;
  }
  t += 200 * k;

  phaseStart('proc', t);
  for (let i = 0; i < procs.length; i++) {
    const p = procs[i];
    log(`process ${p.name.en} — ${p.steps.length} steps`, t);
    procFound(p, t);
    t += 420 * k;
  }
  t += 200 * k;

  phaseStart('link', t);
  let totalRels = 0;
  for (const o of objs) totalRels += o.relations.length;
  log(`linking ${totalRels} relations across ${objs.length} objects`, t);
  t += 600 * k;
  log('ontology assembled · ready for review', t);
  t += 300 * k;

  return { events, duration: t };
}
