import type { UIStyle } from './types';

export const uiStyleOptions: ReadonlyArray<{ value: UIStyle; name: string; subtitle: string }> = [
  { value: 'paper', name: '纸笺', subtitle: '纸白底色，舒展行距' },
  { value: 'studio', name: '霜序', subtitle: '深色侧栏，分组列表' },
  { value: 'editorial', name: '暖刊', subtitle: '暖色纸面，宋体标题' },
  { value: 'mono', name: '极简', subtitle: '黑白界面，紧凑行距' },
];
