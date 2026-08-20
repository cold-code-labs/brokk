"use client";

import { useParams } from "next/navigation";
import BancadaPanel from "../../../../../components/Bancada";

/** A bancada do projeto: o ambiente quente onde o agente trabalha (ADR 0100). */
export default function BancadaPage() {
  const params = useParams<{ id: string }>();
  return (
    <div style={{ height: "calc(100vh - 120px)", padding: 16 }}>
      <BancadaPanel projectId={params.id} />
    </div>
  );
}
