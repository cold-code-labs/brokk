import { redirect } from "next/navigation";

/** Mímir UI terminated — Plan lives in Chat (OpenCode). */
export default function MimirPage() {
  redirect("/chat");
}
