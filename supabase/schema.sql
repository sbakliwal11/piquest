-- Run this whole file in Supabase Dashboard > SQL Editor > New query.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.question_bank (
  id uuid primary key default gen_random_uuid(),
  normalized_question text not null unique,
  question_text text not null,
  solution jsonb not null,
  subject text not null default 'Unknown',
  difficulty text not null default 'Unknown',
  created_at timestamptz not null default now()
);

create table if not exists public.question_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_bank_id uuid references public.question_bank(id) on delete set null,
  question_text text not null,
  subject text not null default 'Unknown',
  difficulty text not null default 'Unknown',
  solution_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists question_history_user_created_idx
  on public.question_history(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.question_bank enable row level security;
alter table public.question_history enable row level security;

-- A student can read/update only their own profile.
drop policy if exists "Profiles: read own" on public.profiles;
create policy "Profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Profiles: insert own" on public.profiles;
create policy "Profiles: insert own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists "Profiles: update own" on public.profiles;
create policy "Profiles: update own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Signed-in users may read the shared question bank. Only the server service-role
-- key can insert/update cache entries; NEVER expose that key in the browser.
drop policy if exists "Question bank: read for signed-in users" on public.question_bank;
create policy "Question bank: read for signed-in users" on public.question_bank
  for select to authenticated using (true);

-- Each student can see and delete only their own history.
drop policy if exists "History: read own" on public.question_history;
create policy "History: read own" on public.question_history
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "History: insert own" on public.question_history;
create policy "History: insert own" on public.question_history
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "History: delete own" on public.question_history;
create policy "History: delete own" on public.question_history
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update on public.profiles to authenticated;
grant select on public.question_bank to authenticated;
grant select, insert, delete on public.question_history to authenticated;
