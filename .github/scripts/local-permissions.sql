begin;
set local search_path = business_test, pg_catalog;

set local session authorization test_worker;
do $$
begin
  begin
    perform 1 from business_prod.permission_fixture limit 0;
    raise exception 'worker crossed schema';
  exception when insufficient_privilege then raise notice 'worker cross-schema read denied'; end;
  begin
    insert into business_prod.permission_fixture values (1);
    raise exception 'worker wrote across schema';
  exception when insufficient_privilege then raise notice 'worker cross-schema write denied'; end;
  begin
    create table business_test.permission_fixture(id integer);
    raise exception 'worker created a table';
  exception when insufficient_privilege then raise notice 'worker CREATE denied'; end;
  begin
    set role prod_worker;
    raise exception 'worker acquired production role';
  exception when insufficient_privilege then raise notice 'worker SET ROLE denied'; end;
end $$;

reset session authorization;
set local session authorization test_web;
do $$
begin
  begin
    perform 1 from business_prod.permission_fixture limit 0;
    raise exception 'website crossed schema';
  exception when insufficient_privilege then raise notice 'website cross-schema read denied'; end;
  begin
    create table business_test.permission_fixture(id integer);
    raise exception 'website created a table';
  exception when insufficient_privilege then raise notice 'website CREATE denied'; end;
end $$;
rollback;
