export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  background = false,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(background ? { priority: "low" as const } : {}),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response
    .json()
    .catch(() => ({ error: "Resposta inválida." }));
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir.");
  return data as T;
}
