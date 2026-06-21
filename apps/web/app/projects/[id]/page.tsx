"use client";

import { useParams } from "next/navigation";
import Board from "../../../components/Board";

/** Per-project board — the forge for a single repo. */
export default function ProjectBoardPage() {
  const params = useParams<{ id: string }>();
  return <Board projectId={params.id} />;
}
