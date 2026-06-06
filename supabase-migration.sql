-- Run this once for an existing Charge Note database.
-- Replace the email below with the account that should own existing rows.
begin;

alter table charging_sessions
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table station_rates
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

update charging_sessions
set user_id = (select id from auth.users where email = 'YOUR_LOGIN_EMAIL' limit 1)
where user_id is null;

update station_rates
set user_id = (select id from auth.users where email = 'YOUR_LOGIN_EMAIL' limit 1)
where user_id is null;

do $$
begin
  if exists (select 1 from charging_sessions where user_id is null)
     or exists (select 1 from station_rates where user_id is null) then
    raise exception 'Replace YOUR_LOGIN_EMAIL with a valid Supabase Auth user email';
  end if;
end $$;

alter table charging_sessions alter column user_id set default auth.uid();
alter table charging_sessions alter column user_id set not null;
alter table station_rates alter column user_id set default auth.uid();
alter table station_rates alter column user_id set not null;

alter table charging_sessions drop constraint if exists charging_sessions_peak_type_check;
alter table charging_sessions add constraint charging_sessions_peak_type_check
  check (peak_type is null or peak_type in ('on_peak','off_peak'));
alter table charging_sessions drop constraint if exists charging_sessions_kwh_check;
alter table charging_sessions add constraint charging_sessions_kwh_check check (kwh > 0);
alter table charging_sessions drop constraint if exists charging_sessions_price_check;
alter table charging_sessions add constraint charging_sessions_price_check check (price_before_disc >= 0);
alter table charging_sessions drop constraint if exists charging_sessions_discount_check;
alter table charging_sessions add constraint charging_sessions_discount_check
  check (discount >= 0 and discount <= price_before_disc);

alter table station_rates drop constraint if exists station_rates_type_check;
alter table station_rates add constraint station_rates_type_check check (rate_type in ('flat','peak'));
alter table station_rates drop constraint if exists station_rates_values_check;
alter table station_rates add constraint station_rates_values_check check (
  (rate_type = 'flat' and flat >= 0)
  or (rate_type = 'peak' and on_peak >= 0 and off_peak >= 0)
);

drop policy if exists "allow all" on charging_sessions;
drop policy if exists "users manage own charging sessions" on charging_sessions;
create policy "users manage own charging sessions" on charging_sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "allow all" on station_rates;
drop policy if exists "users manage own station rates" on station_rates;
create policy "users manage own station rates" on station_rates
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table station_rates drop constraint if exists station_rates_pkey;
alter table station_rates add primary key (user_id, station);
create index if not exists charging_sessions_user_date_idx
  on charging_sessions(user_id, date desc);

commit;
