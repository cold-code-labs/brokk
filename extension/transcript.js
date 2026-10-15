export function isFinalTurn(message) {
  return (
    message.type === "Turn" &&
    message.end_of_turn === true &&
    typeof message.transcript === "string" &&
    Boolean(message.transcript.trim())
  );
}
