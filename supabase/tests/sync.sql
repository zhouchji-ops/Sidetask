-- Run after bootstrap.sql and the production migration in a disposable database.
-- Each assertion executes against PostgreSQL permissions, RLS, and PL/pgSQL.
begin;
do $$
begin
  if current_database() <> 'sidetask_sync_test'
      or current_setting('sidetask.test_mode', true) is distinct from 'on' then
    raise exception 'SideTask SQL tests require the disposable sidetask_sync_test database and sidetask.test_mode=on';
  end if;
end $$;

create schema sidetask_tests;
grant usage on schema sidetask_tests to anon, authenticated;
create function sidetask_tests.assert_true(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then raise exception 'Assertion failed: %', label; end if;
end $$;
-- SECURITY INVOKER is intentional: the attempted statement retains the tested role.
create function sidetask_tests.expect_error(statement text, expected_state text, label text)
returns void language plpgsql as $$
declare actual_state text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
    if actual_state = expected_state then return; end if;
    raise exception 'Assertion failed: % (expected SQLSTATE %, got %)', label, expected_state, actual_state;
  end;
  raise exception 'Assertion failed: % (statement unexpectedly succeeded)', label;
end $$;
create function sidetask_tests.document(title text) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'tasks', jsonb_build_array(jsonb_build_object(
      'id', 'shared-task', 'title', title, 'notes', '', 'priority', 'normal',
      'dueDate', null, 'dueTime', null, 'completed', false,
      'createdAt', '2026-10-01T12:00:00Z', 'completedAt', null, 'revision', 0)),
    'plans', jsonb_build_array(jsonb_build_object('taskId', 'shared-task', 'date', '2026-10-04', 'sortOrder', 0)),
    'taskOrder', jsonb_build_array('shared-task'), 'deadlineOrder', '[]'::jsonb)
$$;
create function sidetask_tests.empty_document() returns jsonb language sql immutable as $$
  select '{"tasks":[],"plans":[],"taskOrder":[],"deadlineOrder":[]}'::jsonb
$$;

insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

-- Anonymous callers have neither RPC execution rights nor direct table access.
set local role anon;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select sidetask_tests.expect_error('select public.sidetask_sync_head()', '42501', 'anonymous head denied');
select sidetask_tests.expect_error('select public.sidetask_sync_get()', '42501', 'anonymous get denied');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(0, 1, sidetask_tests.document('anonymous'))$q$, '42501', 'anonymous put denied');
select sidetask_tests.expect_error('select * from public.sidetask_sync_documents', '42501', 'anonymous table read denied');
reset role;

-- An authenticated role without a verified subject is also rejected by every RPC.
set local role authenticated;
set local request.jwt.claim.sub = '';
select sidetask_tests.expect_error('select public.sidetask_sync_head()', '42501', 'missing subject head denied');
select sidetask_tests.expect_error('select public.sidetask_sync_get()', '42501', 'missing subject get denied');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(0, 1, sidetask_tests.document('missing subject'))$q$, '42501', 'missing subject put denied');

-- Account A creates and updates its own document. The first insert is CAS-protected.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select sidetask_tests.assert_true(public.sidetask_sync_head() = '{"revision":0}'::jsonb, 'new account head');
select sidetask_tests.assert_true(public.sidetask_sync_get() = jsonb_build_object('revision', 0, 'protocolVersion', 1, 'data', sidetask_tests.empty_document()), 'new account empty document');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(1, 1, sidetask_tests.document('A1'))$q$, 'PT409', 'nonzero first CAS denied');
select sidetask_tests.assert_true(public.sidetask_sync_put(0, 1, sidetask_tests.document('A1')) = '{"revision":1}'::jsonb, 'first CAS insert');
select sidetask_tests.assert_true(public.sidetask_sync_put(0, 1, sidetask_tests.document('A1')) = '{"revision":1}'::jsonb, 'lost first response is idempotent');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(0, 1, sidetask_tests.document('stale A'))$q$, 'PT409', 'different stale insert denied');
select sidetask_tests.assert_true(public.sidetask_sync_put(1, 1, sidetask_tests.document('A2')) = '{"revision":2}'::jsonb, 'current CAS update');
select sidetask_tests.assert_true(public.sidetask_sync_put(1, 1, sidetask_tests.document('A2')) = '{"revision":2}'::jsonb, 'lost update response is idempotent');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(1, 1, sidetask_tests.document('A1'))$q$, 'PT409', 'old document cannot overwrite newer version');

-- Account B must not observe A, even though both documents contain the same Task ID.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
select sidetask_tests.assert_true(public.sidetask_sync_head() = '{"revision":0}'::jsonb, 'second account head isolated');
select sidetask_tests.assert_true(public.sidetask_sync_get()->'data' = sidetask_tests.empty_document(), 'second account cannot read first document');
select sidetask_tests.assert_true(public.sidetask_sync_put(0, 1, sidetask_tests.document('B1')) = '{"revision":1}'::jsonb, 'second account own insert');
select sidetask_tests.assert_true(public.sidetask_sync_get()->'data' = sidetask_tests.document('B1'), 'second account reads own document');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select sidetask_tests.assert_true(public.sidetask_sync_get() = jsonb_build_object('revision', 2, 'protocolVersion', 1, 'data', sidetask_tests.document('A2')), 'second account write leaves first account unchanged');

-- Direct reads and writes cannot bypass the RPC owner filter or CAS.
select sidetask_tests.expect_error('select * from public.sidetask_sync_documents', '42501', 'authenticated direct select denied');
select sidetask_tests.expect_error($q$insert into public.sidetask_sync_documents values ('00000000-0000-4000-8000-000000000001', 1, 1, '{}', now())$q$, '42501', 'authenticated direct insert denied');
select sidetask_tests.expect_error('update public.sidetask_sync_documents set revision = 100', '42501', 'authenticated direct update denied');
select sidetask_tests.expect_error('delete from public.sidetask_sync_documents', '42501', 'authenticated direct delete denied');
select sidetask_tests.expect_error('truncate public.sidetask_sync_documents', '42501', 'authenticated direct truncate denied');

-- Invalid protocol, version, shape, or device-local revisions never replace good data.
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 2, sidetask_tests.document('bad protocol'))$q$, '22023', 'unsupported protocol');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, null, sidetask_tests.document('null protocol'))$q$, '22023', 'null protocol');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(null, 1, sidetask_tests.document('null revision'))$q$, '22023', 'null expected revision');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(-1, 1, sidetask_tests.document('negative revision'))$q$, '22023', 'negative expected revision');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(9007199254740992, 1, sidetask_tests.document('unsafe revision'))$q$, '22023', 'unsafe expected revision');
select sidetask_tests.expect_error('select public.sidetask_sync_put(2, 1, null)', '22023', 'null document');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, '[]'::jsonb)$q$, '22023', 'array document');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, sidetask_tests.document('missing') - 'plans')$q$, '22023', 'missing document field');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, sidetask_tests.document('extra') || '{"settings":{}}'::jsonb)$q$, '22023', 'local settings prohibited');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('wrong array'), '{plans}', '{}'::jsonb))$q$, '22023', 'nonarray plans');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('local revision'), '{tasks,0,revision}', '1'::jsonb))$q$, '22023', 'device revision prohibited');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('string revision'), '{tasks,0,revision}', '"0"'::jsonb))$q$, '22023', 'revision must be numeric zero');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('missing revision'), '{tasks}', '[{}]'::jsonb))$q$, '22023', 'missing revision prohibited');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('scalar task'), '{tasks}', '[0]'::jsonb))$q$, '22023', 'task must be object');

-- Capacity limits are evaluated on the server as well as in the client.
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('large'), '{tasks,0,notes}', to_jsonb(repeat('x', 12 * 1024 * 1024))))$q$, '22023', 'oversized JSON document');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.empty_document(), '{tasks}', (select jsonb_agg(jsonb_build_object('revision', 0)) from generate_series(1, 10001))))$q$, '22023', 'task count limit');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.empty_document(), '{plans}', (select jsonb_agg('{}'::jsonb) from generate_series(1, 100001))))$q$, '22023', 'plan count limit');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('all order'), '{taskOrder}', '["a","b"]'::jsonb))$q$, '22023', 'all order length limit');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(2, 1, jsonb_set(sidetask_tests.document('deadline order'), '{deadlineOrder}', '["a","b"]'::jsonb))$q$, '22023', 'deadline order length limit');
select sidetask_tests.assert_true(public.sidetask_sync_get() = jsonb_build_object('revision', 2, 'protocolVersion', 1, 'data', sidetask_tests.document('A2')), 'failed writes preserve current document and revision');
reset role;

-- Probe the RLS policy separately from the stricter production table grants.
select sidetask_tests.assert_true((select relrowsecurity from pg_class where oid = 'public.sidetask_sync_documents'::regclass), 'RLS enabled');
grant select on public.sidetask_sync_documents to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select sidetask_tests.assert_true((select count(*) = 1 and bool_and(user_id = auth.uid()) from public.sidetask_sync_documents), 'RLS account A filter');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
select sidetask_tests.assert_true((select count(*) = 1 and bool_and(user_id = auth.uid()) from public.sidetask_sync_documents), 'RLS account B filter');
set local request.jwt.claim.sub = '';
select sidetask_tests.assert_true((select count(*) = 0 from public.sidetask_sync_documents), 'RLS missing subject sees nothing');
reset role;
revoke select on public.sidetask_sync_documents from authenticated;

-- Exhausted revisions reject new writes but allow confirmation of the same payload.
update public.sidetask_sync_documents set revision = 9007199254740991
  where user_id = '00000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select sidetask_tests.assert_true(public.sidetask_sync_put(9007199254740991, 1, sidetask_tests.document('A2')) = '{"revision":9007199254740991}'::jsonb, 'idempotency at safe revision limit');
select sidetask_tests.expect_error($q$select public.sidetask_sync_put(9007199254740991, 1, sidetask_tests.document('overflow'))$q$, '22023', 'revision increment cannot overflow');
select sidetask_tests.assert_true(public.sidetask_sync_get()->'data' = sidetask_tests.document('A2'), 'overflow retains prior data');
reset role;

-- Account removal cascades only its own cloud document.
delete from auth.users where id = '00000000-0000-4000-8000-000000000002';
select sidetask_tests.assert_true((select count(*) = 1 from public.sidetask_sync_documents), 'account deletion keeps other document');
select sidetask_tests.assert_true(not exists(select 1 from public.sidetask_sync_documents where user_id = '00000000-0000-4000-8000-000000000002'), 'account document cascade');

rollback;
select 'SideTask PostgreSQL sync assertions passed' as result;
