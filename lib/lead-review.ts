/**
 * lead-review — the local reviewer, and the grounded redraft it asks for.
 *
 * This exists to make the office's most important beat *true* rather than staged.
 *
 * The problem it solves: the reviewer sending work back is the single most memorable
 * moment in the office — it shows coordination, accountability, and a reason for the
 * system to exist. But an animation of that beat is only honest if a review genuinely
 * failed and the rework genuinely fixed something. Staging it would be exactly the kind
 * of lie this product is built to avoid.
 *
 * So there is a real deficiency to catch. `draftTemplate` in lead-engine produces a
 * perfectly generic message: "I'm following up on our earlier conversation. Is this
 * still something you would like to explore?" It references nothing the contact actually
 * said. That is a genuine quality failure — it will read as a mass email — and a
 * reviewer that catches it is doing real work.
 *
 * The rework is equally real: `groundedDraft` rewrites the message around an actual
 * quote from the supplied notes, so the second version references the history and the
 * evidence supports it.
 *
 * Kept separate from `lead-engine.ts` deliberately. That module is the strongest code in
 * the repo and is not being rewritten; this adds capability alongside it.
 */

import type { Lead } from './lead-engine.ts';

/**
 * Words too common to count as "referencing the history".
 *
 * Deliberately small: the check should be easy to reason about, and a false *pass* here
 * (a draft slipping through because it happened to share a common word) is much worse
 * than a false fail, because it means the office shows an approval that was not earned.
 */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'would', 'could',
  'should', 'which', 'while', 'where', 'asked', 'wanted', 'still', 'thing',
  'things', 'something', 'follow', 'following', 'conversation', 'conversations',
  'contact', 'contacted', 'reconnect', 'explore', 'interested', 'interest', 'note',
  'notes', 'request', 'requested', 'business', 'businesses', 'company', 'companies',
  'later', 'earlier', 'month', 'months', 'week', 'weeks', 'september', 'august',
  'november', 'march', 'discovery', 'session', 'pilot', 'short', 'small', 'start',
]);

/** Content words of five or more letters, lowercased. */
function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z'-]{4,}/g) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

export type ReviewOutcome = {
  approved: boolean;
  /** The reviewer's own words, rendered verbatim in the office. Never paraphrased. */
  reason: string;
  /** Words from the history the draft did pick up, for the inspection panel. */
  grounding: string[];
};

/**
 * Check a draft against the lead's own records.
 *
 * The rule: the draft must reference something specific that this contact actually said.
 * Words contributed by the offer text are excluded from the comparison, because those
 * come from the sender, not from the conversation — a draft is not personalised just
 * because the sender's own boilerplate happens to share vocabulary with the notes.
 */
export function reviewDraft(lead: Lead, draft: string, offer: string): ReviewOutcome {
  const history = lead.sources.map((source) => source.notes).join(' ');
  if (!history.trim()) {
    // Nothing was supplied to reference, so there is nothing to fail on. Approving here
    // is honest: the draft is as grounded as the record allows.
    return { approved: true, reason: 'No conversation history was supplied to check against.', grounding: [] };
  }

  const fromHistory = contentWords(history);
  const fromOffer = contentWords(offer);
  const inDraft = contentWords(draft);

  const grounding = [...inDraft].filter((word) => fromHistory.has(word) && !fromOffer.has(word));

  if (grounding.length === 0) {
    return {
      approved: false,
      reason:
        'The draft does not reference anything this contact actually said — it reads as a mass email. Ground it in the supplied notes.',
      grounding: [],
    };
  }

  return {
    approved: true,
    reason: `The draft references the supplied history (${grounding.slice(0, 3).join(', ')}).`,
    grounding,
  };
}

/**
 * The longest supplied note, which is the best single piece of evidence to quote.
 *
 * Longest rather than newest: a one-line "follow-up note" is usually an addendum, while
 * the substantial note is the one that says what the contact actually wanted.
 */
function bestNote(lead: Lead): { row: number; text: string } | null {
  const candidates = lead.sources
    .filter((source) => source.notes.trim().length > 0)
    .sort((a, b) => b.notes.trim().length - a.notes.trim().length);
  const best = candidates[0];
  return best ? { row: best.row, text: best.notes.trim() } : null;
}

/** Trim a note to its first sentence, so the quote reads naturally in a message. */
function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim();
}

/**
 * Rewrite a draft so it references the conversation, quoting the record it came from.
 *
 * This is a genuine improvement, not a cosmetic one: the message now contains a specific
 * the contact themselves supplied, which is exactly what the reviewer asked for. The
 * quote is copied verbatim from the source note so the claim is checkable — the
 * inspection panel shows the row it came from.
 */
export function groundedDraft(
  lead: Lead,
  offer: string,
): { subject: string; draft: string; evidence: string[] } {
  const name = lead.name.split(' ')[0];
  const note = bestNote(lead);

  const reference = note
    ? `When we last spoke, you mentioned: “${firstSentence(note.text)}”`
    : 'I wanted to pick up where our earlier conversation left off.';

  return {
    subject: `Picking up our conversation${lead.company ? ` — ${lead.company}` : ''}`,
    draft:
      `Hi ${name},\n\n` +
      `${reference}\n\n` +
      `${offer.trim()}\n\n` +
      'Is that still worth a short conversation?',
    evidence: note
      ? [`Row ${note.row}: ${note.text}`]
      : lead.sources.filter((source) => source.notes).map((source) => `Row ${source.row}: ${source.notes}`),
  };
}
