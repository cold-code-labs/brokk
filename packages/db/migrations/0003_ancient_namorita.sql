CREATE TYPE "public"."repo_memory_kind" AS ENUM('convention', 'pitfall', 'review_failure', 'decision');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" "repo_memory_kind" DEFAULT 'pitfall' NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'eitri' NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"pr_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_memories_repo_kind_content_uniq" UNIQUE("repository_id","kind","content")
);
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "base_branch" SET DEFAULT 'dev';--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "repo_map" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "repo_map_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "scan_blocking" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "scan_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "acceptance" text;--> statement-breakpoint
ALTER TABLE "repo_memories" ADD CONSTRAINT "repo_memories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_memories_repo_idx" ON "repo_memories" USING btree ("repository_id");