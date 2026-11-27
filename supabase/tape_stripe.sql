-- Tape: doplnění k tape_access.sql pro automatické platby přes Stripe.
-- Spusť jednou AŽ PO tape_access.sql: SQL Editor -> New query -> vlož celé -> Run.

alter table public.tape_access add column if not exists stripe_customer text;
alter table public.tape_access add column if not exists stripe_sub text;
create index if not exists tape_access_stripe_sub on public.tape_access (stripe_sub);

-- Žádosti o odstoupení od smlouvy z tlačítka v aplikaci.
create table if not exists public.tape_withdraw (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text,
  plan        text,
  note        text,
  created_at  timestamptz not null default now(),
  handled_at  timestamptz
);
alter table public.tape_withdraw enable row level security;
drop policy if exists "tape_withdraw_insert_own" on public.tape_withdraw;
create policy "tape_withdraw_insert_own" on public.tape_withdraw for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "tape_withdraw_read_own" on public.tape_withdraw;
create policy "tape_withdraw_read_own" on public.tape_withdraw for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.tape_withdraw from anon;
grant select, insert on public.tape_withdraw to authenticated;

-- Kdo chce odstoupit (vyřídit: vrátit platbu ve Stripu, zrušit předplatné, pak označit):
--   select id, email, plan, note, created_at from public.tape_withdraw where handled_at is null order by created_at;
--   update public.tape_withdraw set handled_at = now() where id = 123;
