-- ═══════════════════════════════════════════════════════════════════════════
-- 0066 — a campaign with no page token is a Lead Form, and a bare LP is LP1.
--
-- 0058 read LP1 and LP2 out of the campaign name and deliberately left two
-- cases unmapped, because nothing in the data decided them:
--
--   "Two campaigns say LP with no number — 0626_02_LP and 0726_01_AI_LP,
--    $1,970 between them — ... the two readings give different answers and
--    nothing in the data decides it, so they are left unmapped."
--
--   "Nine more campaigns carry no LP token at all. Those rounds ran before the
--    test; they are not a third page and not a zero."
--
-- That was the right call with nothing to go on. The client has now ruled, and
-- the ruling supersedes both notes:
--
--   LP2 in the name          → Landing Page 2
--   LP1, or a bare LP        → Landing Page 1
--   no LP token at all       → LEAD FORM — no landing page, a direct lead form,
--                              and a real arm of the lead-gen test rather than
--                              an absence
--
-- The third line is the substantive change. "Lead Form" is a page-equivalent
-- that people actually converted on, so it belongs in the comparison as its own
-- column. Returning it instead of NULL is enough on its own: v_metrics_by_lp
-- and v_metrics_by_lp_round already filter on `is not null`, so those rows
-- start being counted without either view being touched.
--
-- ── ORDER MATTERS ──────────────────────────────────────────────────────────
-- LP2 is tested FIRST. 'LP2' contains 'LP', so a bare-LP branch placed above it
-- would swallow every LP2 campaign into LP1 — the exact bug this rule invites.
--
-- ── WHAT IS STILL NOT CLASSIFIED, AND WHY ──────────────────────────────────
-- Measured on the client's 1,469-row contact export (0926-01 folder):
--
--   588  a name carrying LP1 / LP1GHL / LP1GHLHenry / LP1GHL_AcqOS / bare LP
--   209  a name carrying LP2
--   434  a real campaign name with no LP token       → now Lead Form
--   ----
--   117  a bare Meta campaign ID (120249100531520425) — a number, not a name.
--        It names no page and it is not evidence of a lead form; reading it as
--        one would invent an arm out of an unresolved ID.
--   118  no utm_campaign at all. The rule is about what a campaign name says;
--        a row with no campaign has not said anything.
--     3  '{{campaign.name}}' — an unrendered merge tag. Broken tracking, and
--        the one thing it is definitely not is a deliberate lead form.
--
-- All three stay NULL and keep reading as "Not stated". Folding them into Lead
-- Form would put 238 rows — 16% of the export — into an arm on no evidence, and
-- the Lead Form column exists to be compared, so a padded one is worse than a
-- small one. If the client confirms any of the three IS the lead form, that is
-- a one-line change here.
--
-- Purely a read-path change: one function, no table touched, no backfill.
-- Safe to re-run.
--
-- ROLLBACK — restores 0058's function exactly:
--   create or replace function fo_landing_page(p_campaign text)
--   returns text language sql immutable as $$
--     select case
--       when p_campaign is null then null
--       when upper(p_campaign) ~ 'LP\s*1' then 'LP1'
--       when upper(p_campaign) ~ 'LP\s*2' then 'LP2'
--     end;
--   $$;
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function fo_landing_page(p_campaign text)
returns text
language sql
immutable
as $$
  select case
    -- Nothing to read.
    when p_campaign is null then null
    when btrim(p_campaign) = '' then null

    -- An unrendered merge tag is broken tracking, not a campaign name.
    when p_campaign like '%{{%' then null

    -- A bare Meta campaign ID names no page. Digits, and optionally the
    -- separators an exported ID list carries.
    when btrim(p_campaign) ~ '^[0-9][0-9\s,._-]*$' then null

    -- LP2 before LP1, and both before the bare token: 'LP2' contains 'LP'.
    when upper(p_campaign) ~ 'LP\s*2' then 'LP2'
    when upper(p_campaign) ~ 'LP\s*1' then 'LP1'
    when upper(p_campaign) ~ 'LP'     then 'LP1'

    -- A real campaign name that names no page: the direct lead form.
    else 'Lead Form'
  end;
$$;

grant execute on function fo_landing_page(text) to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- Every distinct campaign and what it now reads as. Expect no campaign name to
-- land on NULL except the three groups named above.
--
--   select fo_landing_page(campaign) as page, count(*) as ad_rows,
--          count(distinct campaign) as campaigns
--     from v_ads
--    group by 1 order by 2 desc;
--
--   select fo_landing_page(utm_campaign) as page, count(*) as leads
--     from v_events where event_type = 'lead'
--    group by 1 order by 2 desc;
