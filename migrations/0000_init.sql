CREATE TABLE "ad_hoc_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"karbon_user_id" text NOT NULL,
	"client_key" text NOT NULL,
	"minutes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"recipient" text NOT NULL,
	"mode" text NOT NULL,
	"delivered_to" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"date" date PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"slot" text,
	"name" text,
	"email" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"changes" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"department" text NOT NULL,
	"manager_name" text,
	"manager_email" text,
	"csa_slot" text,
	"active" boolean NOT NULL,
	"utilization_target" double precision,
	"expected_weekly_hours" double precision,
	"excluded" boolean DEFAULT false NOT NULL,
	"hire_date" date,
	CONSTRAINT "roster_members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "task_types" (
	"key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"phase" text NOT NULL,
	"email" text NOT NULL,
	"karbon_user_id" text NOT NULL,
	"flags" jsonb NOT NULL,
	"minutes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ad_hoc_usage_week_user_client" ON "ad_hoc_usage" USING btree ("week_start","karbon_user_id","client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_once" ON "email_sends" USING btree ("kind","period","recipient","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_week_email" ON "escalations" USING btree ("week_start","email");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_results_week_phase_email" ON "weekly_results" USING btree ("week_start","phase","email");