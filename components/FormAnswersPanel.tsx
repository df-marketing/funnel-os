export type FormAnswer = { question: string; answer: string; leads: number };

/**
 * The import preserves every unmapped lead-form field. This is the reading
 * surface for those answers: reported values, not a fake taxonomy imposed
 * after the fact. Free text is bounded at the display edge only.
 */
export function FormAnswersPanel({ rows }: { rows: FormAnswer[] }) {
  if (!rows.length) return (
    <div className="notice info"><span className="ico">?</span><div>
      <b>No captured form answers yet.</b> Re-import a leads export with its extra form columns.
      The importer keeps those values alongside the lead instead of throwing them away.
    </div></div>
  );
  const groups = new Map<string, FormAnswer[]>();
  for (const row of rows) groups.set(row.question, [...(groups.get(row.question) ?? []), row]);

  /*
   * ORDERED HERE, BECAUSE THE ROWS ARRIVE IN NO ORDER.
   *
   * The read asks PostgREST for the split with no `order`, so the sequence is
   * whatever the planner returned — stable enough to look deliberate, free to
   * change on the next read. Sorting on arrival means the page a reader
   * describes to someone else is the page that person opens.
   *
   * Most-answered question first: the one the whole list answered says more
   * about the audience than one a handful reached. Answers within a question
   * the same way, so the modal reply is the first line, and ties settle on the
   * text rather than on nothing.
   */
  const total = (answers: FormAnswer[]) => answers.reduce((n, a) => n + a.leads, 0);
  const questions = [...groups]
    .map(([question, answers]) => ({
      question,
      answers: [...answers].sort((a, b) => b.leads - a.leads || a.answer.localeCompare(b.answer)),
      leads: total(answers),
    }))
    .sort((a, b) => b.leads - a.leads || a.question.localeCompare(b.question));

  return <div className="form-splits">
    {questions.map(({ question, answers }) => <section className="form-split" key={question}>
      <h2>{question}</h2>
      <table className="plain"><thead><tr><th>Answer</th><th className="num">Leads</th></tr></thead>
        <tbody>{answers.slice(0, 30).map((row) => <tr key={row.answer}>
          <td>{row.answer}</td><td className="num">{row.leads.toLocaleString("en-SG")}</td>
        </tr>)}</tbody>
      </table>
      {answers.length > 30 ? <p className="cro-foot">{answers.length - 30} lower-frequency answers are retained but not shown here.</p> : null}
    </section>)}
  </div>;
}
