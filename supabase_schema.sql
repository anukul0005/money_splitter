-- Run this in Supabase SQL Editor (Project → SQL Editor → New Query)

create table if not exists groups (
  id          serial primary key,
  name        text not null,
  description text,
  emoji       text default '💰',
  is_historical boolean default false,
  created_at  timestamptz default now()
);

create table if not exists members (
  id        serial primary key,
  group_id  integer references groups(id) on delete cascade,
  name      text not null
);

create table if not exists expenses (
  id               serial primary key,
  group_id         integer references groups(id) on delete cascade,
  date             text,
  category         text,
  title            text,
  amount           numeric(12,2) not null,
  paid_by          text not null,
  participants     text,
  divider          integer not null default 2,
  individual_amount numeric(12,2),
  notes            text,
  created_at       timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_expenses_group on expenses(group_id);
create index if not exists idx_members_group  on members(group_id);
