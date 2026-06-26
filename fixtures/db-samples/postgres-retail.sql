--
-- PostgreSQL database dump (schema only) — fixture for scripts/test-db.mts
--

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET search_path = public, pg_catalog;

CREATE TABLE public.customers (
    customer_id bigint NOT NULL,
    email character varying(255) NOT NULL,
    full_name character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.customers IS 'Registered buyers';
COMMENT ON COLUMN public.customers.customer_id IS 'Surrogate key';

CREATE TABLE public.products (
    product_id bigint NOT NULL,
    sku character varying(40) NOT NULL,
    name character varying(200),
    price numeric(12,2) NOT NULL,
    status character varying(20) NOT NULL,
    CONSTRAINT ck_products_price CHECK ((price >= 0)),
    CONSTRAINT ck_products_status CHECK (status IN ('active','discontinued'))
);

COMMENT ON TABLE public.products IS 'Catalog items';

CREATE TABLE public.orders (
    order_id bigint NOT NULL,
    customer_id bigint NOT NULL,
    order_no character varying(40) NOT NULL,
    status character varying(20) NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    CONSTRAINT ck_orders_status CHECK (status IN ('pending','paid','shipped','cancelled')),
    CONSTRAINT ck_orders_total CHECK ((total_amount >= 0))
);

COMMENT ON TABLE public.orders IS 'Customer order headers';

CREATE TABLE public.order_items (
    order_item_id bigint NOT NULL,
    order_id bigint NOT NULL,
    product_id bigint NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    CONSTRAINT ck_order_items_qty CHECK ((quantity > 0))
);

COMMENT ON TABLE public.order_items IS 'Line items per order';

--
-- Keys and constraints (pg_dump emits these as separate ALTER TABLE statements)
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (customer_id);
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT uq_customers_email UNIQUE (email);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (product_id);
ALTER TABLE ONLY public.products
    ADD CONSTRAINT uq_products_sku UNIQUE (sku);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT uq_orders_customer_no UNIQUE (customer_id, order_no);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES public.customers(customer_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_item_id);
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT uq_order_items_order_product UNIQUE (order_id, product_id);
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES public.orders(order_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES public.products(product_id) ON DELETE RESTRICT;

--
-- A view (becomes a derived ObjectType)
--

CREATE VIEW public.active_orders AS
    SELECT order_id, customer_id, status, total_amount
    FROM public.orders
    WHERE status <> 'cancelled';
