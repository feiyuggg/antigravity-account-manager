import { describe, expect, it } from 'vitest';
import {
  formatCompactTrayTitle,
  formatTrayMenuAccountLabel,
  formatTraySlotBadge,
  getDisplayWidth,
  TRAY_LABEL_WIDTH,
} from '../electron/trayLabel';

describe('formatCompactTrayTitle', () => {
  it('formats long emails with fixed 6-column middle truncation while preserving suffix distinction', () => {
    const titles = [
      ['dev1003358879@example.com', ' dev…79'],
      ['lab09277501ais@example.com', ' lab…is'],
      ['teamalpha1212@example.com', ' tea…12'],
      ['teamalpha2121', ' tea…21'],
    ] as const;

    for (const [input, expected] of titles) {
      const formatted = formatCompactTrayTitle(input);
      expect(formatted).toBe(expected);
      expect(getDisplayWidth(formatted.slice(1))).toBe(TRAY_LABEL_WIDTH);
    }

    expect(formatCompactTrayTitle('teamalpha1212@example.com')).not.toBe(
      formatCompactTrayTitle('teamalpha2121'),
    );
  });

  it('pads short names, missing accounts, and CJK labels to exact fixed width', () => {
    const shortTitle = formatCompactTrayTitle('work');
    expect(shortTitle).toBe(' work  ');
    expect(getDisplayWidth(shortTitle.slice(1))).toBe(TRAY_LABEL_WIDTH);

    const emptyTitle = formatCompactTrayTitle(undefined);
    expect(emptyTitle).toBe(' AGY   ');
    expect(getDisplayWidth(emptyTitle.slice(1))).toBe(TRAY_LABEL_WIDTH);

    const exactCjk = formatCompactTrayTitle('主账号');
    expect(exactCjk).toBe(' 主账号');
    expect(getDisplayWidth(exactCjk.slice(1))).toBe(TRAY_LABEL_WIDTH);

    const longCjk = formatCompactTrayTitle('我的工作主账号');
    expect(longCjk).toContain('…');
    expect(getDisplayWidth(longCjk.slice(1))).toBe(TRAY_LABEL_WIDTH);
  });

  it('formats ultra-compact slot badges and deduplicated tray menu labels', () => {
    expect(formatTraySlotBadge(1)).toBe(' #1');
    expect(formatTraySlotBadge(2)).toBe(' #2');
    expect(formatTraySlotBadge(null)).toBe(' --');

    expect(
      formatTrayMenuAccountLabel('studio.member@example.com', 2, 'studio.member@example.com'),
    ).toBe('#2 · studio.member@example.com');

    const longLabel = formatTrayMenuAccountLabel(
      'very_long_account_identifier_example@enterprise.example.com',
      3,
    );
    expect(longLabel.startsWith('#3 · ')).toBe(true);
    expect(longLabel).toContain('…');
    expect(getDisplayWidth(longLabel.replace(/^#3 · /, ''))).toBeLessThanOrEqual(26);
  });
});
