import { describe, expect, it } from 'vitest';
import { insetScale } from '../src/ui/insets';

// An iPhone of 430 × 932 points (its screen's size is always given upright).
describe('insetScale: the px of the page in a screen point, when the page is zoomed out', () => {
  it('the page as wide as the screen: 1', () => {
    expect(insetScale(430, 932, 430, 932)).toBe(1);
    expect(insetScale(430, 873, 430, 932)).toBe(1); // a home-screen app whose page stops short of the screen
    expect(insetScale(932, 430, 430, 932)).toBe(1); // lying down
  });
  it('zoomed out: a point is several px, upright and lying down', () => {
    expect(insetScale(860, 1746, 430, 932)).toBe(2); // Safari's « Page Zoom » at 50 %
    expect(insetScale(1864, 860, 430, 932)).toBe(2);
    expect(insetScale(573, 1164, 430, 932)).toBe(1.333); // 75 %
    expect(insetScale(506, 1027, 430, 932)).toBe(1.177); // 85 %
  });
  it('zoomed in, or a window narrower than the screen (an iPad sharing its screen): left alone', () => {
    expect(insetScale(287, 621, 430, 932)).toBe(1); // 150 %
    expect(insetScale(507, 1180, 820, 1180)).toBe(1);
    expect(insetScale(590, 820, 820, 1180)).toBe(1);
  });
  it('a screen that gives its size as it is held (Android), or no size at all', () => {
    expect(insetScale(780, 360, 780, 360)).toBe(1);
    expect(insetScale(1180, 820, 1180, 820)).toBe(1);
    expect(insetScale(860, 1746, 0, 0)).toBe(1);
    expect(insetScale(0, 0, 430, 932)).toBe(1);
  });
});
