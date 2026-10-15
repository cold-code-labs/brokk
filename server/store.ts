import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  canonicalJson,
  cssValue,
  type DesignManifest,
  designGraph,
  designSchema,
} from "../shared/design.ts";
import type {
  Artifact,
  Event,
  Kind,
  Note,
  Organization,
  Project,
  RecordData,
  Role,
  User,
} from "../shared/domain.ts";
import { canEdit, emptyData } from "../shared/domain.ts";
import type {
  EnvironmentRecord,
  EnvironmentResources,
} from "../shared/environment.ts";
import type { CallAnalysis, CodeReference } from "../shared/review.ts";
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
const environmentOf = (r: Row): EnvironmentRecord => ({
  projectId: String(r.project_id),
  slug: String(r.slug),
  repository: String(r.repository),
  branch: "preview",
  profile: r.profile as EnvironmentRecord["profile"],
  previewUrl: String(r.preview_url),
  productionUrl: String(r.production_url),
  state: r.state as EnvironmentRecord["state"],
  step: String(r.step),
  detail: String(r.detail),
  dataReady: Boolean(r.data_ready),
  ciState: String(r.ci_state),
  commit: String(r.commit),
  deployedCommit: String(r.deployed_commit),
  resources: r.resources as EnvironmentResources,
  lease: String(r.lease),
  version: Number(r.version),
  updatedAt: iso(r.updated_at),
});
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
    if (
      !rows.length ||
      (user.suiteOrganization &&
        String(rows[0].organization_id) !== user.suiteOrganization)
    )
      throw new Problem(404, "Projeto não encontrado.");
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
  async function designRecords(db: Db, projectId: string) {
    const rows =
      await db`select * from brokk_v2.artifacts where project_id=${projectId} order by id`;
    return rows.map(artifactOf);
  }
  function validateDesign(records: Artifact[]) {
    const problem = designGraph(records).issues.find(
      (x) => x.severity === "error",
    );
    if (problem) throw new Problem(400, `${problem.key}: ${problem.message}`);
  }
  function normalizeDesign(data: RecordData) {
    if (data.design?.kind === "token")
      return {
        ...data,
        value: cssValue(data.design.type, data.design.value),
        category: data.design.type,
      };
    return data;
  }
  async function checkDesign(
    db: Db,
    projectId: string,
    kind: Kind,
    title: string,
    data: RecordData,
    user: User,
    item?: string,
  ) {
    if (data.design && data.design.kind !== kind)
      throw new Problem(
        400,
        "O tipo da especificação deve corresponder ao item.",
      );
    if (!["token", "component", "screen"].includes(kind)) return;
    await db`select id from brokk_v2.projects where id=${projectId} for update`;
    const records = await designRecords(db, projectId);
    const old = records.find((x) => x.id === item);
    if (old?.data.design && !data.design)
      throw new Problem(
        400,
        "Preserve a especificação estruturada deste item.",
      );
    validateDesign([
      ...records.filter((x) => x.id !== item),
      {
        id: item || randomUUID(),
        projectId,
        kind,
        title,
        status: "draft",
        version: 1,
        author: user.email,
        updatedAt: new Date().toISOString(),
        data,
      },
    ]);
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
        await db.unsafe(
          await readFile(
            new URL("../db/migrations/0002_environments.sql", import.meta.url),
            "utf8",
          ),
        );
        await db.unsafe(
          await readFile(
            new URL("../db/migrations/0003_coder_jobs.sql", import.meta.url),
            "utf8",
          ),
        );
        await db.unsafe(
          await readFile(
            new URL("../db/migrations/0004_coder_workers.sql", import.meta.url),
            "utf8",
          ),
        );
        await db.unsafe(
          await readFile(
            new URL(
              "../db/migrations/0005_review_extension.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      });
    },
    async extensionGrant(id: string, item: string, user: User) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select id from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='call' and status<>'closed' for update`;
        if (!rows.length) throw new Problem(404, "Review indisponível.");
        const active =
          await db`select digest from brokk_v2.extension_grants where call_id=${item} and capture_until>now() and not revoked`;
        if (active.length)
          throw new Problem(
            409,
            "Pare e sincronize a captura antes de gerar outra conexão.",
          );
        await db`update brokk_v2.extension_grants set revoked=true,capture_until=null where call_id=${item} and identity->>'email'=${user.email}`;
        const token = randomBytes(32).toString("base64url");
        await db`insert into brokk_v2.extension_grants(digest,project_id,call_id,identity,expires_at) values(${hash(token)},${id},${item},${db.json(user)},now()+interval '4 hours')`;
        await event(
          db,
          id,
          user,
          "call.extension.paired",
          "Extensão autorizada por quatro horas para esta review.",
        );
        return {
          token,
          projectId: id,
          callId: item,
          expiresAt: new Date(Date.now() + 14400000).toISOString(),
        };
      });
    },
    async extensionAccess(token: string) {
      const rows =
        await sql`select * from brokk_v2.extension_grants where digest=${hash(token)} and not revoked and expires_at>now()`;
      if (!rows.length)
        throw new Problem(401, "Conecte novamente a extensão nesta review.");
      const grant = rows[0],
        user = grant.identity as User;
      return {
        projectId: String(grant.project_id),
        callId: String(grant.call_id),
        user,
      };
    },
    async extensionCapture(token: string, start: boolean) {
      return sql.begin(async (db) => {
        const rows =
          await db`select * from brokk_v2.extension_grants where digest=${hash(token)} and not revoked and expires_at>now() for update`;
        if (!rows.length)
          throw new Problem(401, "Conecte novamente a extensão.");
        const g = rows[0],
          user = g.identity as User;
        await access(db, String(g.project_id), user, true);
        const calls =
          await db`select id from brokk_v2.artifacts where id=${g.call_id} and status<>'closed' for update`;
        if (!calls.length) throw new Problem(409, "Review encerrada.");
        if (start) {
          const active =
            await db`select digest from brokk_v2.extension_grants where call_id=${g.call_id} and capture_until>now()`;
          if (active.length || Number(g.captures) >= 8)
            throw new Problem(
              409,
              "Encerre a captura ativa ou gere uma nova conexão após o limite de oito capturas.",
            );
        }
        await db`update brokk_v2.extension_grants set capture_until=${start ? new Date(Date.now() + 7200000) : null},captures=captures+${start ? 1 : 0} where digest=${hash(token)}`;
      });
    },
    async revokeExtension(id: string, item: string, user: User) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        await db`update brokk_v2.extension_grants set revoked=true,capture_until=null where project_id=${id} and call_id=${item}`;
        await event(
          db,
          id,
          user,
          "call.extension.revoked",
          "Conexões da extensão revogadas.",
        );
      });
    },
    async extensionNotes(token: string, notes: Note[]) {
      return sql.begin(async (db) => {
        const grants =
          await db`select * from brokk_v2.extension_grants where digest=${hash(token)} and not revoked and expires_at>now() for update`;
        if (!grants.length)
          throw new Problem(401, "Conecte novamente a extensão.");
        const g = grants[0],
          user = g.identity as User;
        await access(db, String(g.project_id), user, true);
        const rows =
          await db`select * from brokk_v2.artifacts where id=${g.call_id} and project_id=${g.project_id} and kind='call' for update`;
        if (!rows.length || rows[0].status === "closed")
          throw new Problem(
            409,
            "Review encerrada. As observações permanecem na extensão.",
          );
        const row = artifactOf(rows[0]);
        const fresh = [
          ...new Map(notes.map((n) => [n.clientId, n])).values(),
        ].filter(
          (n) => !row.data.notes.some((old) => old.clientId === n.clientId),
        );
        if (row.data.notes.length + fresh.length > 2000)
          throw new Problem(
            409,
            "Limite de transcrição atingido. Encerre esta review.",
          );
        if (!fresh.length) return row;
        row.status = "active";
        row.data.notes.push(
          ...fresh.map((n) => ({ ...n, id: randomUUID(), author: user.email })),
        );
        const updated =
          await db`update brokk_v2.artifacts set status='active',data=${db.json(row.data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${g.call_id} returning *`;
        await snapshot(db, artifactOf(updated[0]), user);
        await event(
          db,
          String(g.project_id),
          user,
          "call.extension.notes",
          `${fresh.length} observações recebidas`,
        );
        return artifactOf(updated[0]);
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
    async suiteOrganization(
      id: string,
      name: string,
      email: string,
      role: Role,
    ) {
      return sql.begin(async (db) => {
        const rows =
          await db`insert into brokk_v2.organizations(id,name,external_id) values (${randomUUID()},${name},${`a4:${id}`}) on conflict(external_id) do update set name=excluded.name returning id`;
        const oid = String(rows[0].id);
        await db`insert into brokk_v2.members values (${oid},${email},${role}) on conflict(organization_id,email) do update set role=excluded.role`;
        return oid;
      });
    },
    async organizations(user: User) {
      const rows =
        await sql`select o.*,m.role from brokk_v2.organizations o left join brokk_v2.members m on m.organization_id=o.id and m.email=${user.email} where (${user.admin} or m.email is not null) and (${user.suiteOrganization ?? ""} = '' or o.id::text=${user.suiteOrganization ?? ""}) order by o.name`;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        externalId: r.external_id,
        role: user.admin ? "admin" : r.role,
      })) as Organization[];
    },
    async createOrganization(name: string, user: User) {
      if (!user.admin || user.suiteOrganization)
        throw new Problem(403, "Gerencie as empresas na A4.");
      return sql.begin(async (db) => {
        const id = randomUUID();
        await db`insert into brokk_v2.organizations (id,name) values (${id},${name})`;
        await db`insert into brokk_v2.members values (${id},${user.email},'admin')`;
        return { id, name, role: "admin", externalId: null } as Organization;
      });
    },
    async member(orgId: string, email: string, role: Role, user: User) {
      if (user.suiteOrganization && user.suiteOrganization !== orgId)
        throw new Problem(404, "Organização indisponível.");
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
        await sql`select p.* from brokk_v2.projects p left join brokk_v2.members m on m.organization_id=p.organization_id and m.email=${user.email} where (${user.admin} or m.email is not null) and (${user.suiteOrganization ?? ""} = '' or p.organization_id::text=${user.suiteOrganization ?? ""}) order by p.updated_at desc`;
      return rows.map(projectOf);
    },
    async createProject(
      orgId: string,
      name: string,
      objective: string,
      user: User,
    ) {
      if (user.suiteOrganization && user.suiteOrganization !== orgId)
        throw new Problem(404, "Organização indisponível.");
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
        const bound =
          await db`select repository from brokk_v2.environments where project_id=${id}`;
        if (bound.length && bound[0].repository !== repository)
          throw new Problem(
            409,
            "O ambiente já está vinculado a este repositório.",
          );
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
    async environment(id: string, user: User) {
      return sql.begin(async (db) => {
        await access(db, id, user);
        const rows =
          await db`select * from brokk_v2.environments where project_id=${id}`;
        return rows.length ? environmentOf(rows[0]) : null;
      });
    },
    async configureEnvironment(
      id: string,
      input: {
        slug: string;
        repository: string;
        previewUrl: string;
        productionUrl: string;
        profile: "static" | "application";
      },
      user: User,
      limit: number,
      automatic = false,
    ) {
      return sql.begin(async (db) => {
        const a = await access(db, id, user, true);
        if (!automatic && a.organization.role !== "admin")
          throw new Problem(403, "A administração configura a receita.");
        await db`select pg_advisory_xact_lock(42902383)`;
        const old =
          await db`select * from brokk_v2.environments where project_id=${id}`;
        if (old.length) {
          const r = environmentOf(old[0]);
          if (
            r.slug !== input.slug ||
            r.repository !== input.repository ||
            r.previewUrl !== input.previewUrl ||
            r.productionUrl !== input.productionUrl ||
            r.profile !== input.profile
          )
            throw new Problem(
              409,
              "A receita já está vinculada. A administração deve revisar a migração.",
            );
          return r;
        }
        const counts =
          await db`select count(*)::int as n from brokk_v2.environments`;
        if (counts[0].n >= limit)
          throw new Problem(429, "Limite de ambientes atingido.");
        const collisions =
          await db`select project_id from brokk_v2.environments where slug=${input.slug} or repository=${input.repository} or preview_url=${input.previewUrl}`;
        if (collisions.length)
          throw new Problem(409, "Este ambiente pertence a outro projeto.");
        if (a.project.repository && a.project.repository !== input.repository)
          throw new Problem(409, "Use o repositório já autorizado.");
        if (automatic && a.project.repository)
          throw new Problem(
            409,
            "A administração precisa vincular o ambiente ao repositório existente.",
          );
        const rows =
          await db`insert into brokk_v2.environments(project_id,slug,repository,preview_url,production_url,profile,resources) values (${id},${input.slug},${input.repository},${input.previewUrl},${input.productionUrl},${input.profile},${db.json({ application: "", dataProject: "", deployment: "", createRepository: !a.project.repository })}) returning *`;
        await db`update brokk_v2.projects set repository=${input.repository},version=version+1,updated_at=now() where id=${id}`;
        await event(db, id, user, "environment.configured", input.previewUrl);
        return environmentOf(rows[0]);
      });
    },
    async reserveEnvironment(
      id: string,
      user: User,
      purpose: "prepare" | "publish" = "prepare",
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select * from brokk_v2.environments where project_id=${id} for update`;
        if (!rows.length)
          throw new Problem(409, "Prepare a receita do ambiente.");
        const r = environmentOf(rows[0]);
        if (
          purpose === "prepare" &&
          (r.state === "ready" ||
            (r.state === "waiting" && r.step === "prepared" && r.dataReady))
        )
          return { created: false, environment: r };
        if (
          r.state === "preparing" &&
          rows[0].lease_until &&
          new Date(rows[0].lease_until).getTime() > Date.now()
        )
          return { created: false, environment: r };
        const lease = randomUUID();
        const updated =
          await db`update brokk_v2.environments set state='preparing',lease=${lease},lease_until=now()+interval '10 minutes',version=version+1,updated_at=now() where project_id=${id} returning *`;
        await event(db, id, user, "environment.preparing", r.previewUrl);
        return { created: true, environment: environmentOf(updated[0]) };
      });
    },
    async environmentUpdate(
      id: string,
      lease: string,
      patch: Partial<EnvironmentRecord>,
      user: User,
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select * from brokk_v2.environments where project_id=${id} and lease=${lease} for update`;
        if (!rows.length)
          throw new Problem(409, "A preparação mudou. Atualize o projeto.");
        const r = { ...environmentOf(rows[0]), ...patch };
        const updated =
          await db`update brokk_v2.environments set state=${r.state},step=${r.step},detail=${r.detail},data_ready=${r.dataReady},ci_state=${r.ciState},commit=${r.commit},deployed_commit=${r.deployedCommit},resources=${db.json(r.resources)},version=version+1,updated_at=now(),lease_until=now()+interval '10 minutes' where project_id=${id} and lease=${lease} returning *`;
        if (patch.state && patch.state !== rows[0].state)
          await event(db, id, user, `environment.${patch.state}`, r.previewUrl);
        return environmentOf(updated[0]);
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
        data = normalizeDesign(data);
        await checkDesign(db, id, kind, title, data, user);
        if (kind === "review") {
          const target =
            await db`select version from brokk_v2.artifacts where id=${data.targetId} and project_id=${id} and kind in ('scope','task','screen','component','token')`;
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
        await db`select id from brokk_v2.projects where id=${id} for update`;
        const prev =
          await db`select * from brokk_v2.artifacts where project_id=${id} and id=${item} and version=${version} for update`;
        if (!prev.length)
          throw new Problem(409, "O item mudou. Atualize antes de salvar.");
        if (["review", "run", "call"].includes(prev[0].kind))
          throw new Problem(403, "Use a ação específica deste item.");
        data = normalizeDesign(data);
        await checkDesign(
          db,
          id,
          prev[0].kind as Kind,
          title,
          data,
          user,
          item,
        );
        if (data.screenId) {
          const linked =
            await db`select id from brokk_v2.artifacts where project_id=${id} and id=${data.screenId} and kind='screen'`;
          if (!linked.length)
            throw new Problem(400, "Tela não encontrada neste projeto.");
        }
        const priorRecords = await designRecords(db, id);
        const oldSpec = artifactOf(prev[0]).data.design;
        const graph = designGraph(priorRecords);
        const affected = new Set<string>();
        const pending = oldSpec ? [oldSpec.key] : [];
        while (pending.length) {
          const key = pending.pop() as string;
          for (const usage of graph.usages[key] || [])
            if (!affected.has(usage.key)) {
              affected.add(usage.key);
              pending.push(usage.key);
            }
        }
        const nextStatus = prev[0].status === "approved" ? "draft" : status;
        const rows =
          await db`update brokk_v2.artifacts set title=${title},status=${nextStatus},data=${db.json(data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        const row = artifactOf(rows[0]);
        await snapshot(db, row, user);
        const invalidatedIds = [item];
        for (const dependent of priorRecords.filter(
          (x) => x.data.design && affected.has(x.data.design.key),
        )) {
          const changed =
            await db`update brokk_v2.artifacts set status=case when status='approved' then 'draft' else status end,version=version+1,updated_at=now() where id=${dependent.id} returning *`;
          await snapshot(db, artifactOf(changed[0]), user);
          await event(
            db,
            id,
            user,
            "design.dependency.changed",
            `${dependent.data.design?.key}: depende de ${oldSpec?.key}`,
          );
          invalidatedIds.push(dependent.id);
        }
        const changedReviews =
          await db`update brokk_v2.artifacts set status='changes',version=version+1,updated_at=now() where project_id=${id} and kind='review' and data->>'targetId'=any(${invalidatedIds}) and status in ('approved','review') returning *`;
        for (const review of changedReviews)
          await snapshot(db, artifactOf(review), user);
        await event(db, id, user, `${row.kind}.updated`, title);
        return row;
      });
    },
    async importDesign(id: string, manifest: DesignManifest, user: User) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        await db`select id from brokk_v2.projects where id=${id} for update`;
        const records = await designRecords(db, id);
        const existing = new Map(
          records
            .filter((x) => x.data.design)
            .map((x) => [x.data.design?.key, x]),
        );
        const matches = manifest.items.filter((x) =>
          existing.has(x.design.key),
        );
        if (matches.length) {
          const identical =
            matches.length === manifest.items.length &&
            manifest.items.every((x) => {
              const old = existing.get(x.design.key);
              return (
                old?.title === x.title &&
                old.data.body === x.body &&
                old.data.acceptance === x.acceptance &&
                canonicalJson(designSchema.parse(old.data.design)) ===
                  canonicalJson(x.design)
              );
            });
          if (!identical)
            throw new Problem(
              409,
              "A importação conflita com chaves existentes. Edite os itens ou importe em um projeto vazio.",
            );
          return { imported: 0, existing: matches.length };
        }
        const pending = manifest.items.map(
          (x) =>
            ({
              id: randomUUID(),
              projectId: id,
              kind: x.design.kind,
              title: x.title,
              status: "draft",
              version: 1,
              author: user.email,
              updatedAt: new Date().toISOString(),
              data: normalizeDesign({
                ...emptyData(),
                body: x.body,
                acceptance: x.acceptance,
                design: x.design,
              }),
            }) satisfies Artifact,
        );
        validateDesign([...records, ...pending]);
        for (const x of pending)
          await insert(db, id, x.kind, x.title, "draft", x.data, user);
        await event(
          db,
          id,
          user,
          "design.imported",
          `${manifest.name}: ${pending.length} especificações estruturadas`,
        );
        return { imported: pending.length, existing: 0 };
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
        await db`select id from brokk_v2.projects where id=${id} for update`;
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
    async closeCall(
      id: string,
      item: string,
      version: number,
      user: User,
      analysis?: CallAnalysis,
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select * from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='call' and version=${version} for update`;
        if (!rows.length)
          throw new Problem(409, "A call mudou. Atualize antes de encerrar.");
        const row = artifactOf(rows[0]);
        if (row.status === "closed")
          throw new Problem(409, "A call já foi encerrada.");
        const active =
          await db`select digest from brokk_v2.extension_grants where call_id=${item} and capture_until>now() and not revoked`;
        if (active.length)
          throw new Problem(
            409,
            "Pare a captura e sincronize a extensão antes de encerrar. Se o navegador foi fechado, revogue a conexão.",
          );
        row.data.summary =
          analysis?.summary ||
          row.data.notes
            .map(
              (n) =>
                `${{ liked: "Gostou", change: "Ajuste", question: "Dúvida", decision: "Decisão" }[n.category]}: ${n.body}`,
            )
            .join("\n");
        const insights =
          analysis?.proposals ||
          row.data.notes
            .filter((n) => n.category === "change" && n.source !== "transcript")
            .map((n) => ({
              title: n.body.slice(0, 160),
              body: n.body,
              acceptance: "Confirmar o ajuste na próxima review com o cliente.",
              noteIds: [n.id],
            }));
        row.data.reviewProposals = insights.map((p) => ({
          ...p,
          id: randomUUID(),
          status: "pending",
          taskId: "",
          reviewedBy: "",
          codeReference: row.data.notes.find(
            (n) => p.noteIds.includes(n.id) && n.codeReference,
          )?.codeReference,
        }));
        await db`update brokk_v2.extension_grants set revoked=true where call_id=${item}`;
        const result =
          await db`update brokk_v2.artifacts set status='closed',data=${db.json(row.data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        await snapshot(db, artifactOf(result[0]), user);
        await event(
          db,
          id,
          user,
          "call.closed",
          `${row.title}: ${insights.length} propostas aguardando confirmação`,
        );
        return { call: artifactOf(result[0]), tasks: [] };
      });
    },
    async decideProposal(
      id: string,
      item: string,
      proposalId: string,
      version: number,
      user: User,
      input: {
        decision: "accepted" | "rejected";
        title: string;
        body: string;
        acceptance: string;
        codeReference?: CodeReference;
      },
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select * from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='call' and status='closed' and version=${version} for update`;
        if (!rows.length)
          throw new Problem(
            409,
            "A review mudou. Atualize antes de confirmar.",
          );
        const row = artifactOf(rows[0]),
          p = row.data.reviewProposals.find((p) => p.id === proposalId);
        if (!p || p.status !== "pending")
          throw new Problem(409, "Proposta já decidida ou indisponível.");
        Object.assign(p, {
          ...input,
          status: input.decision,
          reviewedBy: user.email,
        });
        if (input.decision === "accepted") {
          const source = row.data.notes.find((n) => p.noteIds.includes(n.id));
          const reference = input.codeReference?.path
            ? `\n\nReferência indicada pela equipe: ${input.codeReference.path}:${input.codeReference.line}`
            : "";
          const task = await insert(
            db,
            id,
            "task",
            input.title,
            "backlog",
            {
              ...emptyData(),
              body: input.body + reference,
              acceptance: input.acceptance,
              screenId: source?.screenId || "",
              category: `call:${item}:proposal:${p.id}`,
            },
            user,
          );
          p.taskId = task.id;
        }
        const updated =
          await db`update brokk_v2.artifacts set data=${db.json(row.data as unknown as postgres.JSONValue)},version=version+1,updated_at=now() where id=${item} returning *`;
        await snapshot(db, artifactOf(updated[0]), user);
        await event(db, id, user, `call.proposal.${input.decision}`, p.title);
        return artifactOf(updated[0]);
      });
    },
    async reserveRun(
      id: string,
      taskId: string,
      key: string,
      user: User,
      dailyLimit: number,
      context = "",
      expected?: { project: Project; records: Artifact[] },
      provider: "devin" | "cursor" = "devin",
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        await db`select pg_advisory_xact_lock(42902382)`;
        const old =
          await db`select * from brokk_v2.artifacts where project_id=${id} and kind='run' and data->>'requestKey'=${key}`;
        if (old.length) return { created: false, run: artifactOf(old[0]) };
        if (expected) {
          const projects =
            await db`select version,repository from brokk_v2.projects where id=${id} for update`;
          const current =
            await db`select id,version,status from brokk_v2.artifacts where project_id=${id} and (kind in ('scope','screen','component','token') or id=${taskId})`;
          const specs = expected.records.filter(
            (r) =>
              ["scope", "screen", "component", "token"].includes(r.kind) ||
              r.id === taskId,
          );
          const valid =
            projects[0].version === expected.project.version &&
            projects[0].repository === expected.project.repository &&
            current.length === specs.length &&
            specs.every((r) =>
              current.some(
                (c) =>
                  c.id === r.id &&
                  c.version === r.version &&
                  c.status === r.status,
              ),
            );
          if (
            !valid ||
            !current.some(
              (r) =>
                r.status === "approved" &&
                expected.records.some(
                  (e) => e.id === r.id && e.kind === "scope",
                ),
            )
          )
            throw new Problem(
              409,
              "O contexto ou a aprovação mudou. Prepare a entrega novamente.",
            );
        }
        const task =
          await db`select * from brokk_v2.artifacts where id=${taskId} and project_id=${id} and kind='task'`;
        if (!task.length) throw new Problem(404, "Tarefa não encontrada.");
        const active =
          await db`select id from brokk_v2.artifacts where project_id=${id} and kind='run' and data->>'targetId'=${taskId} and status in ('launching','active','uncertain','review')`;
        if (active.length)
          throw new Problem(
            409,
            "Esta tarefa já tem uma execução em andamento.",
          );
        const counts =
          await db`select count(*)::int as n from brokk_v2.artifacts where kind='run' and updated_at>now()-interval '24 hours'`;
        if (counts[0].n >= dailyLimit)
          throw new Problem(429, "Limite diário de desenvolvimento atingido.");
        const run = await insert(
          db,
          id,
          "run",
          String(task[0].title),
          "launching",
          {
            ...emptyData(),
            targetId: taskId,
            requestKey: key,
            category: provider,
            attempts: [
              {
                provider,
                status: provider === "cursor" ? "queued" : "launching",
                at: new Date().toISOString(),
              },
            ],
            body: context,
            targetVersion: Number(task[0].version),
          },
          user,
        );
        if (provider === "cursor") {
          await db`insert into brokk_v2.coder_jobs(run_id,project_id) values (${run.id},${id})`;
          await db`update brokk_v2.artifacts set data=data || ${db.json({ sessionId: "cursor-" + run.id, providerStatus: "queued" })} where id=${run.id}`;
          run.data.sessionId = "cursor-" + run.id;
          run.data.providerStatus = "queued";
        }
        return { created: true, run };
      });
    },
    async cursorFallback(
      id: string,
      item: string,
      user: User,
      upstreamStatus: number,
    ) {
      return sql.begin(async (db) => {
        await access(db, id, user, true);
        const rows =
          await db`select * from brokk_v2.artifacts where id=${item} and project_id=${id} and kind='run' for update`;
        if (
          !rows.length ||
          rows[0].status !== "launching" ||
          rows[0].data.sessionId
        )
          throw new Problem(
            409,
            "A criação já foi confirmada ou precisa de reconciliação.",
          );
        const notes = rows[0].data.notes || [];
        notes.push({
          id: randomUUID(),
          author: "Brokk",
          body: `Devin recusou a criação (HTTP ${upstreamStatus}). O mesmo contrato foi encaminhado ao worker Cursor na infraestrutura de desenvolvimento.`,
          at: new Date().toISOString(),
          category: "decision",
          screenId: "",
        });
        const patch = {
          category: "cursor",
          executionPolicy: "auto",
          sessionId: "cursor-" + item,
          providerStatus: "queued",
          attempts: [
            {
              provider: "devin",
              status: `rejected_http_${upstreamStatus}`,
              at: new Date().toISOString(),
            },
            {
              provider: "cursor",
              status: "queued",
              at: new Date().toISOString(),
            },
          ],
          notes,
        };
        await db`insert into brokk_v2.coder_jobs(run_id,project_id) values (${item},${id})`;
        const updated =
          await db`update brokk_v2.artifacts set data=data || ${db.json(patch)},version=version+1,updated_at=now() where id=${item} returning *`;
        await event(
          db,
          id,
          user,
          "run.fallback",
          "Devin → Cursor; recusa definitiva; contrato preservado.",
        );
        return artifactOf(updated[0]);
      });
    },
    async recoverCursorDelivery(
      id: string,
      item: string,
      user: User,
      expected: { project: Project; records: Artifact[] },
      resultUrl: string,
    ) {
      return sql.begin(async (db) => {
        const accessResult = await access(db, id, user, true);
        if (accessResult.organization.role !== "admin")
          throw new Problem(403, "A administração recupera a entrega.");
        const jobs =
          await db`select state from brokk_v2.coder_jobs where run_id=${item} for update`;
        if (jobs[0]?.state !== "failed")
          throw new Problem(
            409,
            "O worker ainda não confirmou o encerramento desta tentativa.",
          );
        const project =
          await db`select version from brokk_v2.projects where id=${id} for update`;
        const targetId =
          expected.records.find((r) => r.id === item)?.data.targetId || "";
        const specs = expected.records.filter(
          (r) =>
            ["scope", "screen", "component", "token"].includes(r.kind) ||
            r.id === targetId ||
            r.id === item,
        );
        const current =
          await db`select id,version,status from brokk_v2.artifacts where project_id=${id} and (kind in ('scope','screen','component','token') or id::text=${targetId} or id=${item}) for update`;
        if (
          project[0].version !== expected.project.version ||
          current.length !== specs.length ||
          !specs.every((r) =>
            current.some(
              (a) =>
                a.id === r.id &&
                a.version === r.version &&
                a.status === r.status,
            ),
          )
        )
          throw new Problem(409, "O contexto mudou durante a recuperação.");
        const updated =
          await db`update brokk_v2.artifacts set status='review',data=data || ${db.json({ resultUrl, providerStatus: "recovered_delivery", summary: "Entrega Git recuperada pela administração após revisão e CI. A execução do modelo não foi repetida." })},version=version+1,updated_at=now() where id=${item} and project_id=${id} and kind='run' and status='failed' and data->>'category'='cursor' returning *`;
        if (!updated.length)
          throw new Problem(409, "Esta entrega já foi recuperada ou mudou.");
        await event(
          db,
          id,
          user,
          "run.delivery_recovered",
          "PR verificada; contrato preservado; sem repetir o modelo.",
        );
        return artifactOf(updated[0]);
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
