CREATE TABLE "karbon_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"subject_key" text NOT NULL,
	"mode" text NOT NULL,
	"client_key" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"note_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "karbon_client_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "karbon_notes_once" ON "karbon_notes" USING btree ("kind","period","subject_key","mode");