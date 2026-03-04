const ADMIN_EMAILS = ['djgnfj3795@gmail.com'];

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email);
}
