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
