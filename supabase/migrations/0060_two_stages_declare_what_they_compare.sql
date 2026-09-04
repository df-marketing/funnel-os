-- ═══════════════════════════════════════════════════════════════════════════
-- 0060 — two stages say what they compare.
--
-- Every stage tab compares along the dimension its journey declares. Two were
-- wrong, and both were built as tabs of their own instead of being fixed:
--
--   Leads (Reserved Seat / WhatsApp)   compare_dimension was NULL, and the tab
--     said so — "no landing-page dimension has been decided". There is one now,
--     read from the campaign that pointed at each page (0058).
--
--   Live Webinar Attendance            compared rounds.session_label, which on
--     this client is one distinct label per round — "Class 19 May", "Class 28
--     May", twelve of them. That tab was By round wearing different words. The
--     reminder sequence is what the stage is actually testing (0056).
--
-- Declarative only: the app routes on stage_slug, and this is the row that says
-- WHY. Left disagreeing, the next person reads the config and builds the wrong
-- thing — which is how both of these became separate tabs.
--
-- Safe to re-run. AcqOS owns this table; if it pushes a schema again it will
-- restate these, and this file is what to re-apply.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

update client_journey_config
   set compare_dimension = 'events.utm_campaign → landing page'
 where client_id = 'shely' and stage_slug = 'lp';

update client_journey_config
   set compare_dimension = 'events.variant → reminder sequence'
 where client_id = 'shely' and stage_slug = 'class';

select stage_order, stage_name, stage_slug, compare_dimension
  from client_journey_config
 where client_id = 'shely'
 order by stage_order;

commit;
