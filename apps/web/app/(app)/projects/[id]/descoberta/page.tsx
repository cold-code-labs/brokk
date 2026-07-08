"use client";

import { useParams } from "next/navigation";
import Discovery from "../../../../../components/Discovery";

export default function ProjectDiscoveryPage() {
  const params = useParams<{ id: string }>();
  return <Discovery projectId={params.id} />;
}
