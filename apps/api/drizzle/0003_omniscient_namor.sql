CREATE TABLE "game_match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game" text NOT NULL,
	"userId" text NOT NULL,
	"playerName" text NOT NULL,
	"outcome" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_match" ADD CONSTRAINT "game_match_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_match_game_user_idx" ON "game_match" USING btree ("game","userId");--> statement-breakpoint
CREATE INDEX "game_match_game_createdAt_idx" ON "game_match" USING btree ("game","createdAt");