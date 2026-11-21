CREATE TABLE "share" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ownerId" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"durationMinutes" integer,
	"expiresAt" timestamp with time zone NOT NULL,
	"endedAt" timestamp with time zone,
	"endReason" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shareId" uuid NOT NULL,
	"actorId" text,
	"kind" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shareId" uuid NOT NULL,
	"createdBy" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"acceptedBy" text,
	"acceptedAt" timestamp with time zone,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_invite_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "share_participant" (
	"shareId" uuid NOT NULL,
	"userId" text NOT NULL,
	"role" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"sharing" boolean DEFAULT false NOT NULL,
	"lastLat" double precision,
	"lastLng" double precision,
	"lastAccuracy" double precision,
	"lastAt" timestamp with time zone,
	"joinedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_participant_shareId_userId_pk" PRIMARY KEY("shareId","userId")
);
--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_event" ADD CONSTRAINT "share_event_shareId_share_id_fk" FOREIGN KEY ("shareId") REFERENCES "public"."share"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_event" ADD CONSTRAINT "share_event_actorId_user_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_invite" ADD CONSTRAINT "share_invite_shareId_share_id_fk" FOREIGN KEY ("shareId") REFERENCES "public"."share"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_invite" ADD CONSTRAINT "share_invite_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_invite" ADD CONSTRAINT "share_invite_acceptedBy_user_id_fk" FOREIGN KEY ("acceptedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_participant" ADD CONSTRAINT "share_participant_shareId_share_id_fk" FOREIGN KEY ("shareId") REFERENCES "public"."share"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_participant" ADD CONSTRAINT "share_participant_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_owner_created_idx" ON "share" USING btree ("ownerId","createdAt");--> statement-breakpoint
CREATE INDEX "share_status_expires_idx" ON "share" USING btree ("status","expiresAt");--> statement-breakpoint
CREATE INDEX "share_event_share_created_idx" ON "share_event" USING btree ("shareId","createdAt");--> statement-breakpoint
CREATE INDEX "share_invite_share_idx" ON "share_invite" USING btree ("shareId");--> statement-breakpoint
CREATE INDEX "share_participant_user_joined_idx" ON "share_participant" USING btree ("userId","joinedAt");