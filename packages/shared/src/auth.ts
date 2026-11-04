import { z } from 'zod';

// Lowercased so "Asha@MAIT.ac.in" and "asha@mait.ac.in" are the same account (users.email is unique).
const email = z.string().trim().toLowerCase().pipe(z.email());

export const registerSchema = z.object({
  email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    // bcrypt silently ignores everything after 72 bytes, so longer passwords would give a false sense of security.
    .refine((p) => new TextEncoder().encode(p).length <= 72, 'Password must be at most 72 bytes'),
  name: z.string().trim().min(1).max(100),
  college: z.string().trim().min(1).max(200).optional(),
  branch: z.string().trim().min(1).max(100).optional(),
  graduationYear: z.number().int().min(2000).max(2100).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

// Login only checks that something was typed: the rules above apply when the password is created.
export const loginSchema = z.object({
  email,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** The user as the API returns it. Never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  college: string | null;
  branch: string | null;
  graduationYear: number | null;
  createdAt: string;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
}
