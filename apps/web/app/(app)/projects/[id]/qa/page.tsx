"use client";

import { useParams } from "next/navigation";
import QaPage from "../../../../../components/QaPage";

export default function ProjectQaRoute() {
  const params = useParams<{ id: string }>();
  return <QaPage projectId={params.id} />;
}
