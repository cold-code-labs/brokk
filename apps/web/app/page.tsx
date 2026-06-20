import Board from "../components/Board";

/** Brokk board — kanban of tasks, live run logs (SSE), PR links. Wired to the
 *  control-plane API via @brokk/sdk through the same-origin /api proxy. */
export default function BoardPage() {
  return <Board />;
}
