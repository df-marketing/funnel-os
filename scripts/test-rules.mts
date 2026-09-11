/**
 * PROPOSING A RULE.
 *
 * The screen's whole value is that accepting a proposal is safer than typing
 * one. That only holds if a proposal is never confidently wrong — so the cases
 * pinned here are mostly the ones where the right answer is to propose NOTHING:
 * a prefix every campaign shares splits nothing, a source already explained is
 * not news, and a value that can never match is refused before it is saved.
 *
 * Coverage is deliberately not tested here, because it is deliberately not
 * implemented here — fo_resolve answers it, so that one matcher exists rather
 * than two that can drift.
 */
import {
  prefixesOf, proposeFromCampaigns, proposeFromSources, nextOrd, whyInvalid, cleanKey,
} from "../lib/funnel/rules";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const none = new Set<string>();

console.log("\nPrefixes — the segments a campaign name offers");
{
  eq("longest first, so the most specific proposal comes first",
     prefixesOf("DF_SG_WEBINAR_0526_01"), ["DF_SG_WEBINAR", "DF_SG", "DF"]);
  eq("hyphens and slashes are delimiters too",
     prefixesOf("df-my-webinar"), ["df_my", "df"]);
  eq("a name with no delimiter offers nothing to split on",
     prefixesOf("summer"), []);
}

console.log("\nCampaigns — propose a split, never a catch-all");
{
  const campaigns = [
    "DF_SG_WEBINAR_0526_01", "DF_SG_WEBINAR_0526_02",
    "DF_MY_WEBINAR_0526_01", "DF_MY_WEBINAR_0526_02",
  ];
  const got = proposeFromCampaigns(campaigns, none);
  eq("proposes the two markets, not the DF they share",
     got.map((p) => p.key).sort(), ["MY", "SG"]);
  /* DF_SG, not DF_SG_WEBINAR. Both split this set; the shorter one keeps
     working when DF_SG_MASTERCLASS turns up, where the longer silently stops
     matching and that spend lands nowhere. */
  eq("prefers the shortest prefix that still splits",
     got.find((p) => p.key === "SG")!.rule,
     { op: "starts_with", field: "campaign", value: "DF_SG" });

  /* And it must still lengthen when the short prefix does NOT split: here DF_SG
     covers everything, so only the WEBINAR/MASTERCLASS level separates them. */
  eq("lengthens when the short prefix explains everything",
     proposeFromCampaigns(
       ["DF_SG_WEBINAR_01", "DF_SG_WEBINAR_02", "DF_SG_MASTERCLASS_01"], none,
     ).map((p) => p.rule.value).sort(),
     ["DF_SG_MASTERCLASS", "DF_SG_WEBINAR"]);

  /* The case that would make the screen useless: a prefix on EVERY campaign
     explains nothing, and offering it as a split is offering a catch-all under
     a different name. */
  eq("a prefix shared by every campaign is not a split",
     proposeFromCampaigns(["DF_A", "DF_B", "DF_C"], none).filter((p) => p.rule.value === "DF"), []);

  eq("one campaign is not a pattern", proposeFromCampaigns(["DF_SG_X"], none), []);
  eq("nothing to propose when everything is already explained",
     proposeFromCampaigns(campaigns, new Set(campaigns)), []);
}

console.log("\nSources — the column that makes affiliate work");
{
  const rows = ["affiliate_partner", "affiliate_partner", "affiliate_partner", "organic"];
  const got = proposeFromSources(rows, none);
  eq("the commonest unexplained source comes first", got[0].key, "Affiliate Partner");
  eq("counted, so the claim can be checked", got[0].matches, 3);
  eq("exact match on the source column, never a substring",
     got[0].rule, { op: "is", field: "source", value: "affiliate_partner" });
  eq("an explained source is not proposed again",
     proposeFromSources(rows, new Set(["affiliate_partner"])).map((p) => p.key), ["Organic"]);
  eq("blank source values are not a source", proposeFromSources(["", "  "], none), []);
}

console.log("\nOrder — a new value must not land behind the catch-all");
{
  eq("first value of a dimension", nextOrd([]), 10);
  eq("after the last specific one",
     nextOrd([{ ord: 10, flags: {} }, { ord: 20, flags: {} }]), 30);
  /* The one that matters: land after the catch-all and the new value can never
     match, because the catch-all has already taken everything. */
  eq("ahead of a catch-all, never behind it",
     nextOrd([{ ord: 10, flags: {} }, { ord: 90, flags: { catch_all: true } }]), 20);
  eq("squeezed in when there is no room after the last specific value",
     nextOrd([{ ord: 10, flags: {} }, { ord: 15, flags: { catch_all: true } }]), 10);
}

console.log("\nValidation — refuse what cannot work, and say why");
{
  const ok = { target: "source" as const, key: "Affiliate", rules: [{ op: "is" as const, field: "source" as const, value: "aff" }] };
  eq("a sound value saves", whyInvalid(ok), null);

  /* A value with no rules and no catch-all flag is a column of dashes that
     looks exactly like a broken filter. */
  eq("no rules and no catch-all is refused",
     whyInvalid({ ...ok, rules: [] }),
     "a value with no rules matches nothing — add a rule, or mark it the catch-all");
  eq("no rules IS fine for a catch-all",
     whyInvalid({ ...ok, rules: [], flags: { catch_all: true } }), null);

  eq("an operator nobody implemented is refused rather than matching everything",
     whyInvalid({ ...ok, rules: [{ op: "sounds_like" as never, field: "source", value: "x" }] }),
     "'sounds_like' is not an operator this app implements");
  eq("a field a lead does not carry is refused",
     whyInvalid({ ...ok, rules: [{ op: "is", field: "utm_source" as never, value: "x" }] }),
     "'utm_source' is not a field a lead carries");
  eq("contains with nothing to contain is refused",
     whyInvalid({ ...ok, rules: [{ op: "contains", field: "campaign", value: "  " }] }),
     "contains needs something to match against");
  eq("is_empty needs no value", whyInvalid({ ...ok, rules: [{ op: "is_empty", field: "campaign", value: "" }] }), null);
  eq("a regex that does not parse is caught here, not at read time",
     whyInvalid({ ...ok, rules: [{ op: "regex", field: "campaign", value: "DF_(SG" }] }),
     "that regular expression does not parse: DF_(SG");
  eq("a value needs a key", whyInvalid({ ...ok, key: "   " }), "a value needs a key");
}

console.log("\nKeys — narrow, but not lowercased");
{
  eq("case is kept, because SG is how people write it", cleanKey("  SG  "), "SG");
  eq("inner whitespace collapses", cleanKey("Lead   Form"), "Lead Form");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
