-- A CRM FIELD IS NOT A FORM ANSWER.
--
-- The importer kept every column it was not told to use, on the reasoning that
-- an unrecognised column on a lead row is something the registrant typed. That
-- is one rule short. A GoHighLevel contacts export carries the CRM's own
-- bookkeeping in the same row as the form, and all of it was preserved as
-- answers:
--
--     Tags            1,394 leads, 72 distinct "answers" — round codes
--     Last Activity   1,149 leads, 278 distinct "answers" — timestamps
--
-- Both outranked the three real questions on the Form answers screen, which
-- 976 people actually answered. A reader looking for what registrants said
-- read two invented questions first, one of which offered "Sep 03 2026
-- 07:45 PM" as the most popular reply, given by 256 people.
--
-- The importer no longer stores these (`CRM_FIELD` in lib/import/pipeline.ts).
-- That fixes the next import and not this one: enrichment merges into what is
-- already stored and never deletes, by design, so a key written once stays
-- written. This removes what is there.
--
-- Nothing here touches a count. `answers` is read by v_form_questions and
-- v_form_answer_split and by nothing else — no metric, no rate, no total
-- depends on it. Verified after: 20,474.78 / 1,889 / 682 / 83,927.

begin;

-- The list is the CRM's field names, not a guess at what looks like noise. A
-- form question is a sentence a human wrote; these are column headers a system
-- wrote, and the difference is stable across exports.
update events
   set answers = answers
                 - 'Tags'
                 - 'Last Activity'
                 - 'Business Name'
                 - 'Contact Id'
                 - 'Additional Emails'
                 - 'Additional Phones'
                 - 'Time Zone'
                 - 'DND'
 where answers ?| array[
         'Tags', 'Last Activity', 'Business Name', 'Contact Id',
         'Additional Emails', 'Additional Phones', 'Time Zone', 'DND'
       ];

commit;

-- ── verify ───────────────────────────────────────────────────────────────────
-- Three questions, 976 leads each, and no timestamp among them.
--
--   select question, count(*) as distinct_answers, sum(leads) as leads
--     from v_form_answer_split
--    where client_id = 'shely'
--    group by question
--    order by leads desc;
--
-- Expect exactly:
--   What is your current profession?                      7 answers    976
--   What is your main challenge regarding AI currently?   4 answers    976
--   Are you open to attend a FREE webinar ... about AI?   2 answers    976
--
-- And the totals, which this must not have moved:
--
--   select m->>'spend', m->>'leads', m->>'att', m->>'rev'
--     from fo_cut('v_metrics_total', 'shely');
--
-- Read the first one through the anon key, not this editor. The editor is a
-- superuser and sees rows row-level security hides from the app; that
-- difference has already produced one false pass on this schema.
