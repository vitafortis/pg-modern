-- Demo data for README screenshots. Everything here is made up.
create database gitea;
create database immich;

create schema inventory;
create type media_kind as enum ('movie', 'show', 'album', 'book');

create table public.libraries (
  id serial primary key,
  name text not null unique,
  path text not null,
  created_at timestamptz default now()
);

create table public.media (
  id bigserial primary key,
  library_id int not null references public.libraries(id),
  title text not null,
  kind media_kind not null,
  year int check (year > 1800),
  rating numeric(3,1),
  tags text[] default '{}',
  metadata jsonb,
  added_at timestamptz not null default now(),
  file_size bigint,
  watched boolean default false
);
comment on table public.media is 'Everything in the library';
comment on column public.media.rating is 'Out of 10';
create index media_title_idx on public.media (lower(title));
create index media_meta_gin on public.media using gin (metadata);

insert into public.libraries (name, path) values
  ('Movies', '/mnt/tank/movies'), ('Shows', '/mnt/tank/tv'), ('Music', '/mnt/tank/music'), ('Books', '/mnt/tank/books');

-- Skewed like a real library: lots of movies, a few books; movies are big, books tiny.
insert into public.media (library_id, title, kind, year, rating, tags, metadata, added_at, file_size, watched)
select lib,
  (array['The', 'A', 'Return of the', 'Last', 'Night', 'Silent', 'Electric', 'Northern'])[1 + g % 8] || ' ' ||
  (array['Signal', 'Harbor', 'Garden', 'Machine', 'River', 'Archive', 'Comet', 'Lantern'])[1 + (g * 7) % 8],
  (array['movie', 'show', 'album', 'book'])[lib]::media_kind,
  1950 + (g * 13) % 75,
  round((((g * 37) % 70) / 10.0 + 2.5 + lib * 0.3)::numeric, 1),
  array[(array['4k', 'hdr', 'remux', 'flac', 'epub', 'anime', 'classic'])[1 + g % 7]],
  jsonb_build_object('codec', (array['hevc', 'av1', 'h264', 'flac'])[1 + g % 4], 'bitrate', 1000 + g * 3,
                     'source', case when g % 3 = 0 then 'bluray' else 'web' end),
  timestamptz '2026-10-01 12:00+00' - (g || ' hours')::interval,
  (((g * 7919) % 1000) + 200)::bigint * (array[24000000, 3500000, 600000, 9000])[lib],
  g % 3 = 0
from (
  select g, case when g % 20 < 9 then 1 when g % 20 < 15 then 2 when g % 20 < 19 then 3 else 4 end as lib
  from generate_series(1, 4800) g
) s;

create table inventory.drives (
  serial text primary key,
  model text,
  capacity_tb numeric,
  pool text,
  smart_ok boolean,
  last_scrub date
);
insert into inventory.drives values
  ('ZR5A1B2C', 'WD Red Plus', 12, 'tank', true, '2026-09-28'),
  ('ZR5A1B2D', 'WD Red Plus', 12, 'tank', true, '2026-09-28'),
  ('S4EVNF0M', 'Samsung 870 EVO', 2, 'fast', true, '2026-10-01'),
  ('WX12D80K', 'Seagate IronWolf', 8, 'backup', false, '2026-08-14');

create view public.recent_media as
  select m.id, m.title, l.name as library, m.added_at
  from media m join libraries l on l.id = m.library_id
  order by added_at desc limit 50;

create materialized view public.library_stats as
  select l.name, count(*) as items, sum(file_size) as bytes
  from media m join libraries l on l.id = m.library_id group by 1;

analyze;
