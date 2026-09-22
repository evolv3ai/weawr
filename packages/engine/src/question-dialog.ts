// Recognise Claude Code's question dialog (AskUserQuestion) on an agent's pane. herdr reports an
// agent showing one as `blocked`, just as it does for a tool-permission prompt, but the two want
// different things from a person: a permission prompt is approved in the pane, a question can be
// answered from the issue. The dialog ends with its "Enter to select" footer; a permission prompt
// has no such footer, so it never parses. Pure: the pane's text in, the dialog or null out.

export interface DialogOption { n: number; label: string; description: string }
export interface QuestionDialog {
  header: string | null;
  question: string;
  options: DialogOption[];
  /** The number of the "Type something." option, which takes a free-text answer; null without one. */
  typeOption: number | null;
}

const FOOTER = /Enter to select/;
const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const RULE = /^[\s─━—-]+$/;
const TYPE_SOMETHING = /^Type something\.?$/i;
const CHAT = /^Chat about this\.?$/i;
/** An option's description sits under its label, indented past the "❯ 1." in front of it. */
const DESCRIPTION = /^\s{3,}\S/;
/** The dialog's tab bar: "☐ Tagline", or "← ☐ Tagline  ✔ Submit →" when it asks more than one thing. */
const TAB = /[☐☒☑✔✓]/;

/** The question dialog at the bottom of `paneText`, or null when its last lines are not one. */
export function parseQuestionDialog(paneText: string): QuestionDialog | null {
  const lines = String(paneText ?? '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!lines.length || !FOOTER.test(lines.at(-1)!)) return null;
  const footer = lines.length - 1;

  // The options run up from the footer, descriptions and rules between them, to the question.
  let first = -1;
  for (let i = footer - 1; i >= 0; i--) {
    const l = lines[i];
    if (OPTION.test(l)) { first = i; continue; }
    if (!l.trim() || RULE.test(l) || (DESCRIPTION.test(l) && !TAB.test(l))) continue;
    break;
  }
  if (first < 0) return null;

  const options: DialogOption[] = [];
  let typeOption: number | null = null;
  let last: DialogOption | null = null;
  for (let i = first; i < footer; i++) {
    const l = lines[i];
    const m = OPTION.exec(l);
    if (m) {
      const n = Number(m[1]); const label = m[2].trim();
      last = null;
      if (TYPE_SOMETHING.test(label)) typeOption = n;
      else if (!CHAT.test(label)) { last = { n, label, description: '' }; options.push(last); }
    } else if (last && DESCRIPTION.test(l) && !RULE.test(l)) {
      last.description = last.description ? `${last.description} ${l.trim()}` : l.trim();
    }
  }
  if (!options.length && typeOption === null) return null;

  // Above the options: the question, and above that the header in the dialog's tab bar.
  let q = first - 1;
  while (q >= 0 && !lines[q].trim()) q--;
  if (q < 0 || RULE.test(lines[q]) || TAB.test(lines[q])) return null;
  const question = lines[q].trim();
  const above = q > 0 ? lines[q - 1] : '';
  const header = TAB.test(above) ? above.replace(/[☐☒☑✔✓←→]/g, ' ').replace(/\s+/g, ' ').trim() || null : null;
  return { header, question, options, typeOption };
}

/** The dialog in Markdown for the issue: the question, then its options numbered as in the pane. */
export function describeDialog(dialog: QuestionDialog): string {
  const lines = [`> ${dialog.header ? `**${dialog.header}** — ` : ''}${dialog.question}`, ''];
  for (const o of dialog.options) lines.push(`${o.n}. **${o.label}**${o.description ? ` — ${o.description}` : ''}`);
  if (dialog.typeOption !== null) lines.push(`${dialog.typeOption}. _or answer in your own words_`);
  return lines.join('\n');
}
