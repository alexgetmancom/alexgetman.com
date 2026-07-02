import { compactText } from '../../utils/helpers';
import type { HomePost } from './types';

export function paragraphsFor(post: HomePost) {
  const raw = post.body || post.excerpt || post.title;
  const lines = raw
    .split(/\n+/)
    .map((line) => compactText(line))
    .filter(Boolean);
  const withoutTitle = lines[0]?.toLowerCase() === compactText(post.title).toLowerCase()
    ? lines.slice(1)
    : lines;
  return (withoutTitle.length ? withoutTitle : lines).slice(0, 7);
}

export function metricValue(value: number) {
  if (!value) return '0';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}
