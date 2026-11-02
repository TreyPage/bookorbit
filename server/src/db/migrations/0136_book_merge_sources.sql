CREATE TABLE "book_merge_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_folder_id" integer NOT NULL,
	"folder_path" varchar(4096) NOT NULL,
	"target_book_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_files" DROP CONSTRAINT "book_files_book_folder_consistency_fk";
--> statement-breakpoint
ALTER TABLE "book_merge_sources" ADD CONSTRAINT "book_merge_sources_library_folder_id_library_folders_id_fk" FOREIGN KEY ("library_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_merge_sources" ADD CONSTRAINT "book_merge_sources_target_book_id_books_id_fk" FOREIGN KEY ("target_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_merge_sources_folder_path_uidx" ON "book_merge_sources" USING btree ("library_folder_id","folder_path");--> statement-breakpoint
CREATE INDEX "book_merge_sources_target_book_idx" ON "book_merge_sources" USING btree ("target_book_id");