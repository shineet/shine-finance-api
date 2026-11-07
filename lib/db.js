// Supabase over PostgREST with the service key.
//
// Every table is reached ONLY from here, with the service key, which bypasses
// RLS. So the line between one person's money and another's is drawn in this
// backend, not in the database: every read and write names a user_id, and
// `forUser` exists so that it is hard to write one that doesn't.

export const sbHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

export const rest = (path) => `${process.env.SUPABASE_URL}/rest/v1/${path}`;

/// `user_id=eq.<id>` for a query string. Throws rather than returning an empty
/// filter: a query that silently drops its user filter returns EVERYONE's rows.
export function forUser(user) {
  const id = typeof user === 'string' ? user : user?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('forUser: no user id');
  return `user_id=eq.${id}`;
}
