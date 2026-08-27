CREATE TABLE "device_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_proved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_signing_keys" ADD CONSTRAINT "device_signing_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_signing_user_device_idx" ON "device_signing_keys" USING btree ("user_id","device_id");