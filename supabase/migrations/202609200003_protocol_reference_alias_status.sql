alter table public.protocol_reference_aliases
  add column if not exists is_active boolean not null default true;

update public.protocol_reference_aliases
set is_active = true;

update public.protocol_reference_aliases
set is_active = false
where alias = 'ignis sacer';

update public.protocol_references
set is_active = true
where code = 'Fogo';

