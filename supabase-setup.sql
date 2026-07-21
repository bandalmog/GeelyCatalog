-- =========================================================================
-- Geely Accessories Catalog — Supabase security setup
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New
-- query). It enables Row Level Security (RLS) on all three data tables
-- and creates policies so that:
--   * Anyone (the public catalog page) can READ accessories, bundles,
--     and site_content.
--   * Only a user explicitly listed in the "admins" table can
--     INSERT / UPDATE / DELETE — not just anyone with a login.
--
-- This replaces the old hard-coded PIN ("8133") that lived in the page's
-- JavaScript. That PIN never actually protected the database — anyone
-- could open the browser console and call the Supabase client directly.
-- Real protection has to live on the server side, which is what RLS does.
-- =========================================================================

-- 1) Make sure the tables have the columns the app expects.
--    (Skip / adjust if your tables already look like this.)
create table if not exists accessories (
  code text primary key,
  name text not null,
  price numeric not null,
  discount numeric default 0,
  model text not null,
  cat text not null,
  description text default '',
  img_sr text,
  img_ex text
);

create table if not exists bundles (
  code text primary key,
  name text not null,
  price numeric not null,
  old_price numeric,
  model text not null,
  items jsonb not null default '[]',
  img text
);

-- If the "bundles" table already existed from before (no "img" column yet),
-- this adds it without touching any existing rows.
alter table bundles add column if not exists img text;

create table if not exists site_content (
  key text primary key,
  value jsonb not null
);

-- Admin allowlist: only user IDs listed here get write access, even if
-- more than one person ever ends up with a login on this project.
-- Locked down entirely — nobody can read/write it via the app itself,
-- only you via the Supabase SQL editor (step 6 below).
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table admins enable row level security;
-- (intentionally no policies on "admins" — default-deny for everyone,
-- including logged-in users; only editable from the SQL editor / dashboard)

-- 2) Turn on Row Level Security.
alter table accessories enable row level security;
alter table bundles enable row level security;
alter table site_content enable row level security;

-- 3) Public read access (the catalog itself must stay visible to everyone).
drop policy if exists "public read accessories" on accessories;
create policy "public read accessories" on accessories
  for select using (true);

drop policy if exists "public read bundles" on bundles;
create policy "public read bundles" on bundles
  for select using (true);

drop policy if exists "public read site_content" on site_content;
create policy "public read site_content" on site_content
  for select using (true);

-- 4) Writes (insert/update/delete) only for a user listed in "admins" —
--    not just "any signed-in user". This means even if someone else ever
--    gets a login on this Supabase project, they still can't edit the
--    catalog unless you explicitly add their user_id to "admins".
drop policy if exists "admin write accessories" on accessories;
create policy "admin write accessories" on accessories
  for all using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

drop policy if exists "admin write bundles" on bundles;
create policy "admin write bundles" on bundles
  for all using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

drop policy if exists "admin write site_content" on site_content;
create policy "admin write site_content" on site_content
  for all using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- =========================================================================
-- 5) One-time manual step: create your admin login.
--    Supabase Dashboard → Authentication → Users → "Add user"
--    Enter an email + password for yourself. Use that email/password to
--    sign in via the "מצב ניהול" (admin mode) button on the site.
--
-- 6) One-time manual step: add yourself to the "admins" allowlist.
--    Run this in the SQL editor AFTER creating your user in step 5
--    (replace the email with the one you used):
--
--      insert into admins (user_id)
--      select id from auth.users where email = 'you@example.com';
--
--    Without this step, even your own admin login will be able to READ
--    the catalog but NOT edit/delete anything — the allowlist is empty
--    by default.
--
-- 7) One-time manual step: stop strangers from creating their own accounts.
--    Supabase Dashboard → Authentication → Providers → Email →
--    turn OFF "Allow new users to sign up".
--    (Existing users, i.e. the admin account you created above, can still
--    sign in — this only blocks new self-service sign-ups.)
--
-- To add a second admin later, or remove yourself/someone: just run
-- another `insert into admins ...` (as above) or
-- `delete from admins where user_id = (select id from auth.users where email = '...')`.
-- =========================================================================
