-- Two rounds may share a week, if they do not share a campaign.
--
-- WHAT WAS REFUSED, AND BY WHAT.
--
-- FWD i-Care handed over three files called Round 1, 2 and 3. All three report
-- the same window — 2026-07-01 → 2026-10-06 — because they are not three weeks,
-- they are three EXPERIMENTS that ran at the same time:
--
--   Round 1   FWD_iCare{Chi,Eng}_META_MOFU_Sales_2026                      19 rows
--   Round 2   ..._2026_SingleAttribution[_PurchaseOptimised]               84 rows
--   Round 3   ..._2026_40To49 / ..._2026_50To60                            45 rows
--
-- Shely's rounds are consecutive weeks, so "a round is a window of time, and
-- two of them may not cover the same day" was true for every round that existed
-- and got written down as if it were true of rounds.
--
-- It was never the IMPORTER's rule. lib/import/pipeline.ts, where a day of
-- spend is actually filed, reads:
--
--     const round = (dateCandidates.length === 1 ? dateCandidates[0] : null)
--                   ?? campaignRound;
--
-- Two rounds covering one day does not make it guess — it falls through to the
-- campaign name, and refuses the row outright if that settles nothing. The
-- importer has always handled overlap. The rule lived in a validation function
-- in front of it, and was stricter than the thing it was protecting.
--
-- WHY A COLUMN AND NOT A RULE PER CLIENT.
--
-- roundFromCampaign already resolves a round from a campaign name, but only by
-- finding a round CODE inside it: DF_SG_Preview_Sprint1_0526_02 is 0526-02.
-- i-Care's campaign names carry no codes, and nobody is going to rename a live
-- ad account to suit us.
--
-- So a round says which campaigns are its own. Ten names across the three
-- files, three disjoint sets, nothing shared — the rounds were always
-- distinguishable, just not by a code.
--
-- EXACT NAMES, NOT A PATTERN. Round 1's campaign name is a PREFIX of all six
-- of the others, so any substring match files everything to Round 1, and
-- "longest tag wins" — the tie-break roundFromCampaign uses for 0526-03 versus
-- 0526-031 — gets it backwards here, because Round 1's whole name is longer
-- than the suffix that distinguishes Round 2. Exact equality needs no
-- tie-break and cannot be got backwards.
--
-- SAFE TO RE-RUN. Additive and nullable; no existing round is touched.
--
-- SHELY IS UNAFFECTED, and that is deliberate. The campaign step only fires
-- where the date is ALREADY ambiguous, which for consecutive weekly rounds is
-- never. Putting the campaign first instead re-files $7,500.26 across nine of
-- her rounds the moment anything is re-imported, with the account total still
-- reading 22,865.78 — the ruling in pipeline.ts that this must not disturb.

begin;

alter table rounds add column if not exists campaigns text[];

comment on column rounds.campaigns is
  'Exact Meta campaign names this round owns, or null. Only consulted when more '
  'than one round covers a day of spend — the date decides whenever it can, '
  'because spend belongs to the round it was spent during. Two rounds of one '
  'market may overlap only if both name campaigns and the two sets are '
  'disjoint; see lib/funnel/rounds.ts.';

/* A campaign may belong to one round, within a client. Two rounds claiming
   FWD_iCareChi_META_MOFU_Sales_2026 is the exact ambiguity the overlap rule
   exists to prevent, and the form's check is a check — this is the guarantee.
   Enforced as a trigger rather than an exclusion constraint because the
   overlap it must catch is between ARRAY ELEMENTS, which no btree or gist
   operator class on text[] expresses. */
create or replace function fo_rounds_campaigns_disjoint()
returns trigger language plpgsql as $$
declare
  clash_round text;
  clash_name  text;
begin
  if new.campaigns is null or cardinality(new.campaigns) = 0 then
    return new;
  end if;

  /* FOLDED AND TRIMMED, to match lib/funnel/rounds.ts exactly. The app
     considers 'FWD_iCareChi_...' and ' fwd_icarechi_... ' the same claim and
     refuses the second; a byte-equality check here would accept it, and the
     guarantee would be weaker than the form in front of it — which is the
     wrong way round for a backstop. Hence unnest rather than the && operator,
     which has no case-insensitive form. */
  select r.round_id, b
    into clash_round, clash_name
    from rounds r
   cross join lateral unnest(r.campaigns) as a
   cross join lateral unnest(new.campaigns) as b
   where r.client_id = new.client_id
     and r.round_id <> new.round_id
     and lower(btrim(a)) = lower(btrim(b))
   limit 1;

  if clash_round is not null then
    raise exception
      'round % already claims the campaign %', clash_round, clash_name
      using errcode = 'unique_violation';
  end if;
  return new;
end $$;

drop trigger if exists rounds_campaigns_disjoint on rounds;
create trigger rounds_campaigns_disjoint
  before insert or update of campaigns on rounds
  for each row execute function fo_rounds_campaigns_disjoint();

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The column is there and every existing round still reads null:
--
--      select count(*) as rounds, count(campaigns) as with_campaigns from rounds;
--
--    Expect with_campaigns = 0. Any other number means something was already
--    writing this column, which nothing should have been.
--
-- 2. Shely's spend is unchanged — this migration must move no money:
--
--      select sum(spend)::numeric(12,2) from ads_performance a
--        join rounds r on r.round_id = a.round_id where r.client_id = 'shely';
--
--    Expect 22865.78.
--
-- 3. The trigger refuses a second claim on one name:
--
--      begin;
--        update rounds set campaigns = array['X'] where round_id = (
--          select round_id from rounds where client_id = 'shely' order by start_date limit 1);
--        update rounds set campaigns = array['X'] where round_id = (
--          select round_id from rounds where client_id = 'shely' order by start_date offset 1 limit 1);
--      rollback;
--
--    The second update must raise 'already claims the campaign X'.
--    Then ROLLBACK, which the block above does for you.
