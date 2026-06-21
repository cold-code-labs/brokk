import { signIn } from "@logto/next/server-actions";
import { redirect } from "next/navigation";

import { authEnabled, logtoConfig } from "../../lib/logto";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!authEnabled) {
    redirect("/");
  }
  await signIn(logtoConfig);
}
