-- A reset preserves the anonymous session's history while requiring that its
-- browser discard local game state at the next access.
alter table public.protocol_sessions
  add column if not exists reset_at timestamptz,
  add column if not exists reset_acknowledged_at timestamptz,
  add column if not exists reset_by uuid references auth.users(id);

