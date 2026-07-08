import { handleSignIn } from "@logto/next/server-actions";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { logtoConfig } from "../../lib/logto";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  await handleSignIn(logtoConfig, request.nextUrl.searchParams);
  redirect("/fleet");
}
