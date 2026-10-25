-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

-- 1) Table that holds your games, prices and settings (one row)
create table if not exists public.store_config (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lock the table: nobody can read or write it from the browser.
-- Only your server function (using the secret key) can touch it.
alter table public.store_config enable row level security;

-- 2) Private bucket for game pictures and the KHQR image
insert into storage.buckets (id, name, public)
values ('store-images', 'store-images', false)
on conflict (id) do nothing;

-- 3) Orders table (for the "Track your order" section). Safe to run again.
create table if not exists public.orders (
  code text primary key,
  game text not null,
  pack text not null,
  usd numeric not null,
  status text not null default 'pending',
  history jsonb not null default '[]'::jsonb,
  cust_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_cust_idx on public.orders (cust_id, created_at desc);
alter table public.orders enable row level security;   -- no policies: only your server (secret key) can use it
