-- 140.42 of October spend is sitting in two September rounds.
--
-- WHAT IS WRONG.
--
-- A Meta pull on 9 Oct 2026 brought back 30 ad rows dated 2026-10-09. No round
-- covers that day — 1026-01 ends on the 5th — so the date rule found nothing
-- and lib/import/pipeline.ts fell through to its last resort, the campaign
-- name. Those campaigns are still running and are still NAMED after the rounds
-- that commissioned them:
--
--   12 rows   46.54   DF_SG_Preview_0926_02_LP1&LP3_OldAds        -> 0926-02
--    6 rows   50.20   DF_SG_Preview_0926_04_LP1&LP3_NewVideoAds   -> 0926-04
--   12 rows   43.68   DF_SG_Preview_0926_04_LP1&LP3_NewAds        -> 0926-04
--
-- 0926-02's ads ran 09-04 to 09-16 and 0926-04's ran 09-24 to 09-29. This is
-- money spent three and a half weeks after the later of them closed, counted
-- against both. September is overstated by 140.42 and October has none of it.
-- The account total is right, which is exactly why nothing said so — the same
-- shape as the $596.99 the name-first rule would have moved the other way,
-- documented at lib/import/pipeline.ts:727.
--
-- THE FALLBACK IS NOT THE BUG. It exists for a period-level export whose rows
-- all carry the window's first day, and there it is the only thing that can
-- answer. It only misfires when a round is MISSING, which is the actual fault
-- here: Shely's rounds have been contiguous since 21 August — every one
-- starting the day after the last one ended, six in a row — and 1026-01 ended
-- on 5 October with nothing created after it.
--
-- ⚠️ AND IT HID SOMETHING ELSE. Those 12 rows are every ad row 0926-02 has.
-- Its own ads — 2026-09-04 to 2026-09-16 — were never imported, and the round
-- read 46.54 instead of reading empty. After this file it reads empty, which
-- is the truth, and the export still needs dropping in.
--
-- ── 1 · THE ROUND THAT SHOULD HAVE EXISTED ────────────────────────────────
--
-- START is not a guess. 1026-01 ends 2026-10-05 and this client's rounds have
-- been exactly contiguous for six consecutive rounds, so 1026-02 begins
-- 2026-10-06.
--
-- END IS AN ASSUMPTION, and the one thing in this file to check. The last two
-- rounds each ran six days (09-24→09-29 and 09-30→10-05) with the class the
-- next day, so this follows them: 10-06 → 10-11, class 10-12. If Shely's
-- actual schedule differs, correct it on the round screen — editing dates is
-- what it is for, and it will tell you which already-imported rows the new
-- window leaves outside.
--
-- NOT `on conflict do update`. A plain guarded insert, because the last file
-- that used do-update on a round id overwrote three of Shely's rounds. If
-- 1026-02 already exists this changes nothing and the check below will say so.

begin;

insert into rounds (round_id, code, client_id, start_date, end_date,
                    session_date, session_label, product_id, market)
select '1026-02', '1026-02', 'shely', '2026-10-06', '2026-10-11',
       '2026-10-12', 'Class 12 Oct 2026', 'shely-webinar', 'SG'
 where not exists (select 1 from rounds where round_id = '1026-02');

-- ── 2 · MOVE THE SPEND TO THE DAY IT WAS SPENT ON ─────────────────────────
--
-- This is not a reinterpretation. It is what the importer itself would now do
-- with these rows: once a round covers 2026-10-09 the date rule returns one
-- answer and never reaches the campaign name. Re-importing the same pull after
-- step 1 would file them to 1026-02 — this just saves doing that.
--
-- Guarded on the round actually being Shely's, so it cannot run against some
-- other client's 1026-02 if one is ever created.

update ads_performance a set round_id = '1026-02'
 where a.date = '2026-10-09'
   and a.round_id in ('0926-02', '0926-04')
   and exists (select 1 from rounds r
                where r.round_id = '1026-02' and r.client_id = 'shely'
                  and a.date between r.start_date and r.end_date);

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The 30 rows moved, and nothing else did:
--
--      select round_id, count(*), sum(spend)::numeric(12,2)
--        from ads_performance where date = '2026-10-09' group by 1;
--
--    Expect one row: 1026-02, 30, 140.42.
--
-- 2. September is back to what it actually spent:
--
--      select r.round_id, count(*) as rows, sum(a.spend)::numeric(12,2) as spend
--        from rounds r join ads_performance a on a.round_id = r.round_id
--       where r.round_id in ('0926-02','0926-04') group by 1 order by 1;
--
--    0926-04 goes from 223 rows / 2,484.88 to 205 rows / 2,391.00.
--
--    0926-02 GOES TO ZERO, and that is not this file's doing. Those 12
--    October rows are the ONLY ad rows it has ever had: its real ads, 09-04 to
--    09-16, were never imported. Until now that was hidden, because a round
--    showing 46.54 looks imported and a round showing nothing does not. The
--    number it displayed was October's, so moving it out does not lose
--    September's spend — it reveals that September's spend was never there.
--    0926-02's ads export still needs importing.
--
-- 3. No ad row sits outside the round it is filed to:
--
--      select r.round_id, count(*)
--        from rounds r join ads_performance a on a.round_id = r.round_id
--       where r.client_id = 'shely'
--         and (a.date < r.start_date or a.date > r.end_date)
--       group by 1;
--
--    Expect no rows. This was 0926-02 and 0926-04 before.
--
-- 4. The total did not move — no money was created or destroyed, only re-filed:
--
--      select sum(a.spend)::numeric(12,2)
--        from ads_performance a join rounds r on r.round_id = a.round_id
--       where r.client_id = 'shely';
--
--    Expect 23006.20, the same as before this file ran.
--
-- TO REVERSE, if the window turns out to be wrong:
--
--      update ads_performance set round_id = '0926-02'
--       where date = '2026-10-09' and campaign like '%0926_02%';
--      update ads_performance set round_id = '0926-04'
--       where date = '2026-10-09' and campaign like '%0926_04%';
--      delete from rounds where round_id = '1026-02';
