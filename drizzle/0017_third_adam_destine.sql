CREATE TABLE "key_backup_passkeys" (
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"prf_wrapped" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "key_backup_passkeys_user_id_credential_id_pk" PRIMARY KEY("user_id","credential_id")
);
--> statement-breakpoint
CREATE TABLE "key_backups" (
	"user_id" text PRIMARY KEY NOT NULL,
	"wrapped_master" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tak_key_backups" (
	"user_id" text PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "key_backup_passkeys" ADD CONSTRAINT "key_backup_passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_backups" ADD CONSTRAINT "key_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tak_key_backups" ADD CONSTRAINT "tak_key_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;