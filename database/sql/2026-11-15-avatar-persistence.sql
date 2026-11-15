-- 2026-11-15 — Avatar persistence: make the profile-photo chain reproducible.
--
-- WHY: the app has read/written user_preferences.avatar_url since the v16
-- storage-hardening era (frontend/js/app/app-09-settings.js + app-05), and
-- the live database has the column — but NO checked-in migration ever
-- created it. A fresh environment built from this repo (CI, a second
-- deployment, a disaster-recovery rebuild) would silently lose profile
-- photos: every SELECT of avatar_url would 42703-error the whole
-- loadUserProfile() call, leaving userProfile defaults (empty avatar_url),
-- which is exactly the "photo vanishes after logout/login" shape.
-- This migration makes the schema match what the code requires.
--
-- Companion policies: 2026-10-18-storage-hardening.sql already owns the
-- avatars-bucket RLS (owner-scoped writes, public read, 2MB cap,
-- MIME allowlist). This file only ensures the bucket exists on fresh
-- installs and adds the missing column — purely additive, idempotent,
-- preserves every existing row.

-- 1) the column the frontend reads and writes
alter table user_preferences
  add column if not exists avatar_url text;

-- 2) default to NULL-able empty string semantics the app expects
--    (app treats '' and NULL identically: no photo → initials avatar)

-- 3) ensure the avatars bucket exists on fresh installs (policies and
--    limits live in 2026-10-18-storage-hardening.sql, which follows this)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Backward compatibility: existing rows keep their values; the column is
-- additive with no NOT NULL constraint and no default rewrite, so the
-- upsert path in saveUserProfile() (partial-column upsert on user_id)
-- continues to work unchanged for every existing user.
