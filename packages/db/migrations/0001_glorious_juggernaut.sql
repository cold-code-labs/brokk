CREATE TYPE "public"."preview_status" AS ENUM('starting', 'live', 'stopped', 'failed');--> statement-breakpoint
CREATE TABLE "previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"branch" text DEFAULT 'dev' NOT NULL,
	"subdomain" text NOT NULL,
	"url" text NOT NULL,
	"port" integer,
	"hauldr_project" text NOT NULL,
	"status" "preview_status" DEFAULT 'starting' NOT NULL,
	"pid" integer,
	"last_seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "previews_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "previews_project_branch_active_uniq" ON "previews" USING btree ("project_id","branch") WHERE "previews"."status" in ('starting', 'live');