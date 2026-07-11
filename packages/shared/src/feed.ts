import * as z from "zod";

export const mediaItemSchema = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
    src: z.string().optional(),
    path: z.string().optional(),
    alt: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .passthrough();
export type MediaItem = z.infer<typeof mediaItemSchema>;

export const feedItemSchema = z
  .object({
    post_id: z.union([z.number().int(), z.string()]).optional(),
    message_id: z.union([z.number().int(), z.string()]).optional(),
    date: z.string(),
    text: z.string().optional().default(""),
    text_ru: z.string().optional(),
    text_en: z.string().optional(),
    html: z.string().optional(),
    html_en: z.string().optional(),
    slug_ru: z.string().optional(),
    slug_en: z.string().optional(),
    has_ru: z.boolean().optional(),
    has_en: z.boolean().optional(),
    image: z.string().nullable().optional(),
    image_en: z.string().nullable().optional(),
    media: z.array(mediaItemSchema).optional().default([]),
    media_en: z.array(mediaItemSchema).optional(),
  })
  .passthrough();
export type FeedItem = z.infer<typeof feedItemSchema>;

export const feedSchema = z
  .object({
    items: z.array(feedItemSchema).default([]),
    updated_at: z.string().nullable().optional(),
    channel: z.string().optional(),
  })
  .passthrough();
export type Feed = z.infer<typeof feedSchema>;
