-- Promote Mantsatsi from viewer to manager (Aug 2026).
-- Managers can correct farmer records and — from schema v10 — correct synced
-- visit data in the app, with every edit logged in fs_visit_edits.
--
-- Run AFTER schema_v10_manager_edit.sql. Safe to run more than once.
-- If her username differs from the seeded first-name convention, any existing
-- manager can do the same thing in-app instead: Dashboard → Field team →
-- Role button on her row.

update fs_supervisors
   set role = 'manager'
 where username = 'mantsatsi'
   and role = 'viewer';
