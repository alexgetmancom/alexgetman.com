export interface HomePost {
  id: number | string;
  url: string;
  title: string;
  body?: string;
  excerpt: string;
  date: string;
  relativeDate: string;
  image: string | null;
  fallbackImage?: string | null;
  mediaType?: 'image' | 'video' | null;
  audioUrl?: string | null;
  spotifyUrl?: string | null;
  imageSrcSet?: string;
  views: number;
  categorySlug: string;
  category: string;
}

export interface TopicStat {
  slug: string;
  label: string;
  count: number;
}

export interface Project {
  name: string;
  kind: string;
  url: string;
}

export interface HomeLabels {
  archive: string;
  search: string;
  languageSwitch: string;
  empty: string;
  latestPosts: string;
  latestUpdates: string;
  trending: string;
  topics: string;
  projects: string;
  all: string;
  sidebarLabel: string;
  mskSuffix: string;
}

export interface StoryUi {
  storyLabel: string;
  postTab: string;
  discussionTab: string;
  sourcesTab: string;
  previous: string;
  next: string;
  discuss: string;
  share: string;
  readMore: string;
  collapse: string;
  openPost: string;
  mute: string;
  muted: string;
  storyRail: string;
  noDiscussion: string;
  sourcesHint: string;
  views: string;
  replies: string;
  reactions: string;
}
