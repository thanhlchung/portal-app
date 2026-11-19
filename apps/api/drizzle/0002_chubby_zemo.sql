DROP INDEX "score_ranking_idx";--> statement-breakpoint
DROP INDEX "score_userId_createdAt_idx";--> statement-breakpoint
ALTER TABLE "score" ADD COLUMN "game" text DEFAULT 'asteroids' NOT NULL;--> statement-breakpoint
CREATE INDEX "score_game_ranking_idx" ON "score" USING btree ("game","score");--> statement-breakpoint
CREATE INDEX "score_game_user_idx" ON "score" USING btree ("game","userId","score");