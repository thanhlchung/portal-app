CREATE TABLE "score" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" text NOT NULL,
	"playerName" text NOT NULL,
	"score" integer NOT NULL,
	"level" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "score" ADD CONSTRAINT "score_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "score_ranking_idx" ON "score" USING btree ("score");--> statement-breakpoint
CREATE INDEX "score_userId_createdAt_idx" ON "score" USING btree ("userId","createdAt");