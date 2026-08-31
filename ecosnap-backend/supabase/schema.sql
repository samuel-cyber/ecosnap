-- EcoSnap database schema
-- Run this once in Supabase: SQL Editor -> New Query -> paste -> Run

create extension if not exists "uuid-ossp";

create table users (
  id uuid primary key default uuid_generate_v4(),
  display_name text not null,
  neighborhood text,
  eco_points integer not null default 0,
  created_at timestamp with time zone default now()
);

create table reports (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) not null,
  image_url text not null,
  category text not null check (category in ('burning', 'blocked_drain')),
  lat double precision not null,
  lng double precision not null,
  neighborhood text,
  ai_label text,
  ai_confidence double precision,
  status text not null default 'pending' check (status in ('pending', 'verified', 'flagged')),
  points_awarded integer not null default 0,
  created_at timestamp with time zone default now()
);

create table redemptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) not null,
  points_spent integer not null,
  reward_type text not null,
  status text not null default 'fulfilled',
  created_at timestamp with time zone default now()
);

-- speeds up "find nearby reports" checks used later for duplicate detection
create index reports_lat_lng_idx on reports (lat, lng);
