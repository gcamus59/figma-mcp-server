import { z } from 'zod';

/**
 * Regex that rejects characters commonly used for path-segment injection:
 * forward slash, backslash, newline, carriage return, null byte, and ".." sequences.
 */
const UNSAFE_ID_RE = /[/\\\n\r\0]|\.\./;

/**
 * Zod schema for a Figma identifier (file key, project ID, variable ID, etc.).
 * Allows alphanumeric characters, hyphens, underscores, colons, and dots while
 * blocking path traversal sequences and control characters.
 */
export const safeFigmaId = z
    .string()
    .min(1, { message: 'ID must not be empty' })
    .refine((s) => !UNSAFE_ID_RE.test(s), {
        message: 'ID contains invalid characters (no path separators or traversal sequences allowed)',
    });
