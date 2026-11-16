// Formats prior conversation turns so both the router and the downstream
// agent can see "what was asked before / what came back" as real context,
// not just the latest isolated message.

export function formatHistoryForPrompt(history) {
  if (!history || !history.length) return "";
  return history
    .map((h) => `User: ${h.message}\nAssistant: ${h.result}`)
    .join("\n\n");
}

export function buildContextualMessage(history, message) {
  const transcript = formatHistoryForPrompt(history);
  if (!transcript) return message;
  return `Conversation so far:\n${transcript}\n\nNew request: ${message}`;
}
