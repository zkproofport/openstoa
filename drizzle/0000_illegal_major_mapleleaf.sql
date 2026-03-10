CREATE TABLE "community_bookmarks" (
	"user_id" text NOT NULL,
	"post_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_bookmarks_user_id_post_id_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "community_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "community_post_tags" (
	"post_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "community_post_tags_post_id_tag_id_pk" PRIMARY KEY("post_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"content_json" jsonb,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"score" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(50) NOT NULL,
	"slug" varchar(50) NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_tags_name_unique" UNIQUE("name"),
	CONSTRAINT "community_tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "community_topic_members" (
	"topic_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_topic_members_topic_id_user_id_pk" PRIMARY KEY("topic_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "community_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"creator_id" text NOT NULL,
	"requires_country_proof" boolean DEFAULT false,
	"allowed_countries" text[],
	"invite_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_topics_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "community_users" (
	"id" text PRIMARY KEY NOT NULL,
	"nickname" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_users_nickname_unique" UNIQUE("nickname")
);
--> statement-breakpoint
CREATE TABLE "community_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "community_bookmarks" ADD CONSTRAINT "community_bookmarks_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bookmarks" ADD CONSTRAINT "community_bookmarks_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_author_id_community_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post_tags" ADD CONSTRAINT "community_post_tags_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post_tags" ADD CONSTRAINT "community_post_tags_tag_id_community_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."community_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_topic_id_community_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."community_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_id_community_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_topic_members" ADD CONSTRAINT "community_topic_members_topic_id_community_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."community_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_topic_members" ADD CONSTRAINT "community_topic_members_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_topics" ADD CONSTRAINT "community_topics_creator_id_community_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_votes" ADD CONSTRAINT "community_votes_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_votes" ADD CONSTRAINT "community_votes_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_votes" ADD CONSTRAINT "community_votes_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."community_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_vote_user_post_idx" ON "community_votes" USING btree ("user_id","post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_vote_user_comment_idx" ON "community_votes" USING btree ("user_id","comment_id");