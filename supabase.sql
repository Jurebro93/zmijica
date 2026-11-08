-- Shared player profiles for Vijuga. Run once in the Supabase SQL editor.
create table if not exists public.vijuga_accounts (
  slug text primary key check (char_length(slug) between 1 and 40),
  name text not null check (char_length(name) between 1 and 14),
  coins integer not null default 0,
  data jsonb not null check (pg_column_size(data) < 8192),
  updated_at timestamptz not null default now()
);
alter table public.vijuga_accounts enable row level security;
create policy "vijuga_read" on public.vijuga_accounts for select to anon, authenticated using (true);
create policy "vijuga_insert" on public.vijuga_accounts for insert to anon, authenticated with check (true);
create policy "vijuga_update" on public.vijuga_accounts for update to anon, authenticated using (true) with check (true);
grant select, insert, update on public.vijuga_accounts to anon, authenticated;
