import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import type {
  Artifact,
  Event,
  Kind,
  Organization,
  Project,
  RecordData,
  Role,
  User,
} from "../shared/domain.ts";
import { canEdit, emptyData } from "../shared/domain.ts";
export class Problem extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const iso = (v: unknown) => new Date(v as string).toISOString();
type Row = Record<string, unknown>;
const projectOf = (r: Row): Project => ({
  id: String(r.id),
  organizationId: String(r.organization_id),
  name: String(r.name),
  objective: String(r.objective),
  status: String(r.status),
  version: Number(r.version),
  updatedAt: iso(r.updated_at),
  repository: r.repository ? String(r.repository) : null,
  externalId: r.external_id ? String(r.external_id) : null,
});
const artifactOf = (r: Row): Artifact => ({
  id: String(r.id),
  projectId: String(r.project_id),
  kind: r.kind as Kind,
  title: String(r.title),
  status: String(r.status),
  data: { ...emptyData(), ...(r.data as RecordData) },
  version: Number(r.version),
  author: String(r.author),
  updatedAt: iso(r.updated_at),
});
export function createStore(url: string) {
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  type Db = postgres.TransactionSql<Record<string, never>>;
  async function event(
    db: Db,
    projectId: string,
    user: User,
    action: string,
    detail: string,
  ) {
    await db`insert into brokk_v2.events values (${randomUUID()},${projectId},${user.email},${action},${detail},now())`;
  }
  async function access(db: Db, projectId: string, user: User, edit = false) {
    const rows =
      await db`select p.*, o.name as org_name, o.external_id as org_external_id, m.role from brokk_v2.projects p join brokk_v2.organizations o on o.id=p.organization_id left join brokk_v2.members m on m.organization_id=o.id and m.email=${user.email} where p.id=${projectId} and (${user.admin} or m.email is not null)`;
    if (!rows.length) throw new Problem(404, "Projeto não encontrado.");
    const role: Role = user.admin ? "admin" : (rows[0].role as Role);
    if (edit && !canEdit(role))
      throw new Problem(
        403,
        "Você pode acompanhar e revisar; esta ação exige um operador.",
      );
    return {
      project: projectOf(rows[0]),
      organization: {
        id: String(rows[0].organization_id),
        name: String(rows[0].org_name),
        role,
        externalId: rows[0].org_external_id as string | null,
      } satisfies Organization,
    };
  }
  async function snapshot(db: Db, row: Artifact, user: User) {
    await db`insert into brokk_v2.versions values (${row.id},${row.version},${db.json(row as unknown as postgres.JSONValue)},${user.email},now())`;
  }
  async function insert(
    db: Db,
    projectId: string,
    kind: Kind,
    title: string,
    status: string,
    data: RecordData,
    user: User,
  ) {
    const rows =
      await db`insert into brokk_v2.artifacts (id,project_id,kind,title,status,data,author) values (${randomUUID()},${projectId},${kind},${title},${status},${db.json(data as unknown as postgres.JSONValue)},${user.email}) returning *`;
    const row = artifactOf(rows[0]);
    await snapshot(db, row, user);
    await event(db, projectId, user, `${kind}.created`, title);
    return row;
  }
  return {
    sql,
    async migrate() {
      await sql.begin(async (db) => {
        await db`select pg_advisory_xact_lock(42902381)`;
        await db.unsafe(
          await readFile(
            new URL("../db/migrations/0001_workspace.sql", import.meta.url),
            "utf8",
          ),
        );
      });
    },
    async session(token: string) {
      const rows =
        await sql`select identity from brokk_v2.sessions where digest=${hash(token)} and expires_at>now()`;
      return rows[0]?.identity as User | undefined;
    },
    async login(user: User) {
      const token = randomBytes(32).toString("base64url");
      await sql`insert into brokk_v2.sessions values (${hash(token)},${sql.json(user as unknown as postgres.JSONValue)},now()+interval '12 hours')`;
      return token;
    },
    async logout(token: string) {
      await sql`delete from brokk_v2.sessions where digest=${hash(token)}`;
    },
    async organizations(user: User) {
      const rows =
        await sql`select o.*,m.role from brokk_v2.organizations o left join brokk_v2.members m on m.organization_id=o.id and m.email=${user.email} where ${user.admin} or m.email is not null order by o.name`;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        externalId: r.external_id,
        role: user.admin ? "admin" : r.role,
      })) as Organization[];
    },
    async createOrganization(name: string, user: User) {
      if (!user.admin)
        throw new Problem(403, "Somente a administração cria organizações.");
      return sql.begin(async (db) => {
        const id = randomUUID();
        await db`insert into brokk_v2.organizations (id,name) values (${id},${name})`;
        await db`insert into brokk_v2.members values (${id},${user.email},'admin')`;
        return { id, name, role: "admin", externalId: null } as Organization;
      });
    },
    async member(orgId: string, email: string, role: Role, user: User) {
      return sql.begin(async (db) => {
        const rows =
          await db`select o.id,m.role from brokk_v2.organizations o left join brokk_v2.members m on m.organization_id=o.id and m.email=${user.email} where o.id=${orgId}`;
        if (!rows.length || (!user.admin && rows[0].role !== "admin"))
          throw new Problem(403, "Somente a administração gerencia acesso.");
        await db`insert into brokk_v2.members values (${orgId},${email},${role}) on conflict (organization_id,email) do update set role=excluded.role`;
        const ps =
          await db`select id from brokk_v2.projects where organization_id=${orgId}`;
        for (const p of ps)
          await event(
            db,
            String(p.id),
            user,
            "membership.updated",
            `${email}: ${role}`,
          );
      });
    },
    async projects(user: User) {
      const rows =
        await sql`select p.* from brokk_v2.projects p left join brokk_v2.members m on m.organization_id=p.organization_id and m.email=${user.email} where ${user.admin} or m.email is not null order by p.updated_at desc`;
      return rows.map(projectOf);
    },
    async createProject(
      orgId: string,
      name: string,
      objective: string,
      user: User,
    ) {
      return sql.begin(async (db) => {
        const rows =
          await db`select o.id,m.role from brokk_v2.organizations o left join brokk_v2.members m on m.organization_id=o.id and m.email=${user.email} where o.id=${orgId} and (${user.admin} or m.role in ('admin','operator'))`;
        if (!rows.length)
          throw new Problem(
            403,
            "Sem permissão para criar projetos nesta organização.",
          );
        const id = randomUUID();
        const p =
          await db`insert into brokk_v2.projects(id,organization_id,name,objective) values (${id},${orgId},${name},${objective}) returning *`;
        await event(db, id, user, "project.created", name);
        return projectOf(p[0]);
      });
    },
    async workspace(id: string, user: User) {
      return sql.begin(async (db) => {
        const base = await access(db, id, user);
        const records =
          await db`select * from brokk_v2.artifacts where project_id=${id} order by updated_at desc`;
        const events =
          await db`select * from brokk_v2.events where project_id=${id} order by at desc limit 150`;
        const members =
          base.organization.role === "admin"
            ? await db`select email,role from brokk_v2.members where organization_id=${base.organization.id} order by email`
            : [];
        return {
          ...base,
          records: records.map(artifactOf),
          events: events.map((r) => ({
            id: r.id,
            projectId: r.project_id,
            actor: r.actor,
            action: r.action,
            detail: r.detail,
            at: iso(r.at),
          })) as Event[],
          members: members as { email: string; role: Role }[],
        };
      });
    },
    async updateProject(
      id: string,
      version: number,
      patch: { name: string; objective: string; status: string },
      user: User,
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`update brokk_v2.projects set name=${patch.name},objective=${patch.objective},status=${patch.status},version=version+1,updated_at=now() where id=${id} and version=${version} returning *`;
        if (!rows.length)
          throw new Problem(409, "O projeto mudou. Atualize antes de salvar.");
        await event(db, id, user, "project.updated", patch.name);
        return projectOf(rows[0]);
      });
    },
    async repository(id: string, repository: string, user: User) {
      return sql.begin(async (db) => {
        const a = await access(db, id, user);
        if (a.organization.role !== "admin")
          throw new Problem(403, "Repositório exige administração técnica.");
        await db`update brokk_v2.projects set repository=${repository || null},version=version+1,updated_at=now() where id=${id}`;
        await event(
          db,
          id,
          user,
          "repository.configured",
          repository || "Desconectado",
        );
      });
    },
    async create(
      id: string,
      kind: Kind,
      title: string,
      status: string,
      data: RecordData,
      user: User,
    ) {
      return sql.begin(async (db) => {
        const a = await access(db, id, user, kind !== "feedback");
        if (kind === "feedback" && a.organization.role === "reader")
          throw new Problem(403, "Acesso somente leitura.");
        if (kind === "review") {
          const target =
            await db`select version from brokk_v2.artifacts where id=${data.targetId} and project_id=${id} and kind in ('scope','task','screen','component')`;
          if (
            !target.length ||
            Number(target[0].version) !== data.targetVersion
          )
            throw new Problem(409, "Selecione a versão atual do item.");
        }
        if (data.screenId) {
          const linked =
            await db`select id from brokk_v2.artifacts where project_id=${id} and id=${data.screenId} and kind='screen'`;
          if (!linked.length)
            throw new Problem(400, "Tela não encontrada neste projeto.");
        }
        if (kind === "scope") {
          await db`select id from brokk_v2.projects where id=${id} for update`;
          const existing =
            await db`select id from brokk_v2.artifacts where project_id=${id} and kind='scope'`;
          if (existing.length)
            throw new Problem(
              409,
              "Este projeto já possui escopo. Edite a versão existente.",
            );
        }
        return insert(db, id, kind, title, status, data, user);
      });
    },
    async update(
      id: string,
      item: string,
      version: number,
      title: string,
      status: string,
      data: RecordData,
      user: User,
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const prev =
          await db`select * from brokk_v2.artifacts where project_id=${id} and id=${item} and version=${version} for update`;
        if (!prev.length)
          throw new Problem(409, "O item mudou. Atualize antes de salvar.");
        if (["review", "run", "call"].includes(prev[0].kind))
          throw new Problem(403, "Use a ação específica deste item.");
        const nextStatus = prev[0].status === "approved" ? "draft" : status;
        const rows =
          await db`update brokk_v2.artifacts set title=${title},status=${nextStatus},data=${db.json(data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        const row = artifactOf(rows[0]);
        await snapshot(db, row, user);
        await db`update brokk_v2.artifacts set status='changes',version=version+1,updated_at=now() where project_id=${id} and kind='review' and data->>'targetId'=${item} and status='approved'`;
        await event(db, id, user, `${row.kind}.updated`, title);
        return row;
      });
    },
    async review(
      id: string,
      item: string,
      version: number,
      decision: string,
      feedback: string,
      user: User,
    ) {
      return sql.begin(async (db) => {
        const a = await access(db, id, user);
        if (a.organization.role === "reader")
          throw new Problem(403, "Acesso somente leitura.");
        const rows =
          await db`select * from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='review' and version=${version} for update`;
        if (!rows.length)
          throw new Problem(409, "A revisão mudou. Atualize antes de decidir.");
        const r = artifactOf(rows[0]);
        const target =
          await db`select * from brokk_v2.artifacts where id=${r.data.targetId} and project_id=${id} for update`;
        if (
          !target.length ||
          Number(target[0].version) !== r.data.targetVersion
        )
          throw new Problem(
            409,
            "O item foi alterado. Solicite uma nova revisão.",
          );
        r.data.body = feedback;
        r.data.reviewedBy = user.email;
        r.data.reviewedAt = new Date().toISOString();
        const next =
          await db`update brokk_v2.artifacts set status=${decision},data=${db.json(r.data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        if (decision === "approved")
          await db`update brokk_v2.artifacts set status='approved' where id=${r.data.targetId}`;
        await snapshot(db, artifactOf(next[0]), user);
        await event(
          db,
          id,
          user,
          `review.${decision}`,
          `${r.title}: ${feedback}`,
        );
        return artifactOf(next[0]);
      });
    },
    async versions(id: string, item: string, user: User) {
      return sql.begin(async (db) => {
        await access(db, id, user);
        return db`select v.version,v.snapshot,v.actor,v.at from brokk_v2.versions v join brokk_v2.artifacts a on a.id=v.artifact_id where a.project_id=${id} and a.id=${item} order by v.version desc`;
      });
    },
    async mutateCall(
      id: string,
      item: string,
      version: number,
      user: User,
      change: (record: Artifact) => void,
    ) {
      return sql.begin(async (db) => {
        const a = await access(db, id, user);
        if (a.organization.role === "reader")
          throw new Problem(403, "Acesso somente leitura.");
        const rows =
          await db`select * from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='call' and version=${version} for update`;
        if (!rows.length)
          throw new Problem(409, "A call mudou. Atualize antes de salvar.");
        const row = artifactOf(rows[0]);
        change(row);
        const updated =
          await db`update brokk_v2.artifacts set status=${row.status},data=${db.json(row.data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        await snapshot(db, artifactOf(updated[0]), user);
        await event(db, id, user, "call.updated", row.title);
        return artifactOf(updated[0]);
      });
    },
    async closeCall(id: string, item: string, version: number, user: User) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select * from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='call' and version=${version} for update`;
        if (!rows.length)
          throw new Problem(409, "A call mudou. Atualize antes de encerrar.");
        const row = artifactOf(rows[0]);
        if (row.status === "closed")
          throw new Problem(409, "A call já foi encerrada.");
        const changes = row.data.notes.filter((n) => n.category === "change");
        const tasks = [];
        for (const note of changes)
          tasks.push(
            await insert(
              db,
              id,
              "task",
              note.body.slice(0, 160),
              "backlog",
              {
                ...emptyData(),
                body: note.body,
                screenId: note.screenId,
                category: `call:${item}`,
                acceptance:
                  "Confirmar o ajuste na próxima review com o cliente.",
              },
              user,
            ),
          );
        row.data.summary = row.data.notes
          .map((n) => `${n.category}: ${n.body}`)
          .join("\n");
        const result =
          await db`update brokk_v2.artifacts set status='closed',data=${db.json(row.data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        await snapshot(db, artifactOf(result[0]), user);
        await event(
          db,
          id,
          user,
          "call.closed",
          `${row.title}: ${tasks.length} ajustes criados`,
        );
        return { call: artifactOf(result[0]), tasks };
      });
    },
    async reserveRun(
      id: string,
      taskId: string,
      key: string,
      user: User,
      dailyLimit: number,
      context = "",
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        await db`select pg_advisory_xact_lock(42902382)`;
        const old =
          await db`select * from brokk_v2.artifacts where project_id=${id} and kind='run' and data->>'requestKey'=${key}`;
        if (old.length) return { created: false, run: artifactOf(old[0]) };
        const task =
          await db`select * from brokk_v2.artifacts where id=${taskId} and project_id=${id} and kind='task'`;
        if (!task.length) throw new Problem(404, "Tarefa não encontrada.");
        const active =
          await db`select id from brokk_v2.artifacts where project_id=${id} and kind='run' and data->>'targetId'=${taskId} and status in ('launching','active','uncertain')`;
        if (active.length)
          throw new Problem(
            409,
            "Esta tarefa já tem uma execução em andamento.",
          );
        const counts =
          await db`select count(*)::int as n from brokk_v2.artifacts where kind='run' and updated_at>now()-interval '24 hours'`;
        if (counts[0].n >= dailyLimit)
          throw new Problem(429, "Limite diário de desenvolvimento atingido.");
        return {
          created: true,
          run: await insert(
            db,
            id,
            "run",
            String(task[0].title),
            "launching",
            {
              ...emptyData(),
              targetId: taskId,
              requestKey: key,
              body: context,
              targetVersion: Number(task[0].version),
            },
            user,
          ),
        };
      });
    },
    async providerUpdate(
      id: string,
      item: string,
      user: User,
      status: string,
      patch: Partial<RecordData>,
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`update brokk_v2.artifacts set status=${status},data=data || ${db.json(patch as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} and project_id=${id} and kind='run' returning *`;
        if (!rows.length) throw new Problem(404, "Sessão não encontrada.");
        await event(db, id, user, `run.${status}`, String(rows[0].title));
        return artifactOf(rows[0]);
      });
    },
    async handoff(input: {
      organizationId: string;
      organizationName: string;
      projectId: string;
      projectName: string;
      objective: string;
      email: string;
      name: string;
      role: "operator" | "client" | "reader";
    }) {
      return sql.begin(async (db) => {
        const organizations =
          await db`insert into brokk_v2.organizations(id,name,external_id) values (${randomUUID()},${input.organizationName},${input.organizationId}) on conflict(external_id) do update set name=excluded.name returning id`;
        const oid = String(organizations[0].id);
        await db`insert into brokk_v2.members values (${oid},${input.email},${input.role}) on conflict (organization_id,email) do update set role=case when brokk_v2.members.role='admin' then 'admin' else excluded.role end`;
        const projects =
          await db`insert into brokk_v2.projects(id,organization_id,name,objective,external_id) values (${randomUUID()},${oid},${input.projectName},${input.objective},${input.projectId}) on conflict(organization_id,external_id) do update set external_id=excluded.external_id returning *`;
        const p = projectOf(projects[0]);
        const token = randomBytes(32).toString("base64url");
        const identity = {
          id: `var:${input.email}`,
          email: input.email,
          name: input.name,
          admin: false,
        };
        await db`insert into brokk_v2.tickets values (${hash(token)},${db.json(identity)},${p.id},now()+interval '60 seconds')`;
        await event(
          db,
          p.id,
          identity,
          "var.opened",
          "Workspace aberto pelo Var",
        );
        return { project: p, ticket: token };
      });
    },
    async redeem(token: string) {
      const rows =
        await sql`delete from brokk_v2.tickets where digest=${hash(token)} and expires_at>now() returning identity,project_id`;
      if (!rows.length)
        throw new Problem(
          401,
          "Link expirado ou já utilizado. Abra novamente pelo Var.",
        );
      return {
        user: rows[0].identity as User,
        projectId: String(rows[0].project_id),
      };
    },
    close: () => sql.end(),
  };
}
export type Store = ReturnType<typeof createStore>;
