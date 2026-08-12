import { Banner } from "@cold-code-labs/yggdrasil-react";
import Users from "../../../components/Users";
import { getSession } from "../../../lib/logto";
import { atLeast } from "../../../lib/rbac";

/** Crew / Max seats — Admin or Proprietário (or CCL staff) only. */
export default async function UsersPage() {
  const session = await getSession();
  const allowed =
    session.isCclStaff || atLeast(session.roles, "Admin") || session.authDisabled;
  if (!allowed) {
    return (
      <main style={{ maxWidth: 36 * 16, margin: "4rem auto", padding: "0 1.5rem" }}>
        <Banner tone="err">Crew management requires Admin or Proprietário.</Banner>
      </main>
    );
  }
  return <Users />;
}
