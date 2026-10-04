-- Test fixture only. Never run this file in a Supabase project or a personal database.
-- Requires a disposable database named sidetask_sync_test and explicit test mode.
do $$
begin
  if current_database() <> 'sidetask_sync_test'
      or current_setting('sidetask.test_mode', true) is distinct from 'on' then
    raise exception 'SideTask SQL fixtures require the disposable sidetask_sync_test database and sidetask.test_mode=on';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key);
-- Supabase supplies the verified JWT claim. Tests set only synthetic UUIDs in a GUC.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
