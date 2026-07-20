-- =========================================================================
-- Geely Accessories Catalog — Supabase security setup
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New
-- query). It enables Row Level Security (RLS) on all three tables and
-- creates policies so that:
--   * Anyone (the public catalog page) can READ accessories, bundles,
--     and site_content.
--   * Only a signed-in admin user can INSERT / UPDATE / DELETE.
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

-- 4) Writes (insert/update/delete) only for a signed-in (authenticated) user.
--    Combined with step 6 below (disabling public sign-ups + creating a
--    single admin account), this means only you can write to the catalog.
drop policy if exists "admin write accessories" on accessories;
create policy "admin write accessories" on accessories
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "admin write bundles" on bundles;
create policy "admin write bundles" on bundles
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "admin write site_content" on site_content;
create policy "admin write site_content" on site_content
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- =========================================================================
-- 5) One-time manual step: create your admin login.
--    Supabase Dashboard → Authentication → Users → "Add user"
--    Enter an email + password for yourself. Use that email/password to
--    sign in via the "מצב ניהול" (admin mode) button on the site.
--
-- 6) One-time manual step: stop strangers from creating their own accounts.
--    Supabase Dashboard → Authentication → Providers → Email →
--    turn OFF "Allow new users to sign up".
--    (Existing users, i.e. the admin account you created above, can still
--    sign in — this only blocks new self-service sign-ups.)
-- =========================================================================
