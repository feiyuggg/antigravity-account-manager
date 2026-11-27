export const TRAY_LABEL_WIDTH = 6;

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
      (codePoint >= 0x3040 && codePoint <= 0x3247) ||
      (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
      (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

/**
 * Compute terminal/monospaced column display width for Unicode strings
 * (CJK/fullwidth = 2 columns, ASCII / ellipsis = 1 column).
 */
export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

function takeLeadingColumns(chars: string[], budget: number): string {
  let used = 0;
  let out = '';
  for (const ch of chars) {
    const w = getDisplayWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out;
}

function takeTrailingColumns(chars: string[], budget: number): string {
  let used = 0;
  const picked: string[] = [];
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const w = getDisplayWidth(ch);
    if (used + w > budget) break;
    picked.push(ch);
    used += w;
  }
  return picked.reverse().join('');
}

function padRightColumns(text: string, targetWidth: number): string {
  const remaining = Math.max(0, targetWidth - getDisplayWidth(text));
  return `${text}${' '.repeat(remaining)}`;
}

function middleTruncateToWidth(text: string, maxWidth: number): string {
  if (getDisplayWidth(text) <= maxWidth) {
    return text;
  }
  const chars = Array.from(text);
  const contentBudget = Math.max(1, maxWidth - 1);
  const rightBudget = Math.floor(contentBudget / 2);
  const leftBudget = contentBudget - rightBudget;

  const left = takeLeadingColumns(chars, leftBudget);
  const right = takeTrailingColumns(chars, rightBudget);
  return `${left}…${right}`;
}

/**
 * Format an account nickname/email into a compact fixed-width macOS menu bar label.
 * Strips `@domain`, middle-truncates long identifiers (`gav…12` vs `gav…21`),
 * and pads to exact `maxWidth` columns so the menu bar never shifts width.
 */
export function formatCompactTrayTitle(
  nickname?: string | null,
  maxWidth = TRAY_LABEL_WIDTH,
): string {
  const trimmed = (nickname ?? '').trim();
  if (!trimmed) {
    return ` ${padRightColumns('AGY', maxWidth)}`;
  }

  const atIdx = trimmed.indexOf('@');
  const base = atIdx > 0 ? trimmed.slice(0, atIdx) : trimmed;
  const truncated = middleTruncateToWidth(base, maxWidth);
  return ` ${padRightColumns(truncated, maxWidth)}`;
}

/**
 * Ultra-compact slot number badge for the macOS menu bar (` #1`, ` #2`, or ` --`).
 */
export function formatTraySlotBadge(slotIndex: number | null): string {
  if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex) || slotIndex < 1) {
    return ' --';
  }
  return ` #${slotIndex}`;
}

/**
 * Format a clean menu label (`#<n> · <nickname>`) without duplicating email addresses.
 */
export function formatTrayMenuAccountLabel(
  nickname: string,
  slotIndex: number,
  _emailHint?: string,
): string {
  const trimmed = nickname.trim() || '未命名账号';
  const compact = middleTruncateToWidth(trimmed, 26);
  return `#${slotIndex} · ${compact}`;
}
