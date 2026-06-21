CREATE TYPE "public"."plan_mode" AS ENUM('atomic', 'feature');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('planning', 'forging', 'review', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text,
	"mode" "plan_mode" DEFAULT 'feature' NOT NULL,
	"status" "plan_status" DEFAULT 'planning' NOT NULL,
	"feature_branch" text NOT NULL,
	"base_branch" text DEFAULT 'dev' NOT NULL,
	"pr_url" text,
	"pr_number" integer,
	"model" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "plan_key" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "forca" "forca_level";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "touches" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;