DELETE FROM analytics_sync
 WHERE source = 'youtube'
   AND EXISTS (
     SELECT 1
       FROM analytics_sync
      WHERE source IN ('youtube_ru', 'youtube_en')
   );
--> statement-breakpoint
DELETE FROM analytics_sync
 WHERE source = 'instagram'
   AND EXISTS (
     SELECT 1
       FROM analytics_sync
      WHERE source IN ('instagram_ru', 'instagram_en')
   );
--> statement-breakpoint

DELETE FROM creator_profile_snapshots
 WHERE platform = 'youtube'
   AND EXISTS (
     SELECT 1
       FROM creator_profile_snapshots
      WHERE platform IN ('youtube_ru', 'youtube_en')
   );
--> statement-breakpoint
DELETE FROM creator_profile_snapshots
 WHERE platform = 'instagram'
   AND EXISTS (
     SELECT 1
       FROM creator_profile_snapshots
      WHERE platform IN ('instagram_ru', 'instagram_en')
   );
--> statement-breakpoint

DELETE FROM creator_profiles
 WHERE platform = 'youtube'
   AND EXISTS (
     SELECT 1
       FROM creator_profiles
      WHERE platform IN ('youtube_ru', 'youtube_en')
   );
--> statement-breakpoint
DELETE FROM creator_profiles
 WHERE platform = 'instagram'
   AND EXISTS (
     SELECT 1
       FROM creator_profiles
      WHERE platform IN ('instagram_ru', 'instagram_en')
   );
