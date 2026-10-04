-- SideTask desktop sync protocol 1. Run this entire file in Supabase SQL Editor.
-- This migration changes only SideTask's table/functions; safe to run again.
begin;
create table if not exists public.sidetask_sync_documents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  protocol_version integer not null check (protocol_version = 1),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.sidetask_sync_documents enable row level security;
drop policy if exists sidetask_owner_read on public.sidetask_sync_documents;
create policy sidetask_owner_read on public.sidetask_sync_documents
  for select to authenticated using ((select auth.uid()) = user_id);
-- Clients use the owner-checked RPCs exclusively; direct mutations cannot bypass CAS.
revoke all on public.sidetask_sync_documents from public, anon, authenticated;

create or replace function public.sidetask_sync_head()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); current_revision bigint;
begin
  if owner_id is null then raise sqlstate '42501' using message = 'Authentication required'; end if;
  select revision into current_revision from public.sidetask_sync_documents where user_id = owner_id;
  return jsonb_build_object('revision', coalesce(current_revision, 0));
end $$;

create or replace function public.sidetask_sync_get()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); current_document public.sidetask_sync_documents%rowtype;
begin
  if owner_id is null then raise sqlstate '42501' using message = 'Authentication required'; end if;
  select * into current_document from public.sidetask_sync_documents where user_id = owner_id;
  if not found then
    return jsonb_build_object('revision', 0, 'protocolVersion', 1, 'data',
      jsonb_build_object('tasks', '[]'::jsonb, 'plans', '[]'::jsonb, 'taskOrder', '[]'::jsonb, 'deadlineOrder', '[]'::jsonb));
  end if;
  return jsonb_build_object('revision', current_document.revision,
    'protocolVersion', current_document.protocol_version, 'data', current_document.data);
end $$;

create or replace function public.sidetask_sync_put(expected_revision bigint, protocol_version integer, document jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); current_document public.sidetask_sync_documents%rowtype; next_revision bigint;
begin
  if owner_id is null then raise sqlstate '42501' using message = 'Authentication required'; end if;
  if expected_revision is null or expected_revision < 0 or expected_revision > 9007199254740991
      or protocol_version is distinct from 1 then
    raise sqlstate '22023' using message = 'Unsupported SideTask protocol or revision';
  end if;
  if document is null or jsonb_typeof(document) is distinct from 'object'
      or not (document ?& array['tasks', 'plans', 'taskOrder', 'deadlineOrder'])
      or (document - array['tasks', 'plans', 'taskOrder', 'deadlineOrder']) <> '{}'::jsonb
      or jsonb_typeof(document->'tasks') is distinct from 'array'
      or jsonb_typeof(document->'plans') is distinct from 'array'
      or jsonb_typeof(document->'taskOrder') is distinct from 'array'
      or jsonb_typeof(document->'deadlineOrder') is distinct from 'array' then
    raise sqlstate '22023' using message = 'Invalid SideTask document shape';
  end if;
  -- JSONB adds whitespace; clients additionally enforce 10 MiB serialized data.
  if octet_length(document::text) > 12 * 1024 * 1024
      or jsonb_array_length(document->'tasks') > 10000
      or jsonb_array_length(document->'plans') > 100000
      or jsonb_array_length(document->'taskOrder') > jsonb_array_length(document->'tasks')
      or jsonb_array_length(document->'deadlineOrder') > jsonb_array_length(document->'tasks') then
    raise sqlstate '22023' using message = 'SideTask document exceeds capacity';
  end if;
  if exists (select 1 from jsonb_array_elements(document->'tasks') t
      where jsonb_typeof(t) is distinct from 'object' or t->'revision' is distinct from '0'::jsonb) then
    raise sqlstate '22023' using message = 'Device revisions cannot be uploaded';
  end if;
  -- Serializes the first insert as well as updates for this account.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text, 0));
  select * into current_document from public.sidetask_sync_documents where user_id = owner_id for update;
  if found then
    -- An accepted request with a lost response is safe to repeat.
    if current_document.data = document and current_document.protocol_version = protocol_version then
      return jsonb_build_object('revision', current_document.revision);
    end if;
    if current_document.revision <> expected_revision then
      raise sqlstate 'PT409' using message = 'SideTask revision changed';
    end if;
    if current_document.revision = 9007199254740991 then
      raise sqlstate '22023' using message = 'SideTask revision limit reached';
    end if;
    next_revision := current_document.revision + 1;
    update public.sidetask_sync_documents set revision = next_revision, data = document,
      updated_at = now() where user_id = owner_id;
  else
    if expected_revision <> 0 then raise sqlstate 'PT409' using message = 'SideTask revision changed'; end if;
    next_revision := 1;
    insert into public.sidetask_sync_documents(user_id, revision, protocol_version, data)
      values (owner_id, next_revision, protocol_version, document);
  end if;
  return jsonb_build_object('revision', next_revision);
end $$;

revoke all on function public.sidetask_sync_head() from public, anon, authenticated;
revoke all on function public.sidetask_sync_get() from public, anon, authenticated;
revoke all on function public.sidetask_sync_put(bigint, integer, jsonb) from public, anon, authenticated;
grant execute on function public.sidetask_sync_head() to authenticated;
grant execute on function public.sidetask_sync_get() to authenticated;
grant execute on function public.sidetask_sync_put(bigint, integer, jsonb) to authenticated;
commit;
