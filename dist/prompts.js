                                           

/**
 * unoutloud — nudge templates.
 *
 * Each nudge is steered as a plugin-sourced user message right before the turn
 * would close. Budget: roughly 50-80 tokens each; the stray reply itself is
 * already in the model's context, so nothing is quoted back.
 *
 * The wording must make three things unmistakable:
 * 1. the previous reply ended the turn by mistake (the model should react),
 * 2. whether `retry_stray_call` is available (never invite a call that would
 *    fail — that is the "proper feedback" requirement),
 * 3. that ignoring the nudge and answering normally is always allowed.
 */

/**
 * Build the nudge text for a verdict.
 * @param verdict - detection result; `none` yields an empty string.
 * @param toolName - the configured retry tool name, mentioned only when the
 *   verdict is `retryable`.
 */
export function nudgeText(verdict         , toolName        )         {
  switch (verdict.kind) {
    case 'retryable':
      return (
        `Your previous reply wrote a tool call as plain text instead of making an actual ` +
        `tool call, so nothing executed and the turn was about to end. Was that a mistake? ` +
        `If yes, call ${toolName} now — it will run the detected call (tool: ${verdict.name}) ` +
        `with its parsed arguments as a real tool call. If it was intentional, ignore this ` +
        `and reply to the user normally.`
      );
    case 'shaped':
      return (
        `Your previous reply looks like a tool call written as plain text (${verdict.reason}), ` +
        `so nothing executed and the turn was about to end — but it cannot be retried ` +
        `automatically, so do NOT call ${toolName}. Was that a mistake? If yes, redo it as a ` +
        `real tool call yourself; if it was intentional, ignore this and reply normally.`
      );
    case 'xml-only':
      return (
        `Your previous reply was raw XML only, with no readable text for the user, and the ` +
        `turn was about to end. Was that a mistake? If you meant to run something, make a real ` +
        `tool call now; if you meant to show that XML, add a short plain-text explanation. ` +
        `Reply normally.`
      );
    default:
      return '';
  }
}
