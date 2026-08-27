-- ═══════════════════════════════════════════════════════════════════════════
-- Appointments, declared — and shown working on the demo client.
--
-- Two things in one file, and they are different in kind.
--
-- PART ONE declares the measurement. Two inserts, global, and inert: nothing
-- counts an appointment until a client's journey names the stage, and nothing
-- on any screen changes from these two rows alone. This is the part that is
-- permanent, and it is the whole answer to "shouldn't it be dynamic" — a
-- seventh metric arrives as data, in a database that shipped knowing six.
--
-- PART TWO is a demonstration on northsea_supply, so the thing can be seen
-- rather than described. It gives that client an Appointment stage and books
-- appointments for the people who already exist there. It touches no real
-- client, refuses to run anywhere northsea_supply is not flagged demo, and can
-- be removed by the rollback below without disturbing part one.
--
-- WHO GETS AN APPOINTMENT. Every lead who went on to buy, plus every other
-- remaining lead. A buyer who never booked would be a funnel that reads
-- backwards, and it is the kind of nonsense a fixture invents when nobody
-- thinks about who the rows represent.
--
-- The stage goes between Product page and Checkout, so Northsea's journey reads
-- Targeted views → Ads → Product page → Appointment → Checkout. That also
-- exercises 0049's generic rate on both sides of an inserted stage: Checkout's
-- rate has to start measuring from Appointment rather than from Product page,
-- without anything being told to.
--
-- ROLLBACK, part two only:
--   delete from events where event_type = 'appointment';
--   delete from client_journey_config where client_id='northsea_supply' and stage_slug='appointment';
--   update client_journey_config set stage_order = stage_order - 1
--    where client_id='northsea_supply' and stage_order >= 5;
-- ROLLBACK, part one:
--   delete from journey_metrics where metric = 'appointments';
--   delete from event_types where event_type = 'appointment';
-- ═══════════════════════════════════════════════════════════════════════════


-- ── PART ONE — the declaration ──────────────────────────────────────────────
insert into event_types (event_type, label, seq)
values ('appointment', 'Appointment', 35)
on conflict (event_type) do nothing;

insert into journey_metrics (metric, metric_key, label, source, event_type, product, is_core, seq)
values ('appointments', 'appt', 'Appointments', 'events', 'appointment', null, false, 35)
on conflict (metric) do nothing;


-- ── PART TWO — the demonstration, on the demo client only ───────────────────
do $$
begin
  if not exists (select 1 from client_flags where client_id = 'northsea_supply' and is_demo) then
    raise exception
      'northsea_supply is not flagged as a demo client here. Refusing to add a stage and fixture events to an account that may be real. Part one above has already committed and is safe on its own.';
  end if;
end $$;

-- Idempotent: remove anything a previous run of part two left.
delete from events
 where event_type = 'appointment'
   and round_id in (select round_id from rounds where client_id = 'northsea_supply');
delete from client_journey_config
 where client_id = 'northsea_supply' and stage_slug = 'appointment';

/*
 * Renumber to 1..n, THEN make room at 4.
 *
 * The first version shifted stage_order by +1 relative to itself, which is not
 * idempotent: the delete above removes the Appointment row but leaves the gap,
 * so a second run shifted everything again and Checkout drifted to 6. Caught by
 * applying this file twice, which is the only reason to bother applying it
 * twice.
 *
 * Compacting first makes the file's outcome depend on the journey's SHAPE
 * rather than on how many times it has run. Both passes offset by a thousand
 * before landing, because the primary key is (client_id, stage_order) and a
 * renumber that walks through occupied numbers collides with itself.
 */
update client_journey_config c set stage_order = t.rn + 1000
  from (
    select client_id, stage_order, row_number() over (order by stage_order) as rn
    from client_journey_config where client_id = 'northsea_supply'
  ) t
 where c.client_id = t.client_id and c.stage_order = t.stage_order;
update client_journey_config set stage_order = stage_order - 1000
 where client_id = 'northsea_supply' and stage_order > 1000;

update client_journey_config set stage_order = stage_order + 100
 where client_id = 'northsea_supply' and stage_order >= 4;
update client_journey_config set stage_order = stage_order - 99
 where client_id = 'northsea_supply' and stage_order >= 104;

insert into client_journey_config
  (client_id, stage_order, stage_name, stage_slug, stage_metric,
   compare_dimension, stage_rate_label, unit_price, client_name, client_note)
select
  'northsea_supply', 4, 'Appointment', 'appointment', 'appointments',
  -- No breakdown dimension, deliberately. Crediting an appointment to an ad set
  -- means joining through the acquiring lead, and 0049 does not do that — a tab
  -- promising a split it cannot compute is worse than no tab.
  null, 'booked', null,
  min(client_name), min(client_note)
from client_journey_config where client_id = 'northsea_supply';

/*
 * Book the appointments.
 *
 * Everyone who bought, first — a purchase that skipped the stage before it
 * would make the funnel read backwards — then every other remaining lead, so
 * the stage sits between its neighbours rather than above or below both.
 *
 * Dated a day after the opt-in, which keeps every one inside its own month and
 * week: 0044 and 0045 file an event by its own local day, and a fixture that
 * quietly straddled a boundary would be testing something nobody asked for.
 */
insert into events (
  contact_id, round_id, event_type, event_date, lead_round_id,
  source, match_status, is_lead, refund_amount
)
select
  l.contact_id, l.round_id, 'appointment',
  l.event_date + interval '1 day', l.round_id,
  l.source, 'demo', false, 0
from (
  select
    e.contact_id, e.round_id, e.event_date, e.source,
    exists (
      select 1 from events s
       where s.contact_id = e.contact_id and s.round_id = e.round_id and s.event_type = 'sale'
    ) as bought,
    row_number() over (order by e.round_id, e.contact_id) as rn
  from events e
  join rounds r on r.round_id = e.round_id
  where r.client_id = 'northsea_supply' and e.event_type = 'lead' and e.contact_id is not null
) l
where l.bought or l.rn % 2 = 0;
