import type { LeadRoundMatches, RoundTagEvidence } from "@/lib/import/lead-round-evidence";

type Props = {
  evidence: RoundTagEvidence;
  matches?: LeadRoundMatches;
  chooseSource?: boolean;
};

/** A clue from the file, not a row assignment. No original tags or people. */
export function LeadRoundEvidence({ evidence, matches, chooseSource }: Props) {
  if (evidence.tagColumn === "ambiguous") return (
    <div className="notice info" aria-label="Round tag evidence">
      <div><b>More than one Tags column was found.</b> No round tag suggestion was made. Review the
        export and add an explicit Round column if needed.</div>
    </div>
  );
  const { dominant, topCodes } = evidence;
  return (
    <div className="notice info" aria-label="Round tag evidence">
      <div>
        <b>Round tags found in the file</b>
        <p>
          {evidence.withRoundCode} of {evidence.rows} rows contain a round code
          {" · "}{evidence.withoutRoundCode} without a round code
          {" · "}{evidence.blankTagRows} blank Tags
          {" · "}{evidence.multiTagRows} with multiple tags
          {" · "}{evidence.ambiguousRoundRows} with conflicting round codes.
        </p>
        {dominant ? <p>
          Suggested round code: <b className="num">{dominant.code}</b> ({dominant.count} of {evidence.rows} rows contain it; {dominant.unambiguousCount} name it without another round code).
        </p> : <p>
          No single round code is named without conflict by a majority of rows.
          {topCodes.length ? <> Most frequent observed codes: {topCodes.map(({ code, count }) => `${code} (${count})`).join(", ")}.</> : null}
        </p>}
        {chooseSource ? <p>If this is a Leads export, choose <b>Leads</b> to review its columns and matching client rounds. Tags alone are not opt-in dates.</p> : <>
          {matches?.status === "verified" ? matches.rounds.length ? <>
            <p>{matches.rounds.length > 1
              ? "More than one existing round matches this code. Verify the market and use the exact round ID in the file."
              : "Existing round for this client. Verify it before using its exact ID in the file."}</p>
            <ul>{matches.rounds.map((round) => <li key={round.roundId}>
              <b className="num">{round.roundId}</b>{round.market ? ` (${round.market})` : ""}
            </li>)}</ul>
            {matches.truncated ? <p>More matching rounds exist. Review the client’s rounds before choosing.</p> : null}
          </> : <p>No round with this code was found for this client. <a href="#import-round-setup">Go to Add a round</a> if you have verified the real schedule.</p>
            : matches?.status === "unavailable" ? <p>Could not verify this client’s rounds. <a href="#import-round-setup">Check the round setup</a> before continuing.</p> : null}
          <p>Tags are not assigned automatically. Verify the destination for each row; use a <b>Round</b> column with the exact ID if the date does not identify one round. Real opt-in dates are still required.</p>
        </>}
      </div>
    </div>
  );
}
